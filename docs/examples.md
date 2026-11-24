# 轻量化模型调度网关 · 对接示例

> **对应契约版本**：`CONTRACT.md` @ `d6d69e5`（指纹 `d2e493f9`）
> **编写**：组员 4 ｜ **实测日期**：2026-11-24
> **实测环境**：Windows 11 / Node v20.20.2 / 网关 `PORT=3004` / 上游 `mock-channel`（18901）
> **配套读物**：接口细节见 `docs/api.md`；风险见 `docs/risks.md`；起服务见 `docs/deployment.md`

---

## 0. 先说清楚这份示例的适用范围

本文所有输出都是从终端原样粘的，带本机时间戳。但有一个必须交代的前提：

> ⚠️ **任务书 4.4 要求「连接组长 3000 环境实测」，本次未做到。**
> 组长的 3000 环境当前不可达（不同机器），本文实测全部来自**本机 3004 + mock 上游**。
> 两者在**接口形状上一致**（同一个代码基线 `d6d69e5`），差异在于：
> - 令牌不同（`TOKEN` 必须换成组长环境签发的）；
> - 上游不同（真实 OFM 的 `X-Tokens-Per-Sec` 会显著低于 mock 的 3333）；
> - 端口不同（3000 vs 3004）。
>
> 拿到 3000 环境访问权限后，把本文 §2–§4 的命令换掉 `GATEWAY_URL` 与 `TOKEN` 重跑一遍，用新输出替换即可，命令本身不用改。

另外：文中出现的令牌 `0c7ba4a9-7cb8-415f-bc20-3534b4570cc1` 是**本机临时令牌**，已随环境重建失效，直接拿去用会 401。

---

## 1. 五分钟接通

```bash
# ① 起网关（另开一个终端；OFM 没装也行，用 mock 顶上）
cd model-gateway
node src/server.js                      # 监听 .env 里的 PORT，本机为 3004
# 上游若要用 mock，再开一个终端：
node test/mocks/mock-channel.mjs        # 18901

# ② 确认活着
curl -s http://localhost:3004/health

# ③ 签一个业务令牌（需要 ADMIN_TOKEN，本机演示值为 demo-admin-token）
curl -s -X POST http://localhost:3004/api/admin/tokens \
  -H "Content-Type: application/json" \
  -H "x-admin-token: demo-admin-token" \
  -d '{"projectName":"demo-client","quotaLimit":500000}'

# ④ 用返回的 token 调一次
export TOKEN=<上一步返回的 token 字段>
curl -s -X POST http://localhost:3004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"mock-ok","taskType":"test","messages":[{"role":"user","content":"你好"}]}'
```

三步的量词别搞混：**`ADMIN_TOKEN` 管管理接口，`token` 管推理接口，两者不通用**。

---

## 2. curl 示例（逐条实测）

### 2.1 健康检查

```bash
curl -s -w "\n[%{time_total}s | HTTP %{http_code}]\n" http://localhost:3004/health
```

**实测输出**（2026-11-24 13:34:32）：

```
{"status":"ok","timestamp":"2026-11-24T05:34:32.260Z"}
[0.003166s | HTTP 200]
```

`timestamp` 是 UTC。这个接口不需要任何鉴权，适合做存活探针。

### 2.2 签发业务令牌

```bash
curl -s -X POST http://localhost:3004/api/admin/tokens \
  -H "Content-Type: application/json" \
  -H "x-admin-token: demo-admin-token" \
  -d '{"projectName":"demo-client","quotaLimit":500000}' \
  -w "\n[%{time_total}s | HTTP %{http_code}]\n"
```

**实测输出**（13:34:33）：

```
{"id":"870c03f4-5b29-4ac4-b273-965a22208774","token":"0c7ba4a9-7cb8-415f-bc20-3534b4570cc1","projectName":"demo-client","quotaLimit":500000,"usedCount":0,"tokenUsed":0}
[0.003840s | HTTP 201]
```

注意 `quotaLimit` 单位是 **token 数**，不是请求次数。50 万 token 大约相当于几百到上千次普通对话。不传这个字段时实际默认 **1000**（很紧，适合做超限演示，不适合真用）。

### 2.3 推理请求（成功）

```bash
curl -s -i -X POST http://localhost:3004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"mock-ok","messages":[{"role":"user","content":"用一句话说明什么是模型调度网关"}]}'
```

**实测输出**（13:34:36）：

```
HTTP/1.1 200 OK
X-Channel: free
X-Request-Id: 4a2054be-187f-40bb-900b-7e568caddfb2
X-Total-Tokens: 30
X-Prompt-Tokens: 10
X-Completion-Tokens: 20
X-Tokens-Per-Sec: 3333
X-Cache-Hit: 0
X-Rounds: 1
Content-Type: application/json; charset=utf-8
Content-Length: 264

{"id":"mock-1795498476630","object":"chat.completion","created":1795498476,"model":"mock-ok","choices":[{"index":0,"message":{"role":"assistant","content":"mock reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}
```

