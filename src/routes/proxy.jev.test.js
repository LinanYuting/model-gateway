import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-proxy-jev.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.USE_JEV = 'false';

const MOCK_SCRIPT = join(__dirname, '../../test/mocks/mock-channel.mjs');
const MOCK_PORT = 18998; // 与其他测试的 18999 / .env 的 18901 错开，避免抢端口

const { initDb, getDb, closeDb } = await import('../db/index.js');
const { loadChannels } = await import('../services/channelRegistry.js');
const { createToken } = await import('../services/quota.js');
const { setJevClassifier, resetJevClassifier } = await import('../services/jev.js');
const proxyRoutes = (await import('./proxy.js')).default;

let mockProcess;
let server;
let baseUrl;
let token;

function waitForMock(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error('官方 mock 启动超时'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// 模拟真实调用：POST /v1/chat/completions
async function callGateway(body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

describe('POST /v1/chat/completions × Jev 落库（任务 1.4 验收）', () => {
  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }

    mockProcess = spawn(process.execPath, [MOCK_SCRIPT], {
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      stdio: 'ignore'
    });
    await waitForMock();

    initDb();
    // 把 sponsored 通道指向官方 mock，并启用它（formal 任务的默认首选）
    getDb()
      .prepare('UPDATE channels SET enabled = 1, config_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          endpoint: `http://127.0.0.1:${MOCK_PORT}/v1`,
          model: 'mock-ok',
          apiKey: '',
          apiKeys: ['test-key-1']
        }),
        'sponsored'
      );
    loadChannels();

    token = createToken('Jev集成测试', 1000000).token;

    const app = express();
    app.use(express.json());
    app.use('/v1', proxyRoutes);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    resetJevClassifier();
    if (server) await new Promise(resolve => server.close(resolve));
    if (mockProcess && !mockProcess.killed) mockProcess.kill();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
  });

  test('开关开启：响应头 X-Request-Id 可关联 jev_decisions 与 call_logs', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(() => ({ channelId: 'sponsored', confidence: 0.88, summary: '写一个快排' }));

    const { res } = await callGateway({
      messages: [{ role: 'user', content: '帮我写一个快速排序' }],
      model: 'mock-ok'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-channel'), 'sponsored');

    const requestId = res.headers.get('x-request-id');
    assert.ok(requestId, '响应必须带 X-Request-Id');

    const jevRow = getDb()
      .prepare('SELECT * FROM jev_decisions WHERE request_id = ?')
      .get(requestId);
    assert.ok(jevRow, 'jev_decisions 里应有本次请求的决策记录');
    assert.strictEqual(jevRow.decision, 'sponsored');
    assert.strictEqual(jevRow.confidence, 0.88);
    assert.strictEqual(jevRow.input_summary, '写一个快排');

    const callRow = getDb()
      .prepare('SELECT * FROM call_logs WHERE request_id = ?')
      .get(requestId);
    assert.ok(callRow, 'call_logs 里应有本次请求的调用记录');
    assert.strictEqual(callRow.channel_id, 'sponsored');
    assert.strictEqual(callRow.status_code, 200);

    // 验收原文：决策记录可经 X-Request-Id 与 call_logs 关联查询
    const joined = getDb()
      .prepare(`
        SELECT c.request_id, c.channel_id, c.status_code, j.decision, j.confidence
        FROM call_logs c JOIN jev_decisions j ON j.request_id = c.request_id
        WHERE c.request_id = ?
      `)
      .all(requestId);
    assert.strictEqual(joined.length, 1);
    assert.strictEqual(joined[0].decision, 'sponsored');
  });

  test('开关开启 + 置信度不足：按规则路由，决策记录为 rule-default', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(() => ({ channelId: 'aiping', confidence: 0.42 }));

    const { res } = await callGateway({
      messages: [{ role: 'user', content: '随便聊聊' }],
      model: 'mock-ok'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-channel'), 'sponsored', '应回退到基础规则');

    const requestId = res.headers.get('x-request-id');
    const jevRow = getDb()
      .prepare('SELECT * FROM jev_decisions WHERE request_id = ?')
      .get(requestId);
    assert.strictEqual(jevRow.decision, 'rule-default');
    assert.strictEqual(jevRow.confidence, 0.42);
  });

  test('开关关闭：请求正常完成，且不产生决策记录（零额外开销）', async () => {
    process.env.USE_JEV = 'false';
    let calls = 0;
    setJevClassifier(() => {
      calls++;
      return { channelId: 'aiping', confidence: 0.99 };
    });

    const { res } = await callGateway({
      messages: [{ role: 'user', content: '关掉 Jev 也能跑' }],
      model: 'mock-ok'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-channel'), 'sponsored');

    const requestId = res.headers.get('x-request-id');
    assert.strictEqual(calls, 0, '开关关闭时决策器不该被调用');
    assert.strictEqual(
      getDb().prepare('SELECT COUNT(*) AS n FROM jev_decisions WHERE request_id = ?').get(requestId).n,
      0
    );
    assert.ok(
      getDb().prepare('SELECT * FROM call_logs WHERE request_id = ?').get(requestId),
      'call_logs 仍应正常记录'
    );
  });

  test('开关开启但决策器抛错：请求不受影响，记录 rule-default', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(() => {
      throw new Error('决策模型挂掉');
    });

    const { res } = await callGateway({
      messages: [{ role: 'user', content: '模型挂了也不能影响我' }],
      model: 'mock-ok'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-channel'), 'sponsored');
    const requestId = res.headers.get('x-request-id');
    assert.strictEqual(
      getDb().prepare('SELECT decision FROM jev_decisions WHERE request_id = ?').get(requestId).decision,
      'rule-default'
    );
  });
});
