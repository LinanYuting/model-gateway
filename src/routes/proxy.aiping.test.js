import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-proxy-aiping.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.USE_JEV = 'false';

const MOCK_SCRIPT = join(__dirname, '../../test/mocks/mock-channel.mjs');
const MOCK_PORT = 18996; // 与 18997（流式）、18998（Jev）、18999（通道单测）错开

const { initDb, getDb, closeDb } = await import('../db/index.js');
const { loadChannels, getChannel } = await import('../services/channelRegistry.js');
const { createToken } = await import('../services/quota.js');
const { runHealthProbe } = await import('../services/backup.js');
const proxyRoutes = (await import('./proxy.js')).default;

let mockProcess;
let mockUpstream;
let server;
let baseUrl;
let token;

function waitForPort(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error(`${url} 启动超时`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function configureChannel(id, config, enabled = true) {
  getDb()
    .prepare('UPDATE channels SET enabled = ?, config_json = ? WHERE id = ?')
    .run(enabled ? 1 : 0, JSON.stringify(config), id);
  loadChannels();
}

async function callProxy(body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

describe('aiping 通道端到端（任务 1.2 验收）', () => {
  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }

    // 用组长提供的官方 mock（契约 §7）当"假 aiping 上游"，验证"把 mock 端点填进配置后"的整条链路。
    mockProcess = spawn(process.execPath, [MOCK_SCRIPT], {
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      stdio: 'ignore'
    });
    await waitForPort(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
    mockUpstream = `http://127.0.0.1:${MOCK_PORT}/v1`;

    initDb();
    token = createToken('aiping 集成测试', 1000000).token;

    const app = express();
    app.use(express.json());
    app.use('/v1', proxyRoutes);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mockProcess && !mockProcess.killed) mockProcess.kill();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
  });

  test('验收：mock 端点填进配置后，转发全链路通过并落 call_logs', async () => {
    configureChannel('aiping', { endpoint: mockUpstream, model: 'mock-ok', apiKeys: ['aiping-test-key'] });

    const { res, json } = await callProxy({
      messages: [{ role: 'user', content: '你好' }],
      specifiedChannel: 'aiping'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-channel'), 'aiping');
    assert.strictEqual(json.choices[0].message.content, 'mock reply');

    const requestId = res.headers.get('x-request-id');
    const row = getDb().prepare('SELECT * FROM call_logs WHERE request_id = ?').get(requestId);
    assert.ok(row, '调用要有日志');
    assert.strictEqual(row.channel_id, 'aiping');
    assert.strictEqual(row.status_code, 200);
  });

  test('验收：配置好之后健康检查全链路通过，探测结果写回 channels 表', async () => {
    configureChannel('aiping', { endpoint: mockUpstream, model: 'mock-ok', apiKeys: ['aiping-test-key'] });

    const channel = getChannel('aiping');
    assert.strictEqual(await channel.healthCheck(), true);
    assert.strictEqual(channel.healthStatus, 'healthy');

    // 让后台探测任务跑一轮，看数据库里的健康状态是否同步
    for (const id of ['free', 'sponsored']) configureChannel(id, {}, false);
    configureChannel('aiping', { endpoint: mockUpstream, model: 'mock-ok', apiKeys: ['aiping-test-key'] }, true);
    await runHealthProbe();

    const row = getDb().prepare('SELECT health_status, last_probe_at FROM channels WHERE id = ?').get('aiping');
    assert.strictEqual(row.health_status, 'healthy');
    assert.ok(row.last_probe_at, '探测时间应写入');
  });

  test('验收：空配置时网关照常启动、路由不受影响（返回干净 500，不崩进程）', async () => {
    // 把 aiping 打开但配置留空：这等价于"用户启用了通道却还没填地址和钥匙"
    configureChannel('aiping', { endpoint: '', model: '', apiKey: '', apiKeys: [] }, true);
    configureChannel('sponsored', { endpoint: mockUpstream, model: 'mock-ok', apiKeys: ['sponsored-key'] }, true);

    const failed = await callProxy({ messages: [{ role: 'user', content: '走 aiping' }], specifiedChannel: 'aiping' });

    assert.strictEqual(failed.res.status, 500);
    assert.match(failed.text, /not configured/);
    assert.ok(failed.json.requestId, '失败响应也要带 requestId 便于排查');

    // 网关没有崩：紧接着的下一个请求仍然正常服务
    const ok = await callProxy({ messages: [{ role: 'user', content: '走赞助通道' }], specifiedChannel: 'sponsored' });
    assert.strictEqual(ok.res.status, 200);
    assert.strictEqual(ok.res.headers.get('x-channel'), 'sponsored');
  });

  test('验收：空配置的通道健康状态保持 unconfigured，且不刷告警', async () => {
    configureChannel('aiping', { endpoint: '', model: '', apiKey: '', apiKeys: [] }, true);

    const before = getDb().prepare("SELECT COUNT(*) AS n FROM alerts WHERE message LIKE '%aiping%'").get().n;
    await runHealthProbe();
    const after = getDb().prepare("SELECT COUNT(*) AS n FROM alerts WHERE message LIKE '%aiping%'").get().n;

    assert.strictEqual(after, before, '未配置不是故障，不该产生告警');

    const row = getDb().prepare('SELECT health_status FROM channels WHERE id = ?').get('aiping');
    assert.strictEqual(row.health_status, 'unconfigured');
  });
});
