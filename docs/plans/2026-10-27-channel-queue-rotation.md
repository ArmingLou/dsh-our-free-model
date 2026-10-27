# 全账号渠道排队换号

用户已确认范围：全部 EAC router 账号渠道；只认明确排队响应；同渠道、同模型的已启用账号间切换；保留原有认证和额度处理；输出后不重放；使用本地夹具，不调用真实渠道。

覆盖 LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax、Gemini、ZCode，以及启用时的 OpenCode 账号接入。

决定：复用 #663 的 Qoder 专用处理；其余适配器共用请求级的重试与账号选择。接入适配器的注册入口，覆盖直接 stream 与 prepareCall 返回的 stream。用 AsyncLocalStorage 隔离每次请求的凭据、已试账号和重试预算，不改共享默认账号。

明确排队信号为结构化 isQueued=true 或 queued/model_queued 错误类型。HTTP 状态码、Retry-After、普通繁忙文本本身不代表排队。各协议解析器识别后抛出同一种排队错误；原鉴权、配额、地区等错误继续走原逻辑。

默认沿用 Qoder 的三次排队或约 20 秒后尝试换号、有限总次数与等待预算。账号池为空时继续可取消的等待；排队不写限流标记。复用现有账号刷新入口，刷新当前请求实际使用的账号。

不新增 UI、用户配置或依赖，不改变其他渠道自己的认证、端点回退和额度换号策略。未知上游排队报文不猜测支持。

验证覆盖：HTTP/SSE 排队；所有注册入口；同渠道/模型选择；停用及受限账号；无备用账号；并发请求隔离；中止、超时、输出后不重放；原认证/额度错误；插件及独立端生成包。

验证结果：`TMPDIR=/private/tmp npm run test:contributor` 99/99 通过；`npm run typecheck`、`npm run typecheck:standalone`、三个生成产物的一致性检查及 `git diff --check` 通过。未调用真实渠道或消耗额度。

额外运行 vendored TypeScript 全量检查，现有宿主消息契约及依赖类型仍有错误；与基线对照未新增错误，并修正了 #663 的可选凭据闭包类型问题。`npm run test:release` 尚未通过：本分支的新产物需要通过受信发布工作流重新生成签名清单与来源 revision，当前没有发布或安装到本机。
