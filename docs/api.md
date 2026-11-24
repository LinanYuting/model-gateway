# 轻量化模型调度网关 · 接口文档

> **唯一事实源**：`CONTRACT.md`。本文是它的派生读物，不是它的替代品；两者冲突时以契约为准，并请把冲突提给组长。
> **对应契约版本**：commit `d6d69e5` ｜ 内容指纹 `git hash-object CONTRACT.md` = `d2e493f9422be9b9f076b09f1850bb569266f9b2`
> **编写**：组员 4 ｜ **最后更新**：2026-11-24
> **实测环境**：Windows 11 / Node v20.20.2 / 网关 `PORT=3004` / `DB_PATH=./data/gateway-member4-3004.db` / 上游为 `test/mocks/mock-channel.mjs`（18901）

---

## 0. 怎么读这份文档

| 标记 | 含义 |
|---|---|
| **规格** | 直接取自 `CONTRACT.md` 的条款，附条款号。这是**约定**，不是现状 |
| **实测** | 2026-11-24 在本机按规格实际发起请求得到的原始输出 |
| ⚠️ | 实测与契约不一致，或契约未覆盖。**逐条汇总在 §8**，需组长裁决改代码还是改契约 |

一条硬规矩：本文里的每个「实测」块都是从终端直接粘出来的，未经修饰。哪怕结果是错的，也照贴——把错的写成对的最容易坑到联调周。

---

## 1. 通用约定

### 1.1 服务地址

| 用途 | 地址 |
|---|---|
| 对外推理 | `http://<host>:<PORT>/v1/chat/completions` |
| 管理接口 | `http://<host>:<PORT>/api/admin/...` |
| 看板数据 | `http://<host>:<PORT>/api/dashboard/...` |
| 健康检查 | `http://<host>:<PORT>/health` |
| 看板页面 | `http://<host>:<PORT>/` |

端口按契约 §0 固定分配：组长 3000 / 组员1 3001 / 组员2 3002 / 组员3 3003 / 组员4 3004。**不同端口连不同的数据库文件**，混用会互相覆盖 `call_logs` 和配额。

### 1.2 两套鉴权，别混

| 面 | 请求头 | 由谁校验 | 何时生效 |
|---|---|---|---|
| 业务推理 `/v1/*` | `Authorization: Bearer <token>` 或 `x-api-key: <token>` | `src/middleware/auth.js` | **始终**校验 |
| 管理接口 `/api/admin/*` | `x-admin-token: <ADMIN_TOKEN>` | `src/middleware/adminAuth.js` | 仅当环境变量 `ADMIN_TOKEN` 非空；为空时接口**完全开放** |

业务 token 用管理接口 `POST /api/admin/tokens` 签发，是 UUID；admin token 是运维在 `.env` 里自己设的字符串。两者不通用，混用一律 401。

> ⚠️ `ADMIN_TOKEN` 留空等于把管理接口暴露给同一网络内的任何人。仅限本机开发；对外演示必须设值。

### 1.3 时间与数值

- 时间：`created_at` / `updated_at` 为 SQLite `datetime('now')` 产出的 **UTC** 字符串，形如 `2026-11-24 05:30:51`（不带时区后缀，用前请自行按 UTC 解析）。`/health` 与 `/api/dashboard/summary` 的 `timestamp` 是 ISO 8601（`2026-11-24T05:32:57.231Z`），两处格式不同，前端勿共用解析函数。
- `quota_limit` / `token_used` 的单位是 **LLM token 数**，不是请求次数；`used_count` 才是请求次数。
- 看板展示时按 `M`（百万）换算。

### 1.4 错误响应结构

契约 §2 规定错误体统一为 `{ "error": { "type": "...", "message": "..." } }`。实测只有部分接口满足——`/v1` 的 401/500 与契约不符 ⚠️，详见 §8.1。

---

## 2. 对外推理接口

### 2.1 `POST /v1/chat/completions`（契约 §2）

**请求**：OpenAI Chat Completions 格式。

