// 最小 JS 客户端 —— Node 20+ 原生 fetch，零依赖
//
// 用法：
//   GATEWAY_URL=http://localhost:3004 TOKEN=<业务令牌> node docs/examples/min-client.mjs
//   GATEWAY_URL=http://localhost:3004 TOKEN=<业务令牌> node docs/examples/min-client.mjs --error
//
// 说明：
//   - 业务令牌来自管理接口 POST /api/admin/tokens，不是 ADMIN_TOKEN，两者不通用
//   - 请求失败时不要只看 status，要把 body.error.type 一起打出来（当前 /v1 的 401/500
//     不带 error.type，见 docs/api.md §8.2 / §8.3）

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

/**
 * 调一次推理接口。失败时抛错，错误对象带 status / body / headers。
 */
async function chat(prompt, { model = 'mock-ok', taskType = 'test' } = {}) {
  const started = Date.now();

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 也可以用 x-api-key: TOKEN，二选一（契约 §2）
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
