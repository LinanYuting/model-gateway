import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { SponsoredChannel } from './SponsoredChannel.js';

// 一个自包含的假上游，行为与 test/mocks/mock-channel.mjs 一致（契约 §7）：
//   mock-ok   → 200
//   mock-429  → 429 rate_limit_error
//   mock-400  → 400（非限流错误，用来证明"不该换钥匙"）
// 用端口 0 让系统分配，避免和组员/其它测试抢固定端口。
let server;
let endpoint;

describe('SponsoredChannel 多 key 轮询 (1.1a)', () => {
  before(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      let model = 'mock-ok';
      try { model = (JSON.parse(body || '{}')).model || 'mock-ok'; } catch {}

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (model === 'mock-429') {
        return send(429, { error: { type: 'rate_limit_error', message: 'mock rate limit' } });
      }
      if (model === 'mock-400') {
        return send(400, { error: { type: 'invalid_request_error', message: 'bad request' } });
      }
      return send(200, {
        id: 'mock-ok',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('验收1：三把 key 按 0→1→2→0 轮换，且顺序可观测', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    const usedIndexes = [];
    for (let i = 0; i < 4; i++) {
      const result = await channel.forward({ messages: [], model: 'mock-ok' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts.length, 1);   // 成功只用了 1 把
      usedIndexes.push(result.attempts[0].keyIndex);   // 用了第几把——可观测
    }

    assert.deepStrictEqual(usedIndexes, [0, 1, 2, 0]);
  });

  test('验收2：mock-429 触发换 key，三把全被尝试且错误逐条记录', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-429' }),
      err => {
        assert.ok(Array.isArray(err.attempts));
        assert.strictEqual(err.attempts.length, 3);                       // 三把都试了
        assert.deepStrictEqual(err.attempts.map(a => a.keyIndex), [0, 1, 2]);
        assert.ok(err.attempts.every(a =>
          a.error.status === 429 && a.error.type === 'rate_limit_error' && a.error.retriable === true
        ));
        assert.ok(err.message.includes('after trying all keys'));
        return true;
      }
    );
  });

  test('加分：非 429/5xx 错误（400）不换 key，只试一把即如实报错', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-400' }),
      err => {
        assert.strictEqual(err.attempts.length, 1);                       // 没有无谓地换钥匙
        assert.strictEqual(err.attempts[0].error.status, 400);
        assert.strictEqual(err.attempts[0].error.retriable, false);
        return true;
      }
    );
  });

  test('配置超时被读取：timeoutMs 写进配置后不再使用硬编码值', async () => {
    // 用极小超时 + 一个永不响应的上游，验证 forward 很快因超时失败。
    const slow = http.createServer(() => { /* 故意不回应 */ });
    await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
    const slowEndpoint = `http://127.0.0.1:${slow.address().port}/v1`;

    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: slowEndpoint,
      apiKeys: ['key-0'],
      timeoutMs: 120 // 120ms 超时，而不是代码里写死的 30000ms
    });

    const t0 = Date.now();
    await assert.rejects(() => channel.forward({ messages: [], model: 'mock-ok' }));
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 3000, `期望约 120ms 超时，实际 ${elapsed}ms（说明没读到 config.timeoutMs）`);
    await new Promise(resolve => slow.close(resolve));
  });

  test('可观测数据不含密钥明文', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint,
      apiKeys: ['SECRET_SHOULD_NOT_LEAK']
    });
    const result = await channel.forward({ messages: [], model: 'mock-ok' });
    assert.ok(!JSON.stringify(result.attempts).includes('SECRET_SHOULD_NOT_LEAK'));
  });
});