| 字段 | 必填 | 说明 |
|---|---|---|
| `messages` | 是 | 标准消息数组 |
| `model` | 建议 | 业务上用于路由提示；对接 mock 时**用它选故障模式**（见 §7） |
| `taskType` | 否 | `test` / `dev` 优先免费通道；其它值或省略按「正式业务」走 sponsored → aiping → free（契约 §5） |
| `specifiedChannel` | 否 | 显式指定通道，优先级最高；但若该通道被熔断则会被跳过 |

**响应头**（契约 §2：成功与失败都返回，鉴权失败除外）：

| Header | 含义 |
|---|---|
| `X-Channel` | 实际使用的通道 id |
| `X-Fallback` | 仅 fallback 时出现，值为 `true` |
| `X-Request-Id` | 调用 id，与 `call_logs.request_id`、`jev_decisions.request_id` 一致 |
| `X-Total-Tokens` / `X-Prompt-Tokens` / `X-Completion-Tokens` | 用量 |
| `X-Tokens-Per-Sec` / `X-Rounds` / `X-Cache-Hit` | 性能统计 |

#### 200 成功

**实测**（2026-11-24 05:31:44，`model=mock-ok`，走 free 通道）：

```
HTTP/1.1 200 OK
X-Channel: free
X-Request-Id: f0263912-b6f6-4396-85a3-3e75d2dfb848
X-Total-Tokens: 30
X-Prompt-Tokens: 10
X-Completion-Tokens: 20
X-Tokens-Per-Sec: 2857
X-Cache-Hit: 0
X-Rounds: 1
Content-Type: application/json; charset=utf-8

{"id":"mock-1795498304182","object":"chat.completion","created":1795498304,
 "model":"mock-ok","choices":[{"index":0,
 "message":{"role":"assistant","content":"mock reply"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}
```

八个头全部符合契约 ✅。`X-Tokens-Per-Sec` 由 `completion_tokens / 耗时` 现算，mock 响应太快所以数值偏大，真实上游会低得多。

#### 200 fallback

上游主通道失败、被免费通道救回时：`X-Channel` 变为实际救回的通道，并追加 `X-Fallback: true`。

**实测**（05:32:38，sponsored 指向不可达端口 18999，`taskType=formal`）：

```
HTTP/1.1 200 OK
X-Channel: free
X-Fallback: true
X-Total-Tokens: 30
X-Prompt-Tokens: 10
X-Completion-Tokens: 20
X-Tokens-Per-Sec: 1176
X-Cache-Hit: 0
X-Rounds: 1
```

⚠️ **缺 `X-Request-Id`**。契约 §2 要求该头「成功与失败都返回」，主路径设了，fallback 分支漏了（`src/routes/proxy.js:147-155`）。调用方若只从响应头取 request id，在 fallback 场景会取不到，只能去 500 那条日志里找。详见 §8.4。

#### 401 无令牌 / 令牌无效（契约 §2）

契约规定：`body.error.type = invalid_request_error`。

**实测**（05:30:46，不带 `Authorization`）：

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Content-Length: 40

{"error":"Missing authentication token"}
```

**实测**（带 `Bearer not-a-real-token`）：

```
HTTP/1.1 401 Unauthorized
Content-Length: 38

{"error":"Invalid authentication token"}
```

⚠️ 两处都**不符合契约**：`error` 是字符串而不是对象，没有 `type` 字段。客户端若按契约写 `err.error.type === 'invalid_request_error'` 会拿到 `undefined`。详见 §8.2。

> 这个偏差只存在于 `/v1`。管理接口的 401 是合规的（见 §3.1），两者不要一起改，否则会把对的改坏。

#### 403 配额超限（契约 §2，硬限）

语义：**超限直接拒绝，不再兜底走免费通道**。不设例外通道。

**实测**（`quota_limit=30`、`token_used=30`，05:31:52）：

```
HTTP/1.1 403 Forbidden
X-Request-Id: 3a71b509-6120-4a5c-b566-a81ea818f272
Content-Type: application/json; charset=utf-8