**这几个头是对接时真正要用的**：

| 头 | 用途 |
|---|---|
| `X-Channel` | 知道这次走了哪条通道。排障时第一个看它 |
| `X-Request-Id` | **保存它**。出问题时拿它去 `/api/dashboard/logs` 精确定位这一次调用 |
| `X-Total-Tokens` | 计费依据，也用来核对配额 |
| `X-Tokens-Per-Sec` | mock 环境 3333 是假象（上游瞬间返回），真实 OFM 通常几十到几百 |
| `X-Fallback` | 出现即说明主通道挂了、被免费通道救回，值得关注 |

### 2.4 用 `X-Request-Id` 回查日志

这一步是对接方**最该养成习惯**的动作：拿到 id 立刻能定位。

```bash
curl -s "http://localhost:3004/api/dashboard/logs?limit=1"
```

**实测输出**（13:34:40）：

```json
{
 "request_id": "4a2054be-187f-40bb-900b-7e568caddfb2",
 "channel_id": "free",
 "status_code": 200,
 "is_fallback": 0,
 "token_used": 30,
 "project_name": "demo-client",
 "created_at": "2026-11-24 05:34:36"
}
```

`request_id` 与 §2.3 响应头里的 `X-Request-Id` **完全一致**，`token_used` 与 `X-Total-Tokens` 一致。这说明三处（响应头 / `call_logs` / 未来的 `jev_decisions`）用的是同一个 id，可以放心拿它做串联。

### 2.5 错误场景：无令牌

```bash
curl -s -i -X POST http://localhost:3004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-ok","messages":[{"role":"user","content":"hi"}]}'
```

**实测输出**（13:34:40）：

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8

{"error":"Missing authentication token"}
```

⚠️ **这里有个坑**：契约 §2 规定 401 的 `body.error.type` 应为 `invalid_request_error`，实际返回的 `error` 是**字符串**，没有 `type` 字段。所以客户端不能写：

```js
// ✗ 这样写会拿到 undefined
if (res.status === 401 && body.error.type === 'invalid_request_error')
```

当前要写：

```js
// ✓ 兼容两种形状
if (res.status === 401) {
  const reason = typeof body.error === 'string' ? body.error : body.error?.type;
}
```

管理接口的 401 反而是合规的（`{"error":{"type":"invalid_request_error",...}}`），两处形状不同，别写一个函数到处用。详见 `docs/api.md` §8.2。

### 2.6 其他状态码速查

| 场景 | 状态码 | 实测响应体 | 合规 |
|---|---|---|---|
| 无/错令牌 | 401 | `{"error":"Missing authentication token"}` | ⚠️ 缺 `error.type` |
| 配额超限（硬限） | 403 | `{"error":{"type":"quota_exceeded","message":"Project quota exceeded"}}` | ✅ |
| 免费通道限流 | 429 + `Retry-After: 60` | `{"error":{"type":"rate_limit_error","message":"..."}}` | ✅ |
| 上游全挂 | 500 | `{"error":"Internal Server Error","message":"...","requestId":"..."}` | ⚠️ 缺 `error.type`，且无 `X-` 头 |
| 通道全熔断 | 503 | `{"error":"Service Unavailable","message":"No available channel"}` | ⚠️ 契约未定义该码 |

完整实测输出见 `docs/api.md` §2，偏差裁决意见见同文件 §8。

---

## 3. 最小 JS 客户端

文件：`docs/examples/min-client.mjs`（Node 20+ 原生 `fetch`，**零依赖**，不需要 `npm install`）。

```bash
GATEWAY_URL=http://localhost:3004 TOKEN=<业务令牌> node docs/examples/min-client.mjs
GATEWAY_URL=http://localhost:3004 TOKEN=<业务令牌> node docs/examples/min-client.mjs --error
```

### 3.1 完整代码

```js
const BASE = (process.env.GATEWAY_URL || 'http://localhost:3004').replace(/\/+$/, '');
const TOKEN = process.env.TOKEN;
const DEMO_ERROR = process.argv.includes('--error');

if (!TOKEN) {
  console.error('缺少 TOKEN 环境变量。先签一个业务令牌：');
  console.error(
    `  curl -X POST ${BASE}/api/admin/tokens -H "Content-Type: application/json" ` +
      `-H "x-admin-token: <ADMIN_TOKEN>" -d '{"projectName":"demo-client"}'`
  );
  process.exit(1);
}

