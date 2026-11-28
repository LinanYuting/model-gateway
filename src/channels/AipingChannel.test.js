import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AipingChannel } from './AipingChannel.js';

// 自包含的假上游：行为与 test/mocks/mock-channel.mjs（契约 §7）保持一致，
// 另加两点本任务需要的观测能力：
//   · 记下每次请求的路径与 Authorization，用来证明"端点被补齐""钥匙真的带上了"
//   · 支持 GET {base}/models（健康检查打的就是这个），并可用 bad-key 返回 401
let server;
let endpoint;
let requests = [];

describe('AipingChannel（任务 1.2）', () => {
  before(async () => {
    requests = [];
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      let model = 'mock-ok';
      try { model = (JSON.parse(body || '{}')).model || 'mock-ok'; } catch {}

      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // 健康检查：GET /v1/models
      if (req.method === 'GET' && req.url === '/v1/models') {
        if ((req.headers.authorization || '').includes('bad-key')) {
          return send(401, { error: { type: 'authentication_error', message: 'invalid api key' } });
        }
        return send(200, {
          object: 'list',
          data: [{ id: 'mock-ok', object: 'model', owned_by: 'mock' }]
        });
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        if (model === 'mock-429') {
          return send(429, { error: { type: 'rate_limit_error', message: 'mock rate limit' } });
        }
        if (model === 'mock-400') {
          return send(400, { error: { type: 'invalid_request_error', message: 'bad request' } });
        }
        if (model === 'mock-5xx') {
          return send(500, { error: { type: 'server_error', message: 'mock internal error' } });
        }
        return send(200, {
          id: 'mock-ok',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }

      send(404, { error: { message: 'not found' } });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // 故意只给 base 地址，不带 /chat/completions —— 真实用户填 aiping 时就是这种写法
    endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('未配置时 healthCheck 返回 false、状态记 unconfigured，且一个请求都不发', async () => {
    requests = [];
    const cases = [
      {},                                             // 什么都没填
      { endpoint: '' },                               // 只有空地址
      { endpoint: '   ' },                            // 地址是一串空格
      { endpoint, apiKeys: [] },                      // 有地址没钥匙
      { endpoint, apiKeys: ['', '   '] }              // 钥匙是空的（空字符串会被过滤掉）
    ];

    for (const config of cases) {
      const channel = new AipingChannel('aiping', 'aiping 通道', true, config);
      const healthy = await channel.healthCheck();
      assert.strictEqual(healthy, false, `配置 ${JSON.stringify(config)} 应判为未配置`);
      assert.strictEqual(channel.healthStatus, 'unconfigured');
    }

    assert.strictEqual(requests.length, 0, '未配置的通道不该发出任何网络请求');
  });

  test('验收：把 mock 端点填进配置后，健康检查全链路通过', async () => {
    requests = [];
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['test-key-1']
    });

    const healthy = await channel.healthCheck();

    assert.strictEqual(healthy, true);
    assert.strictEqual(channel.healthStatus, 'healthy');
    assert.ok(channel.lastProbeAt, '探测时间要被记录');

    const probe = requests.find(r => r.method === 'GET');
    assert.ok(probe, '健康检查应发 GET 请求');
    assert.strictEqual(probe.url, '/v1/models', '健康检查走 {base}/models');
    assert.strictEqual(probe.auth, 'Bearer test-key-1', '健康检查必须带 Authorization');
  });

  test('健康检查遇到 401 只记 unhealthy，不抛异常', async () => {
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['bad-key']
    });

    const healthy = await channel.healthCheck();

    assert.strictEqual(healthy, false);
    assert.strictEqual(channel.healthStatus, 'unhealthy');
  });

  test('健康检查超时读 config.healthTimeoutMs，而不是硬编码 10 秒', async () => {
    const hang = http.createServer(() => { /* 故意不回应 */ });
    await new Promise(resolve => hang.listen(0, '127.0.0.1', resolve));
    const hangEndpoint = `http://127.0.0.1:${hang.address().port}/v1`;

    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint: hangEndpoint,
      apiKeys: ['test-key-1'],
      healthTimeoutMs: 120
    });

    const t0 = Date.now();
    const healthy = await channel.healthCheck();
    const elapsed = Date.now() - t0;

    assert.strictEqual(healthy, false);
    assert.ok(elapsed < 3000, `期望约 120ms 超时，实际 ${elapsed}ms（说明没读到 config.healthTimeoutMs）`);
    await new Promise(resolve => hang.close(resolve));
  });

  test('验收：只有 base 地址也能转发——端点自动补 /chat/completions 且带 Bearer', async () => {
    requests = [];
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,                                  // .../v1 ，没有 /chat/completions
      model: 'mock-ok',
      apiKeys: ['test-key-1']
    });

    const result = await channel.forward({ messages: [{ role: 'user', content: 'hi' }] });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.channel, 'aiping');
    assert.ok(typeof result.latency === 'number');

    const post = requests.find(r => r.method === 'POST');
    assert.strictEqual(post.url, '/v1/chat/completions', '端点要自动补齐 /chat/completions');
    assert.strictEqual(post.auth, 'Bearer test-key-1');
  });

  test('填全量地址（已含 /chat/completions）也不会重复拼路径', async () => {
    requests = [];
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint: `${endpoint}/chat/completions`,
      apiKeys: ['test-key-1']
    });

    await channel.forward({ messages: [], model: 'mock-ok' });

    const post = requests.find(r => r.method === 'POST');
    assert.strictEqual(post.url, '/v1/chat/completions');
  });

  test('多把 key 按 0→1→2→0 轮换，顺序可观测', async () => {
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    const used = [];
    for (let i = 0; i < 4; i++) {
      const result = await channel.forward({ messages: [], model: 'mock-ok' });
      assert.strictEqual(result.attempts.length, 1);
      used.push(result.attempts[0].keyIndex);
    }

    assert.deepStrictEqual(used, [0, 1, 2, 0]);
  });

  test('429 触发换 key：三把全被尝试且错误逐条记录', async () => {
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-429' }),
      err => {
        assert.strictEqual(err.attempts.length, 3);
        assert.deepStrictEqual(err.attempts.map(a => a.keyIndex), [0, 1, 2]);
        assert.ok(err.attempts.every(a =>
          a.error.status === 429 && a.error.type === 'rate_limit_error' && a.error.retriable === true
        ));
        assert.ok(err.message.includes('after trying all keys'));
        return true;
      }
    );
  });

  test('5xx 也换 key；400 这类参数错误不换 key，只试一把如实报错', async () => {
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-5xx' }),
      err => {
        assert.strictEqual(err.attempts.length, 3, '5xx 应该继续换 key');
        return true;
      }
    );

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-400' }),
      err => {
        assert.strictEqual(err.attempts.length, 1, '400 换钥匙没用，不该无谓重试');
        assert.strictEqual(err.attempts[0].error.status, 400);
        assert.strictEqual(err.attempts[0].error.retriable, false);
        assert.ok(err.message.includes('non-retryable'));
        return true;
      }
    );
  });

  test('未配置时 forward 直接报"未配置"，不发请求', async () => {
    requests = [];
    const channel = new AipingChannel('aiping', 'aiping 通道', true, { endpoint: '', apiKeys: [] });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-ok' }),
      err => {
        assert.ok(err.message.includes('not configured'));
        assert.ok(err.message.includes('endpoint'));
        return true;
      }
    );

    const noKeys = new AipingChannel('aiping', 'aiping 通道', true, { endpoint, apiKeys: [] });
    await assert.rejects(
      () => noKeys.forward({ messages: [], model: 'mock-ok' }),
      err => {
        assert.ok(err.message.includes('apiKey'));
        return true;
      }
    );

    assert.strictEqual(requests.length, 0);
  });

  test('业务超时读 config.timeoutMs', async () => {
    const hang = http.createServer(() => { /* 故意不回应 */ });
    await new Promise(resolve => hang.listen(0, '127.0.0.1', resolve));
    const hangEndpoint = `http://127.0.0.1:${hang.address().port}/v1`;

    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint: hangEndpoint,
      apiKeys: ['test-key-1'],
      timeoutMs: 120
    });

    const t0 = Date.now();
    await assert.rejects(() => channel.forward({ messages: [], model: 'mock-ok' }));
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 3000, `期望约 120ms 超时，实际 ${elapsed}ms（说明没读到 config.timeoutMs）`);
    await new Promise(resolve => hang.close(resolve));
  });

  test('可观测数据与错误信息都不含密钥明文', async () => {
    const secret = 'SECRET_SHOULD_NOT_LEAK';
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: [secret]
    });

    const ok = await channel.forward({ messages: [], model: 'mock-ok' });
    assert.ok(!JSON.stringify(ok).includes(secret));

    const failing = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: [secret]
    });
    await assert.rejects(
      () => failing.forward({ messages: [], model: 'mock-429' }),
      err => {
        assert.ok(!err.message.includes(secret));
        assert.ok(!JSON.stringify(err.attempts).includes(secret));
        return true;
      }
    );
  });

  test('toJSON 导出配置快照，并用 configured/keyCount 标示是否配好', () => {
    const unconfigured = new AipingChannel('aiping', 'aiping 通道', false, { endpoint: '', apiKeys: [] });
    const snapshot = unconfigured.toJSON();

    assert.strictEqual(snapshot.id, 'aiping');
    assert.strictEqual(snapshot.type, 'aiping');
    assert.strictEqual(snapshot.name, 'aiping 通道');
    assert.strictEqual(snapshot.enabled, false);
    assert.strictEqual(snapshot.healthStatus, 'unconfigured');
    assert.strictEqual(snapshot.configured, false);
    assert.strictEqual(snapshot.keyCount, 0);

    const configured = new AipingChannel('aiping', 'aiping 通道', true, {
      endpoint,
      apiKeys: ['k1', 'k2', '  ']     // 空钥匙不计入
    });
    const configuredSnapshot = configured.toJSON();

    assert.strictEqual(configuredSnapshot.configured, true);
    assert.strictEqual(configuredSnapshot.keyCount, 2);
    assert.strictEqual(configuredSnapshot.config.endpoint, endpoint);
  });
});