{"error":{"type":"quota_exceeded","message":"Project quota exceeded"}}
```

✅ 状态码、`error.type`、硬限行为均符合契约。

⚠️ 但只带 `X-Request-Id`，没有契约承诺的用量头（`X-Total-Tokens` 等）。详见 §8.4。

#### 429 免费通道限流（契约 §2）

语义：进程内滑动 60 秒窗口，**只作用于 `type === 'free'` 的通道**；被拒绝的请求**不计费、不转发**。主转发与 fallback 走 free 前都必须先过限流器。

**实测**（`FREE_CHANNEL_RPM=2`，连打三次，第 3 次被拒）：

```
HTTP/1.1 429 Too Many Requests
X-Request-Id: 37cabccd-6415-4382-bb71-018fb2e64df1
Retry-After: 60

{"error":{"type":"rate_limit_error","message":"Free channel rate limited, retry after 60s"}}
```

✅ 状态码、`error.type`、`Retry-After` 全部符合契约。`Retry-After` 是秒数，取窗口内最早那次请求还要等多久。

#### 500 所有候选通道失败（契约 §2）

契约要求：`body.error.type = server_error`，`message` 含**各候选**失败原因。

**实测**（05:30:56，free 通道上游 18900 未启动）：

```
HTTP/1.1 500 Internal Server Error
Content-Length: 194

{"error":"Internal Server Error",
 "message":"Free channel forward failed: connect ECONNREFUSED ::1:18900; connect ECONNREFUSED 127.0.0.1:18900",
 "requestId":"87423dee-68b9-4233-aca7-43a07bd7a8b8"}
```

⚠️ 三处不符合：
1. `error` 是字符串，没有 `type: server_error`；
2. `message` 只含**最后一个**候选通道的失败原因，不是「各候选」；
3. 响应头**一个 `X-` 都没设**，连 `X-Request-Id` 也没有（只在 body 的 `requestId` 里）。

详见 §8.3、§8.4。

#### 503 通道池为空（契约未覆盖）⚠️

当所有通道都被熔断（或全部禁用）时，路由返回 `null`，网关给出 503。

**实测**（05:31:19，free 连续失败 3 次后熔断）：

```
HTTP/1.1 503 Service Unavailable
Content-Length: 64

{"error":"Service Unavailable","message":"No available channel"}
```

⚠️ 契约 §2 的状态码表只有 401 / 403 / 429 / 500，**没有 503**。而 503 恰恰是「所有候选都不可用」的场景，与契约里「所有候选通道均失败 → 500」的描述直接冲突。对接方如果只按契约写了 4 个分支，遇到 503 会走进未处理分支。详见 §8.5。

另外 `specifiedChannel` 指向不存在的 id 时同样返回 503 `{"error":"Channel not found"}`（`proxy.js:68`），语义上更像是 400/404。

---

## 3. 管理接口 `/api/admin`（契约 §3）

全部受 §1.2 的 `x-admin-token` 守护。下文实测均带 `x-admin-token: demo-admin-token`（本机临时值）。

### 3.1 鉴权失败（契约 §6）

**实测**（不带 `x-admin-token`，05:32:26）：

```
HTTP/1.1 401 Unauthorized

{"error":{"type":"invalid_request_error","message":"Invalid or missing x-admin-token"}}
```

✅ 完全符合契约 §6 的结构。**与 `/v1` 的 401 形状不同**，这是当前实现的真实差异。

### 3.2 通道

#### `GET /api/admin/channels` → `Channel[]`

**实测**：

```json
[{"id":"free","name":"免费公共通道","type":"free","enabled":true,
  "config":{"endpoint":"http://localhost:18900/v1/chat/completions",
            "model":"gpt-3.5-turbo","apiKey":"","apiKeys":[]},
  "healthStatus":"healthy","lastProbeAt":"2026-11-24T05:32:26.607Z"},
 {"id":"sponsored","name":"赞助密钥通道","type":"sponsored","enabled":false,
  "config":{"endpoint":"","model":"","apiKey":"","apiKeys":[]},
  "healthStatus":"unconfigured","lastProbeAt":null},
 {"id":"aiping","name":"aiping 通道","type":"aiping","enabled":false,
  "config":{"endpoint":"","model":"","apiKey":"","apiKeys":[]},
  "healthStatus":"unconfigured","lastProbeAt":null}]
