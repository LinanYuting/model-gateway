# 接口与行为规范（CONTRACT）

> 状态：**已冻结**。改动本文件的 PR 必须同时 @ 组长与受影响模块的组员，评审通过后合入。
> 所有人对契约开发、对 mock 测试，真实数据接入统一放到阶段 3 联调。

## 0. 环境变量（见 `.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 网关端口。**固定分配**：组长 3000 / 组员1 3001 / 组员2 3002 / 组员3 3003 / 组员4 3004 |
| `DB_PATH` | `./data/gateway.db` | SQLite 文件。每人用自己机器上的独立文件，禁止共享、禁止提交 |
| `OFM_ENDPOINT` | `http://localhost:18900/v1/chat/completions` | 免费通道上游（OFM 独立服务） |
| `MOCK_PORT` | 18901 | mock channel 端口 |
| `USE_JEV` | `false` | Jev 语义路由总开关（组员1 接入前保持 false，路由走基础规则） |
| `ADMIN_TOKEN` | 空 | **已启用**：非空时守护所有 `/api/admin/*`（见 §6）；空=admin 接口开放（仅限本机开发） |
| `FREE_CHANNEL_RPM` | 30 | 免费通道每分钟请求上限（进程内滑动窗口，保护第三方上游，见 §2） |
| `QUOTA_WARN_PERCENT` | 80 | 配额使用率达到该百分比时写入一条 warning 告警（仅在跨越阈值那次请求触发，不重复刷） |

## 1. 数据表（`src/db/schema.sql` 为准，本节为摘要）

- `channels`：id 固定 `free` / `sponsored` / `aiping`；`config_json` 结构统一为
  `{ endpoint, model, apiKey, apiKeys: string[] }`（aiping 真实端点暂缓，先按插件接口对接 mock）
  - `endpoint` 允许两种写法：base 地址（如 `https://aiping.cn/api/v1`）或完整地址（`.../chat/completions`），
    插件自行补齐，调用方不需要关心填哪一种；健康检查走 `{base}/models`
  - 缺 `endpoint` 或没有任何有效 key 时视为**未配置**（不是故障）：`healthCheck()` 返回 false、
    `health_status` 保持 `unconfigured`，后台探测不写告警（任务 1.2）
- `tokens`：`quota_limit` 单位为 LLM token 数（看板以 M 展示）；`used_count` 为请求次数
- `call_logs`：每次调用一条，含 `is_fallback`、`cache_hit`、`tokens_per_sec` 等统计列
- `alerts`：`level ∈ {info, warning, critical}`，`resolved` 0/1
- `jev_decisions`：`{ request_id, input_summary, confidence REAL, decision TEXT, created_at }`
  - `decision` 取值：`"free" | "sponsored" | "aiping" | "rule-default"`
  - `confidence < 0.6` 时网关必须忽略 Jev 结果、回退基础规则，并记 `decision="rule-default"`

## 2. 对外推理接口 `POST /v1/chat/completions`

请求：OpenAI Chat Completions 格式。`Authorization: Bearer <token>` 或 `x-api-key` 二选一。

响应头（成功与失败都返回，除鉴权失败外）：

| Header | 含义 |
|---|---|
| `X-Channel` | 实际使用的通道 id；fallback 时追加 `X-Fallback: true` |
| `X-Request-Id` | 本次调用 id（与 `call_logs.request_id` 一致，也是 `jev_decisions.request_id`） |
| `X-Total-Tokens` / `X-Prompt-Tokens` / `X-Completion-Tokens` | 用量 |
| `X-Tokens-Per-Sec` / `X-Rounds` / `X-Cache-Hit` | 性能统计 |

状态码约定：

| 码 | 场景 | body.error.type |
|---|---|---|
| 401 | 无/无效令牌 | `invalid_request_error` |
| 403 | 配额超限（**硬限**：超限直接拒绝，不再兜底走免费通道；响应带 `X-RateLimit-Remaining: 0` 之外的用量头不要求） | `quota_exceeded` |
| 429 | 免费通道内部限流：目标通道为 free 且 `FREE_CHANNEL_RPM` 窗口已满（含作为 fallback 使用时） | `rate_limit_error` |
| 500 | 所有候选通道均失败 | `server_error`，`message` 含各候选失败原因 |

免费通道限流语义：进程内滑动 60s 窗口，仅作用于 `type === 'free'` 的通道；被限流拒绝的请求**不计费、不转发**。
主转发与故障 fallback 走 free 通道前都必须先过限流器；fallback 被限流时按原失败通道报 500。

配额告警语义：请求成功后累计用量，若本次增量使 `token_used / quota_limit` **跨越** `QUOTA_WARN_PERCENT`，
向 `alerts` 写入一条 `warning`（消息含项目名与百分比）；同一令牌每个阈值只告一次（以跨越瞬间判定）。

### 流式响应（请求体 `stream: true`，Phase 2 新增 / 任务 1.1b）

请求体带 `stream: true` 时，响应改为 `Content-Type: text/event-stream; charset=utf-8`，**上游分块逐块透传**，不收齐整包再发。

- 响应头：`X-Channel`、`X-Request-Id` 照旧；fallback 时追加 `X-Fallback: true`。
  `X-Total-Tokens` 等用量头**不保证存在**（用量要到流末尾才知道），用量照常写入 `call_logs`。
