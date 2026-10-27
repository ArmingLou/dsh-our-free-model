import { AsyncLocalStorage } from 'node:async_hooks'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
import type { IdentitySlot } from './opencode-auth.js'
import { ModelQueuedError, QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS } from './model-queue.js'
import { reportLedgerAccount } from './token-ledger.js'

interface QueueOptions {
  accountPool?: AccountPool
  resolveCredential?: (model?: string) => Promise<unknown>
  refresh?: (accountId?: string) => Promise<unknown>
  currentAccountId?: () => string | undefined
  identitySlots?: (model?: string) => Promise<readonly IdentitySlot[]>
}

type Account = NonNullable<Awaited<ReturnType<AccountPool['getAvailableAccount']>>>
interface QueueRequest {
  owner: QueueOptions
  provider: string
  model: string
  tried: Set<string>
  account?: Account
  slot?: IdentitySlot
}

const requests = new AsyncLocalStorage<QueueRequest>()

/** OpenCode 的槽在适配器内部选择，按实际发送的槽回报，不能猜账号池默认值。 */
export function reportQueueSlot(slot: IdentitySlot): void {
  const request = requests.getStore()
  if (request?.provider !== 'opencode') return
  request.slot = slot
  request.tried.add(slot.id)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 凭据覆盖只活在本次迭代的异步上下文，绝不改适配器的共享默认账号。 */
export function withQueueAccountRotation<O extends QueueOptions, A extends object>(
  provider: string,
  options: O,
  create: (options: O) => A,
  timing: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): A {
  const now = timing.now ?? Date.now
  const sleep = timing.sleep ?? wait
  const active = () => {
    const request = requests.getStore()
    return request?.owner === options ? request : undefined
  }
  const remember = (request: QueueRequest, account: Account) => {
    request.account = account
    request.tried.add(account.entry.id)
    reportLedgerAccount(provider, account.entry.id)
  }
  const scoped: QueueOptions = { ...options }
  const pool = options.accountPool
  if (pool !== undefined) {
    scoped.accountPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'getAvailableAccount') {
          return async (id: string, model: string, excluded?: ReadonlySet<string>) => {
            const request = active()
            const relevant = request !== undefined && id === provider && model === request.model
            const skipped = relevant ? new Set([...request.tried, ...excluded ?? []]) : excluded
            const account = await target.getAvailableAccount(id, model, skipped)
            if (account !== null && relevant) remember(request, account)
            return account
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    if (options.resolveCredential !== undefined) {
      scoped.resolveCredential = async model => {
        const request = active()
        if (request?.account !== undefined) {
          return pool.resolveCredentialForAccount(request.account.entry.id)
        }
        const credential = await options.resolveCredential!(model)
        if (request !== undefined && credential !== null && typeof credential === 'object') {
          const field = provider === 'zcode' ? 'zcode_jwt' : 'access_token'
          const token = (credential as Record<string, unknown>)[field]
          if (typeof token === 'string' && token.length > 0) {
            const id = await pool.findAccountIdByIdentityField(provider, field, token).catch(() => '')
            const entry = pool.listAccountsByProvider(provider).find(account => account.id === id && account.enabled)
            if (entry !== undefined) remember(request, { entry, credential: credential as Account['credential'] })
          }
        }
        return credential
      }
    }
    if (options.refresh !== undefined) {
      scoped.refresh = accountId => options.refresh!(accountId ?? active()?.account?.entry.id)
    }
    if (options.currentAccountId !== undefined) {
      scoped.currentAccountId = () => active()?.account?.entry.id ?? options.currentAccountId!()
    }
  }
  if (options.identitySlots !== undefined) {
    scoped.identitySlots = async () => {
      const request = active()
      const slots = await options.identitySlots!(request?.model)
      if (request?.slot === undefined) return slots
      const current = slots.find(slot => slot.id === request.slot!.id)
      return [...current === undefined ? [] : [current], ...slots.filter(slot => !request.tried.has(slot.id))]
    }
  }
  const adapter = create(scoped as O)

  const stream = async function* (input: unknown, open: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    const { model, signal } = input as { model: string; signal?: AbortSignal }
    const request: QueueRequest = { owner: options, provider, model, tried: new Set() }
    const deadline = now() + 30 * 60_000
    let attempts = 0, queued = 0, since: number | undefined
    let delivered = false
    for (;;) {
      signal?.throwIfAborted()
      if (now() >= deadline) throw new LlmError(`${provider}: 排队等待超时`, 'QUEUE')
      const iterator = open()[Symbol.asyncIterator]()
      try {
        for (;;) {
          const step = await requests.run(request, () => iterator.next())
          if (step.done) return
          delivered = true
          yield step.value
        }
      } catch (error) {
        if (!(error instanceof ModelQueuedError) || delivered) throw error
        signal?.throwIfAborted()
        if (++attempts > QUEUE_MAX_ATTEMPTS || now() >= deadline) {
          throw new LlmError(`${provider}: 排队重试次数或等待时间已用尽`, 'QUEUE')
        }
        queued += 1
        since ??= now()
        if (queued >= 3 || now() - since >= 20_000) {
          queued = 0
          since = now()
          if (pool !== undefined) {
            const next = await pool.getAvailableAccount(provider, model, request.tried)
            if (next !== null) {
              remember(request, next)
              continue
            }
          } else if (options.identitySlots !== undefined && request.slot?.kind === 'account') {
            const next = (await options.identitySlots(model)).find(slot => slot.kind === 'account' && !request.tried.has(slot.id))
            if (next !== undefined) {
              request.slot = next
              request.tried.add(next.id)
              continue
            }
          }
        }
        await sleep(Math.min(Math.max(100, error.retryAfterMs ?? 1_000), QUEUE_MAX_DELAY_MS, deadline - now()), signal)
      } finally {
        await requests.run(request, () => iterator.return?.())
      }
    }
  }

  return new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'stream' && typeof value === 'function') {
        return (input: unknown) => stream(input, () => value.call(target, input))
      }
      if (prop === 'prepareCall' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const call = await value.apply(target, args)
          return { ...call, stream: (input: unknown) => stream(input, () => call.stream(input)) }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