```

`healthStatus` 取值：`healthy` / `unhealthy` / `unconfigured`。`unconfigured` 表示配置为空、根本没探测过（aiping 端点本期留空即属此类，不算故障）。

#### `PUT /api/admin/channels/:id` → 更新后的 `Channel`

入参 `{ enabled?, config? }`，两者都可选，只传一个就只改一个。

```bash
curl -X PUT http://localhost:3004/api/admin/channels/free \
  -H "Content-Type: application/json" -H "x-admin-token: demo-admin-token" \
  -d '{"config":{"endpoint":"http://localhost:18901/v1/chat/completions","model":"mock-ok","apiKey":"","apiKeys":[]}}'
```

**实测**（已生效）：

```json
{"id":"free","name":"免费公共通道","type":"free","enabled":true,
 "config":{"endpoint":"http://localhost:18901/v1/chat/completions",
           "model":"mock-ok","apiKey":"","apiKeys":[]},
 "healthStatus":"unhealthy","lastProbeAt":"2026-11-24T05:30:37.022Z"}
```

⚠️ 注意 `healthStatus` 是**上一次探测的陈旧值**，改完配置不会立刻重探。判断新配置是否可用，要么等下一轮健康探测，要么主动发一次请求。

非法 config 返回 400 `{"error":"<原因>"}` —— 注意这里的 `error` 是字符串，与 §3.1 的对象结构不一致（见 §8.9）。

#### `DELETE /api/admin/channels/:id` → `{success:true}`

不存在返回 404 `{"error":"Channel not found"}`。

#### `GET /api/admin/circuit-breaker/:channelId`

契约 §3 规定出参为 `{ open, openUntil, failureCount }`。

**实测**（熔断打开时 / 已恢复时）：

```json
{"failureCount":3,"circuitOpenUntil":"2026-11-24T05:32:15.065Z","isOpen":true}
{"failureCount":0,"circuitOpenUntil":null,"isOpen":false}
```

⚠️ **三个字段名全部与契约不同**：契约 `open`/`openUntil`，实现 `isOpen`/`circuitOpenUntil`。只有 `failureCount` 对得上。前端按契约写会全取到 `undefined`。详见 §8.6。

### 3.3 令牌

#### `GET /api/admin/tokens` → `Token[]`

**实测**：

```json
[{"id":"65364673-1da5-4cfc-b342-04057d0fce34",
  "token":"78770f03-47e1-4ef3-b88a-4774f1fa9ffa",
  "project_name":"api-doc-probe","quota_limit":1000,
  "used_count":3,"token_used":90,
  "created_at":"2026-11-24 05:30:51","updated_at":"2026-11-24 05:32:38"}]
```

⚠️ **字段是下划线风格**（直接返回数据库行）。而下面 `POST /tokens` 返回的是**驼峰风格**。同一个资源两种命名，前端要么写两套映射，要么在网关层统一。详见 §8.7。

⚠️ 另外这个接口**明文返回 `token` 字段**。作为管理接口尚可接受（要能在页面上复制给项目方），但意味着看板一旦被越权访问，所有项目的令牌就全泄露了——这也是 §1.2 那条「`ADMIN_TOKEN` 必须设值」的实际原因。

#### `POST /api/admin/tokens` → 201 新 Token

入参 `{ projectName, quotaLimit? }`。`projectName` 缺失返回 400。

**实测**：

```json
{"id":"65364673-1da5-4cfc-b342-04057d0fce34",
 "token":"78770f03-47e1-4ef3-b88a-4774f1fa9ffa",
 "projectName":"api-doc-probe","quotaLimit":1000,
 "usedCount":0,"tokenUsed":0}
