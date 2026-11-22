// mock channel：可控假上游，供熔断/降级/配额测试注入故障
// 启动：node test/mocks/mock-channel.mjs   （端口取 MOCK_PORT，默认 18901）
// 行为由请求里的 model 字段决定：
//   mock-ok      200，OpenAI 风格回复（stream:true 时返回 SSE 两块）
//   mock-429     429 rate_limit_error
//   mock-5xx     500 internal_error
//   mock-timeout 挂起 65s 不响应（触发客户端 30s 超时）
// 可选请求头 x-mock-latency-ms: 给 mock-ok 增加额外延迟毫秒
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 18901);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function openAiReply(model, content) {
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, { object: 'list', data: ['mock-ok', 'mock-429', 'mock-5xx', 'mock-timeout'].map(id => ({ id, object: 'model', owned_by: 'mock' })) });
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const body = await readBody(req);
    const model = body.model || 'mock-ok';

    if (model === 'mock-429') {
      return json(res, 429, { error: { message: 'mock rate limit', type: 'rate_limit_error', code: 'RATE_LIMIT' } });
    }
    if (model === 'mock-5xx') {
      return json(res, 500, { error: { message: 'mock internal error', type: 'server_error' } });
    }
    if (model === 'mock-timeout') {
      // 故意不响应，65s 后关闭
      setTimeout(() => res.destroy(), 65000);
      return;
    }

    const extraLatency = Number(req.headers['x-mock-latency-ms'] || 0);
    if (extraLatency > 0) await new Promise(r => setTimeout(r, extraLatency));

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ ...openAiReply(model, 'mock'), choices: [{ index: 0, delta: { content: 'mock' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...openAiReply(model, 'stream'), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return json(res, 200, openAiReply(model, 'mock reply'));
  }

  json(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, () => {
  console.log(`[mock-channel] listening on http://127.0.0.1:${PORT} (models: mock-ok / mock-429 / mock-5xx / mock-timeout)`);
});