async function chat(prompt, { model = 'mock-ok', taskType = 'test' } = {}) {
  const started = Date.now();

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEMO_ERROR ? 'not-a-real-token' : TOKEN}`,
    },
    body: JSON.stringify({
      model,
      taskType,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const latencyMs = Date.now() - started;
  const headers = {
    channel: res.headers.get('x-channel'),
    fallback: res.headers.get('x-fallback'),
    requestId: res.headers.get('x-request-id'),
    totalTokens: res.headers.get('x-total-tokens'),
    promptTokens: res.headers.get('x-prompt-tokens'),
    completionTokens: res.headers.get('x-completion-tokens'),
    tokensPerSec: res.headers.get('x-tokens-per-sec'),
    retryAfter: res.headers.get('retry-after'),
  };

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.headers = headers;
    throw err;
  }

  return { status: res.status, latencyMs, headers, body };
}

try {
  const r = await chat('用一句话说明什么是模型调度网关', { taskType: 'test' });

  console.log(`[${new Date().toISOString()}] HTTP ${r.status} | ${r.latencyMs}ms`);
  console.log('通道      :', r.headers.channel, r.headers.fallback ? '(fallback)' : '');
  console.log('请求 id   :', r.headers.requestId);
  console.log('token 用量:', `总 ${r.headers.totalTokens} = 输入 ${r.headers.promptTokens} + 输出 ${r.headers.completionTokens}`);
  console.log('生成速度  :', r.headers.tokensPerSec, 'tok/s');
  console.log('回复      :', r.body?.choices?.[0]?.message?.content ?? '(空)');
} catch (e) {
  console.error(`[${new Date().toISOString()}] 失败 status=${e.status}`);
  console.error('请求 id   :', e.headers?.requestId ?? '(响应头未返回)');
  console.error('error.type:', e.body?.error?.type ?? '(body 里没有 error.type —— 见 docs/api.md §8.2)');
  console.error('响应体    :', JSON.stringify(e.body));
  process.exit(1);
}
```

### 3.2 成功实测输出

```
$ GATEWAY_URL=http://localhost:3004 TOKEN=0c7ba4a9-... node docs/examples/min-client.mjs
[2026-11-24T05:34:57.713Z] HTTP 200 | 105ms
通道      : free
请求 id   : 79725cb4-3056-48d9-8611-247132bf7d61
token 用量: 总 30 = 输入 10 + 输出 20
生成速度  : 3333 tok/s
回复      : mock reply
```

`105ms` 里绝大部分是本机 HTTP 往返 + mock 响应，不是模型推理时间。真实 OFM 走 18900 时这个数字会到秒级。

### 3.3 错误实测输出

```
$ GATEWAY_URL=http://localhost:3004 TOKEN=0c7ba4a9-... node docs/examples/min-client.mjs --error
[2026-11-24T05:34:59.201Z] 失败 status=401
请求 id   : (响应头未返回)
error.type: (body 里没有 error.type —— 见 docs/api.md §8.2)
响应体    : {"error":"Invalid authentication token"}
```

退出码 `1`，方便 shell 脚本判断。这里刻意把「拿不到 `error.type`」这件事打印出来，而不是静默兜底——因为这是当前实现的真实缺陷，藏起来只会在联调周重复踩。

---

## 4. 对接自查清单

新项目接进来，按顺序过一遍，任一条不过就别继续：

- [ ] `curl /health` 返回 200，`status: "ok"`
- [ ] 用 `ADMIN_TOKEN` 能调到 `/api/admin/tokens`；**如果不需要鉴权就能调通，说明 `ADMIN_TOKEN` 是空的，这在演示环境是事故**
- [ ] 签到的 `token` 是 UUID，不是 `ADMIN_TOKEN`；两者混用会 401
- [ ] 首次调推理能拿到 200，并**把 `X-Request-Id` 打日志**
- [ ] 用该 id 能在 `/api/dashboard/logs` 查到对应记录，`token_used` 与 `X-Total-Tokens` 相等
- [ ] 故意用错令牌，确认自己的错误分支能处理 `error` 为**字符串**的情况（见 §2.5）
- [ ] 确认自己的重试逻辑认 `Retry-After`（免费通道限流时返回，单位秒）
- [ ] 不要对 403 做重试——配额超限是**硬限**，重试只会继续烧请求（虽然不计费，但会被日志记成失败）
- [ ] 遇到 503 有兜底（契约未定义该码，但实际会出现，见 §2.6）
- [ ] `quotaLimit` 按 token 数算，别按请求次数估

---

## 5. 实测记录

| 项 | 值 |
|---|---|
| 实测日期 | 2026-11-24 |
| 实测人 | 组员 4 |
| 网关 | `http://localhost:3004`，代码基线 `d6d69e5` |
| Node | v20.20.2（便携版，`engines >=20 <21`） |
| 上游 | `test/mocks/mock-channel.mjs` @ 18901 |
| 数据库 | `./data/gateway-member4-3004.db`（已 gitignore） |
| 覆盖场景 | 健康检查、签令牌、成功推理、日志回查、401、403、429、500、503、fallback、admin 鉴权 |
| 未覆盖 | 组长 3000 环境、真实 OFM 上游、流式（`stream:true`）、Jev（未接入） |

最后两项是硬缺口，不是遗漏——`stream` 归组员1 的通道实现，Jev 归组员1 的 1.4，等它们的 PR 合并后本文需要补测并追加。