```

⚠️ 两点：
1. 字段是**驼峰**，与 `GET /tokens` 的下划线不一致（§8.7）；
2. 不传 `quotaLimit` 时**实际默认值是 1000**（`src/routes/admin.js:51` 的 `quotaLimit || 1000`），不是 `src/services/quota.js:4` 里那个 `100000000`。契约 §3 只写了 `quotaLimit?`，未规定默认值——**建议在契约里补上 1000**，否则两个默认值并存，迟早有人踩。详见 §8.8。

#### `POST /api/admin/tokens/:id/refresh` → 轮换后的 Token

换掉 `token` 字段的值，`id` 不变。旧令牌立即失效。

#### `PUT /api/admin/tokens/:id/quota` → 更新后的 Token

入参 `{ quotaLimit }`，必须 `> 0`，否则 400 `{"error":"quotaLimit must be positive"}`。

⚠️ 因为要求 `> 0`，**没法把配额设成 0**。而契约 §8 与组员2 的用例都提到「配额恰好为 0」这个边界——想造这个状态只能直接改库。详见 §8.8。

#### `DELETE /api/admin/tokens/:id` → `{success:true}`

不存在返回 404 `{"error":"Token not found"}`。

---

## 4. 看板数据接口 `/api/dashboard`（契约 §4）

这组接口**当前不受 `x-admin-token` 保护**（`src/server.js:33` 直接挂载，未套 `adminAuth`）。契约 §6 只要求 `/api/dashboard/jev` 受保护，该端点尚未实现，所以严格说不算违规——但一旦补上就必须同时加鉴权，否则契约 §6 立刻破。

| 方法 + 路径 | 出参 |
|---|---|
| `GET /summary` | `{ totalRequests, activeChannels, totalChannels, unresolvedAlerts, timestamp }` |
| `GET /channels` | 通道状态数组（同 `GET /api/admin/channels`） |
| `GET /logs?limit=N` | 调用日志，默认 20 条，倒序 |
| `GET /alerts?limit=N` | 告警列表，默认 20 条，倒序 |
| `GET /mock/summary` 等 | Mock 版，路径加 `/mock`，字段结构与真实版**完全一致** |
| `GET /jev?limit=N` | `{ data: JevDecision[] }` —— **未实现，实测 404** ⚠️ |

**实测 `GET /api/dashboard/summary`**：

```json
{"totalRequests":9,"activeChannels":1,"totalChannels":3,
 "unresolvedAlerts":1,"timestamp":"2026-11-24T05:32:57.231Z"}
```

⚠️ **`totalRequests` 会把 fallback 算成两次**。一次 fallback 调用在 `call_logs` 里留下两条记录（主通道 500 + free 200），`COUNT(*)` 直接等于日志条数，所以面板上的请求数会比真实调用数偏高。实测那次 fallback 之后 `totalRequests=9`，而实际发起的外部请求不到 9 次。契约 §1 写的是「`call_logs`：每次调用一条」，与实现不符（§8.10）。建议看板侧改为 `COUNT(DISTINCT request_id)`，或把这条约定写进契约。

**实测 `GET /api/dashboard/logs?limit=2`**（同一次 fallback 的两条记录，注意 `request_id` 相同）：

```json
[{"id":9,"request_id":"294cdab9-2637-4156-9403-d76fff79ae19","channel_id":"free",
  "status_code":200,"latency_ms":17,"is_fallback":1,"token_used":30,
  "rounds":1,"tokens_per_sec":1176,"cache_hit":0,
  "prompt_tokens":10,"completion_tokens":20,
  "created_at":"2026-11-24 05:32:38",
  "project_name":"api-doc-probe","channel_name":"免费公共通道"},
 {"id":8,"request_id":"294cdab9-2637-4156-9403-d76fff79ae19","channel_id":"sponsored",
  "status_code":500,"latency_ms":11,"is_fallback":0,
  "error_message":"Sponsored channel forward failed after trying all keys: connect ECONNREFUSED ::1:18999; ..."}]
```

**实测 `GET /api/dashboard/alerts?limit=5`**（配额告警，契约 §2 语义）：

```json
[{"id":3,"level":"warning",
  "message":"Token api-doc-probe 用量达到 100%（阈值 80%）",
  "resolved":0,"created_at":"2026-11-24 05:31:52"}]
