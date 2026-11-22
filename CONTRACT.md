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

## 1. 数据表（`src/db/schema.sql` 为准，本节为摘要）

- `channels`：id 固定 `free` / `sponsored` / `aiping`；`config_json` 结构统一为
  `{ endpoint, model, apiKey, apiKeys: string[] }`（aiping 端点暂留空，插件接口先行）
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
| 403 | 配额超限 | `quota_exceeded` |
| 429 | 免费通道内部限流 | `rate_limit_error` |
| 500 | 所有候选通道均失败 | `server_error`，`message` 含各候选失败原因 |

## 3. 管理接口 `/api/admin`（Phase 1 无鉴权，Phase 2 统一加 `x-admin-token`，见 §6）

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

熔断语义：连续失败 ≥ 3 次 → 通道临时移出候选池，冷却 60s 后自动重试恢复；
路由优先级：请求显式指定 > Jev（开启且置信度达标）> 基础规则（测试任务→free，正式业务→sponsored/aiping）。

## 6. Admin 鉴权（Phase 2 引入，前后端先按此契约开发）

- 环境变量 `ADMIN_TOKEN`；未设置时 admin 接口保持开放（兼容现有 Demo）
- 设置后：所有 `/api/admin/*` 与 `/api/dashboard/jev` 必须带 `x-admin-token: <ADMIN_TOKEN>`，否则 401
- 看板前端在 401 时弹出 token 输入框并存 localStorage

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