- 首字节发出前失败（上游连不上、所有 key 均 429/5xx、首包前中断）：仍按下表回 500 JSON，并可照旧兜底到 free 通道。
- 首字节发出后失败（上游中途断流）：HTTP 状态仍是 200，服务端补一个
  `data: {"error":{"type":"upstream_stream_error","message":"..."}}` 事件，再补 `data: [DONE]` 后关闭连接；
  `call_logs.status_code` 记 500。
- 客户端中途断开：立刻停止向上游读取并销毁上游连接，`call_logs.status_code` 记 **499**。
- 通道未实现流式（当前 free / aiping）：整包转发后降级为"单块 SSE"——1 个 `data: <完整响应 JSON>` 事件 + `data: [DONE]`，协议不变，前端无需分支。

## 3. 管理接口 `/api/admin`（鉴权见 §6：设置 `ADMIN_TOKEN` 后必须带 `x-admin-token`）

| 方法+路径 | 入参 | 出参 |
|---|---|---|
| `GET /channels` | — | `Channel[]`（config 已解析） |
| `PUT /channels/:id` | `{ enabled?, config? }` | 更新后的 `Channel`；非法 config 返回 400 `{error}` |
| `GET /tokens` | — | `Token[]` |
| `POST /tokens` | `{ projectName, quotaLimit? }` | 201 新 Token |
| `POST /tokens/:id/refresh` | — | 轮换后的 Token |
| `PUT /tokens/:id/quota` | `{ quotaLimit > 0 }` | 更新后的 Token |
| `DELETE /tokens/:id` | — | `{success:true}`；不存在 404 |
| `DELETE /channels/:id` | — | `{success:true}`；不存在 404 |
| `GET /circuit-breaker/:channelId` | — | `{ open, openUntil, failureCount }` |
| `PUT /alerts/:id/resolve` | — | 将该告警 `resolved` 置 1，返回更新后的 `Alert`；不存在 404 `{error}`；已处理的再次调用幂等返回 200（Phase 2 新增，供看板“已处理”操作，组员3） |

## 4. 看板数据接口 `/api/dashboard`

`GET /summary` `{ totalRequests, activeChannels, totalChannels, unresolvedAlerts, timestamp }`
`GET /channels` 通道状态数组；`GET /logs?limit=N`；`GET /alerts?limit=N`
Mock 版：路径前缀 `/api/dashboard/mock/...`，字段结构与真实版**完全一致**（前端可切 `useMock`）。
Phase 2 新增（组员3 对接口，组员1/2 不涉及）：
`GET /api/dashboard/jev?limit=N` → `{ data: JevDecision[] }`，字段同 §1 `jev_decisions`。

## 5. 渠道插件接口（`src/channels/ChannelPlugin.js`）

所有通道插件必须实现：

```js
async forward(payload) -> { success, data, latency, channel }  // 失败 throw Error
async healthCheck()     -> boolean                              // 必须带 Authorization（若配置了 key）
toJSON()                // { id, type, name, enabled, config, healthStatus, ... }
```

可选方法（Phase 2 起由 sponsored 实现，free / aiping 暂未实现）：

```js
async forwardStream(payload) -> { success, stream, latency, channel }  // stream 为 Node Readable，失败 throw Error
```

`forwardStream` 负责向上游发起 `stream: true` 请求（带 `Accept: text/event-stream`）并返回上游可读流，
路由层只做原样透传、不做整包缓冲。未实现该方法的通道承接流式请求时，由路由层降级为单块 SSE（见 §2）。

熔断语义：连续失败 ≥ 3 次 → 通道临时移出候选池，冷却 60s 后自动重试恢复；
路由优先级：请求显式指定 > Jev（开启且置信度达标）> 基础规则（测试任务→free，正式业务→sponsored/aiping）。

## 6. Admin 鉴权（已实现：`src/middleware/adminAuth.js`）

- 环境变量 `ADMIN_TOKEN`；未设置时 admin 接口保持开放（兼容现有 Demo/本机开发）
- 设置后：所有 `/api/admin/*` 与未来的 `/api/dashboard/jev` 必须带 `x-admin-token: <ADMIN_TOKEN>`，否则 401 `{error:{type:'invalid_request_error'}}`
- 看板前端在 401 时弹出 token 输入框并存 localStorage（组员3 按此实现）

## 7. mock channel 行为规范（`test/mocks/mock-channel.mjs`）

`POST /v1/chat/completions`，行为由请求 `model` 字段控制：

| model | 行为 |
|---|---|
| `mock-ok` | 200 OpenAI 风格；`stream:true` 返回 SSE；请求头 `x-mock-latency-ms` 可加延迟 |
| `mock-429` | 429 `rate_limit_error` |
| `mock-5xx` | 500 `server_error` |
| `mock-timeout` | 挂起 65s 不响应（用于触发客户端 30s 超时） |

`GET /v1/models` 恒 200。组员2 的熔断/降级用例、组员1 的插件自测都以此为唯一故障源，
禁止依赖真实上游限流做测试。

## 8. 测试约定

- 框架：node:test（`npm test` → `node --test src/**/*.test.js`），测试文件与被测文件同目录 `*.test.js`
- 集成测试用独立 `DB_PATH=:memory:` 或临时文件 + 独立端口，禁止动 `data/gateway.db`
- 断言必须覆盖边界（空列表、配额恰好为 0、confidence=0.6 阈值）；**禁止删/跳测试凑绿**