```

✅ 告警消息含项目名与百分比，符契约 §2「消息含项目名与百分比」；同一令牌同一阈值只告一次，靠「跨越瞬间」判定（`src/services/quota.js:79` 的 `evalQuotaWarning`）。

**实测 `GET /api/dashboard/jev?limit=5`**：

```
HTTP/1.1 404 Not Found
Cannot GET /api/dashboard/jev
```

⚠️ 契约 §4 已定义（Phase 2 新增，组员3 对接），实现尚未提供。看板此区域只能先走 mock 数据源。

---

## 5. 数据结构（契约 §1 摘要）

以 `src/db/schema.sql` 为准，这里只列文档里用到的字段。

**`tokens`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT | UUID，主键 |
| `token` | TEXT | 业务令牌，UUID，明文存储 |
| `project_name` | TEXT | 项目名，出现在告警消息里 |
| `quota_limit` | INTEGER | token 数上限，`token_used >= quota_limit` 即 403 |
| `used_count` | INTEGER | 请求**次数** |
| `token_used` | INTEGER | 累计消耗 **token 数** |
| `created_at` / `updated_at` | TEXT | UTC |

**`call_logs`**：每次调用（含 fallback 的每一段）一条，含 `request_id`、`channel_id`、`status_code`、`latency_ms`、`is_fallback`、`token_used`、`rounds`、`tokens_per_sec`、`cache_hit`、`prompt_tokens`、`completion_tokens`、`error_message`。

**`alerts`**：`level ∈ {info, warning, critical}`，`resolved` 为 0/1。

**`jev_decisions`**：`{ request_id, input_summary, confidence REAL, decision, created_at }`，`decision ∈ {free, sponsored, aiping, rule-default}`。`confidence < 0.6` 时网关必须忽略 Jev 结论、回退基础规则并记 `decision="rule-default"`（契约 §1）。

---

## 6. 契约版本锚点

| 项 | 值 |
|---|---|
| 契约文件 | `CONTRACT.md` |
| 对应 commit | `d6d69e5`（= `upstream/main` HEAD，2026-11-24 核对） |
| 内容指纹 | `d2e493f9422be9b9f076b09f1850bb569266f9b2` |

**为什么两个都记**：commit 号会随其它文件的提交而漂移，`CONTRACT.md` 本身没变也会换号；内容指纹只随契约内容变。复核时先跑：

```bash
git hash-object CONTRACT.md
# 应输出 d2e493f9422be9b9f076b09f1850bb569266f9b2
```

对不上就说明契约已被修改，本文档随即过期，需要重新核对 §2–§4。

---

## 7. mock 上游用法（契约 §7）

故障注入的**唯一合法来源**，禁止拿真实上游做限流/熔断测试。

```bash
node test/mocks/mock-channel.mjs   # 默认 18901
```

行为由请求体的 `model` 字段决定：

| `model` | 行为 |
|---|---|
| `mock-ok` | 200，OpenAI 风格；`stream:true` 返回 SSE 两块；可用请求头 `x-mock-latency-ms` 加延迟 |
| `mock-429` | 429 `rate_limit_error` |
| `mock-5xx` | 500 `server_error` |
| `mock-timeout` | 挂起 65s，用于触发客户端 30s 超时 |
| `GET /v1/models` | 恒 200 |

把某个通道的 `config.endpoint` 指到 `http://localhost:18901/v1/chat/completions`，就能在**不改业务代码**的前提下重放任意故障。本文 §2 的所有失败样例都是这么造出来的。

---

## 8. 实测偏差清单 ⚠️

2026-11-24 在本机实测，共 11 项场景，**5 项符合契约、6 项不符合**。全部按「契约怎么说 / 实际怎么做 / 影响」列出，供组长裁决。**本文只记录，未改动任何 `src/` 代码**——改行为要先改契约，这是 CONTRIBUTING 的硬性约定。

### 8.1 汇总表

