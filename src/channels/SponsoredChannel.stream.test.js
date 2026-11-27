import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';

import { SponsoredChannel } from './SponsoredChannel.js';

// 一个"会分块吐字的假上游"：完全自包含，不依赖外部进程，因此跑起来快也不会抢端口。
function startUpstream(handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    received.push(record);
    handler(req, res, record, server);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        received,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function writeSseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
}

// 把上游流的字节按到达顺序收下来，附带每块的到达时间，用于证明"不是收齐一整包再发"
async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push({ at: Date.now(), text: chunk.toString('utf8') });
  }
  return chunks;
}

describe('SponsoredChannel.forwardStream（任务 1.1b 流式转发）', () => {
  let upstream;
  let channel;

  before(async () => {
    upstream = await startUpstream((req, res, record) => {
      const auth = record.headers.authorization || '';
      const model = record.body?.model;

      if (model === 'stream-badoath') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad key' } }));
        return;
      }

      if (model === 'stream-hang') {
        // 故意不回任何东西，用来测 config.timeoutMs 是否真的生效
        return;
      }

      if (model === 'stream-429-first' && auth.includes('key-1')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }

      writeSseHead(res);
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"total_tokens":7}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 80);
    });

    channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: upstream.url,
      model: 'mock-ok',
      apiKeys: ['key-1', 'key-2'],
      timeoutMs: 5000
    });
  });

  after(async () => {
    if (upstream) await upstream.close();
  });

  test('逐块透传：上游分两次写，调用方也分两次收到（不收齐整包再发）', async () => {
    const result = await channel.forwardStream({ messages: [{ role: 'user', content: '你好' }] });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.channel, 'sponsored');
    assert.ok(result.stream, 'forwardStream 必须返回可读流');

    const chunks = await drain(result.stream);
    const text = chunks.map(c => c.text).join('');

    assert.ok(text.includes('data: [DONE]'), '应原样透传 [DONE]');
    assert.strictEqual(
      (text.match(/^data: /gm) || []).length,
      4,
      '上游写了 4 个 data 事件，透传后也应是 4 个'
    );
    assert.ok(chunks.length >= 2, `应分多块到达，实际 ${chunks.length} 块`);
    assert.ok(
      chunks[chunks.length - 1].at - chunks[0].at >= 50,
      '第一块与最后一块之间存在上游的 80ms 间隔——说明没有被攒成一包'
    );
  });

  test('上游收到的请求确实是流式形态（stream=true 且 Accept: text/event-stream）', async () => {
    const before = upstream.received.length;
    const result = await channel.forwardStream({ messages: [{ role: 'user', content: 'hi' }] });
    await drain(result.stream);

    const record = upstream.received[before];
    assert.strictEqual(record.body.stream, true, '必须向上游声明 stream=true');
    assert.match(record.headers.accept, /text\/event-stream/);
    assert.strictEqual(record.body.model, 'mock-ok');
  });

  test('第一把 key 被 429：自动换下一把，流照常建立', async () => {
    const rotating = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: upstream.url,
      model: 'stream-429-first',
      apiKeys: ['key-1', 'key-2'],
      timeoutMs: 5000
    });

    const result = await rotating.forwardStream({ messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 2, '应先失败一把、再成功一把');
    assert.strictEqual(result.attempts[0].status, 429);
    assert.strictEqual(result.attempts[0].error.retriable, true);

    const text = (await drain(result.stream)).map(c => c.text).join('');
    assert.ok(text.includes('[DONE]'));
  });

  test('非 429/5xx（400）不换 key，直接如实抛错', async () => {
    const failing = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: upstream.url,
      model: 'stream-badoath',
      apiKeys: ['key-1', 'key-2'],
      timeoutMs: 5000
    });

    await assert.rejects(
      () => failing.forwardStream({ messages: [] }),
      err => {
        assert.match(err.message, /non-retryable/);
        assert.strictEqual(err.attempts.length, 1, '400 只该试一把');
        assert.strictEqual(err.attempts[0].status, 400);
        return true;
      }
    );
  });

  test('超时时长从 config 读取：timeoutMs=300 时不会挂到默认 30 秒', async () => {
    const impatient = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: upstream.url,
      model: 'stream-hang',
      apiKeys: ['key-1'],
      timeoutMs: 300
    });

    const startedAt = Date.now();
    await assert.rejects(
      () => impatient.forwardStream({ messages: [] }),
      err => {
        assert.match(err.message, /non-retryable|after trying all keys/);
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 4000, `应在 300ms 左右超时，实际 ${elapsed}ms`);
  });

  test('返回结果与错误里都不含密钥明文', async () => {
    const result = await channel.forwardStream({ messages: [] });
    const serialized = JSON.stringify({ channel: result.channel, keyCount: result.keyCount, attempts: result.attempts });
    assert.ok(!serialized.includes('key-1'), '不能泄露 key 明文');
    assert.ok(!serialized.includes('key-2'), '不能泄露 key 明文');
    await drain(result.stream);
  });
});