| # | 位置 | 契约要求 | 实际 | 影响面 |
|---|---|---|---|---|
| 8.2 | `/v1` 401 | `error.type = invalid_request_error` | `{"error":"字符串"}`，无 `type` | 客户端错误分支取不到 type |
| 8.3 | `/v1` 500 | `error.type = server_error`，含各候选原因 | 字符串，仅最后一条原因 | 同上 |
| 8.4 | `/v1` 失败与 fallback 响应头 | 成功与失败都返回全套 `X-` 头 | 403/429 只有部分；500 一个都没有；fallback 缺 `X-Request-Id` | 无法从响应头串联 request id |
| 8.5 | 通道全熔断 | 契约未定义（表里只有 500） | 503 `Service Unavailable` | 对接方未处理分支 |
| 8.6 | `GET /circuit-breaker/:id` | `{open, openUntil, failureCount}` | `{isOpen, circuitOpenUntil, failureCount}` | 前端拿不到值 |
| 8.7 | `GET/POST /tokens` | — | 一个下划线、一个驼峰 | 前端两套映射 |
| 8.8 | 配额默认值与 0 边界 | `quotaLimit?` 未定义默认值 | 实际 1000；且无法设 0 | 边界用例只能改库 |
| 8.9 | admin 400 | 契约 §3 只写「非法 config 返回 400 `{error}`」 | `error` 为字符串 | 结构不统一 |
| 8.10 | `call_logs` 条数 | 「每次调用一条」 | fallback 一次写两条，`totalRequests` 虚高 | 看板统计失真 |
| 8.11 | `/api/dashboard/jev` | 契约 §4 已定义 | 404 | 组员3 只能用 mock |

### 8.2 – 8.5：`/v1` 的错误面

**建议一并修的是 8.2 / 8.3**，改成与 admin 接口一致的对象结构即可，改动只在 `auth.js` 与 `proxy.js` 的两处 `res.json`。但要注意这会**同时改变组员2 已有断言的行为**，需要他们同步更新用例，所以必须走契约变更流程、由组长统一安排，不能由组员4 就地改。

**8.4 建议单独看**：契约那句「响应头（成功与失败都返回，除鉴权失败外）」本身也要收紧——失败时 `X-Total-Tokens` 这类用量信息**客观上不存在**，硬要求返回只能返回 0 或空，价值不大。更务实的写法是「`X-Request-Id` 成功与失败都返回；用量头仅在成功时返回」。这条建议改契约而不是改代码。

**8.5（503）** 需要组长定调：是把它写进契约（推荐，因为语义清晰：池子空了 ≠ 都试过一遍都失败），还是让实现改成 500。

### 8.6 – 8.9：管理接口的形状

**8.6 字段名**优先级最高——组员3 的熔断状态展示直接依赖它，按契约写必然全空。二选一：改实现迁就契约（推荐，契约已冻结），或在契约里把字段名改成实现的写法并通知组员3。

**8.7 驼峰/下划线**在网关层加一个序列化函数就能统一，建议统一为契约里的写法；但 `GET /tokens` 直接回 DB 行，改动会波及前端，需组员3 确认。

**8.8 两个默认值**（1000 与 100000000）是实打实的隐患，建议契约补一句「`quotaLimit` 省略时默认 1000」，代码里删掉 `quota.js` 那个用不上的默认。

### 8.10 `totalRequests` 虚高

组员3 的看板首页数字会偏大。两个修法：看板侧改成 `COUNT(DISTINCT request_id)`（不动后端，推荐），或契约把「每次调用一条」改成「每个候选通道一条」。**这个必须尽快定**，否则验收时数据对不上会被当成看板 bug。

### 8.11 `/dashboard/jev` 缺失

属组员3 的接口，本文只做记录。看板该区域在端点交付前只能用 `useMock`。

---

## 9. 本文档的已知局限

1. **上游是 mock，不是 OFM**。§2 的成功样例（`X-Tokens-Per-Sec: 2857`）来自 `mock-ok` 的瞬时响应，真实 OFM 走 18900 时该数值会显著更低，且可能出现 `cache_read` 相关的 `X-Cache-Hit=1`。本机未安装 OFM，此段未实测。
2. **流式（`stream: true`）未覆盖**。契约 §2 只规定了非流式语义，流式转发由组员1 的 Sponsorship 通道负责，本文未涉及。
3. **组长 3000 环境未实测**。本文所有实测来自本机 3004 + mock。任务书 4.4 要求连组长 3000 环境跑一遍，需等组长环境可访问后补测，届时 §2 的成功样例应以真实上游输出替换。
4. **契约版本可能已过期**。复核方法见 §6。
