import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-proxy-stream.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.USE_JEV = 'false';

const MOCK_SCRIPT = join(__dirname, '../../test/mocks/mock-channel.mjs');
const MOCK_PORT = 18997; // 与 18998（Jev 集成）、18999（通道官方 mock）、.env 的 18901 错开

const { initDb, getDb, closeDb } = await import('../db/index.js');
const { loadChannels } = await import('../services/channelRegistry.js');
const { createToken } = await import('../services/quota.js');
const proxyRoutes = (await import('./proxy.js')).default;

let mockProcess;
let officialUpstream;
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

// 自建上游：按 model 决定行为，用来制造"分块节奏""写到一半断线""全 500"这些官方 mock 覆盖不到的场景
function startCustomUpstream() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const model = body?.model;

    if (model === 'boom-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'upstream exploded' } }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"choices":[{"delta":{"content":"第一块"}}]}\n\n');

    if (model === 'stream-die') {
      // 写出一块之后直接掐断连接，模拟上游中途崩掉
      setTimeout(() => req.socket.destroy(), 30);
      return;
    }

    // stream-pace：两块之间隔 80ms —— 打穿"收齐整包再发"的实现
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"第二块"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 80);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function configureChannel(id, config, enabled = true) {
  getDb()
    .prepare('UPDATE channels SET enabled = ?, config_json = ? WHERE id = ?')
    .run(enabled ? 1 : 0, JSON.stringify(config), id);
  loadChannels();
}

async function callStream(body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const chunks = [];
  if (res.body) {
    for await (const chunk of res.body) {
      chunks.push({ at: Date.now(), text: Buffer.from(chunk).toString('utf8') });
    }
  }
  return { res, chunks, text: chunks.map(c => c.text).join('') };
}

describe('POST /v1/chat/completions × 流式转发（任务 1.1b 验收）', () => {
  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }

    mockProcess = spawn(process.execPath, [MOCK_SCRIPT], {
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      stdio: 'ignore'
    });
    await waitForPort(`http://127.0.0.1:${MOCK_PORT}/v1/models`);

    officialUpstream = `http://127.0.0.1:${MOCK_PORT}/v1`;
    initDb();

    token = createToken('流式集成测试', 1000000).token;

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

  test('官方 mock + stream=true：逐块透传，响应头与 call_logs 齐全', async () => {
    configureChannel('free', { endpoint: `${officialUpstream}/chat/completions`, model: 'mock-ok' }, false);
    configureChannel('sponsored', { endpoint: officialUpstream, model: 'mock-ok', apiKeys: ['test-key-1'] });

    const { res, text } = await callStream({
      messages: [{ role: 'user', content: '讲个笑话' }],
      model: 'mock-ok',
      stream: true
    });

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.strictEqual(res.headers.get('x-channel'), 'sponsored');

    const requestId = res.headers.get('x-request-id');
    assert.ok(requestId, '流式响应也必须带 X-Request-Id');

    assert.ok(text.includes('data: [DONE]'), '必须以 [DONE] 收尾');
    assert.ok(
      (text.match(/^data: /gm) || []).length >= 3,
      '官方 mock 会吐多块，透传后应能看到多个 data 事件'
    );

    const callRow = getDb()
      .prepare('SELECT * FROM call_logs WHERE request_id = ?')
      .get(requestId);
    assert.ok(callRow, '流式请求同样要落 call_logs');
    assert.strictEqual(callRow.channel_id, 'sponsored');
    assert.strictEqual(callRow.status_code, 200);
  });

  test('上游分两次写（间隔 80ms）：调用方也分两次收到，不是收齐整包再发', async () => {
    const custom = await startCustomUpstream();
    try {
      configureChannel('sponsored', { endpoint: custom.url, model: 'stream-pace', apiKeys: ['k1'] });

      const { res, chunks, text } = await callStream({
        messages: [{ role: 'user', content: '慢慢说' }],
        model: 'stream-pace',
        stream: true
      });

      assert.strictEqual(res.status, 200);
      assert.ok(chunks.length >= 2, `应分多块到达，实际 ${chunks.length} 块`);
      assert.ok(
        chunks[chunks.length - 1].at - chunks[0].at >= 50,
        '首块与末块之间应保留上游的 80ms 间隔'
      );

      assert.ok(text.includes('第一块'), '第一块内容应已送达');
      assert.ok(text.includes('[DONE]'));
    } finally {
      await custom.close();
    }
  });

  test('上游写到一半断线：已发出的内容保留，补 error 事件收尾，日志记 500', async () => {
    const custom = await startCustomUpstream();
    try {
      configureChannel('sponsored', { endpoint: custom.url, model: 'stream-die', apiKeys: ['k1'] });

      const { res, text } = await callStream({
        messages: [{ role: 'user', content: '说到一半崩了' }],
        model: 'stream-die',
        stream: true
      });

      // 头已经发出去了，状态码仍是 200；错误通过 SSE 事件告知调用方
      assert.strictEqual(res.status, 200);
      assert.ok(text.includes('第一块'), '断线前的内容应已经透传出去');
      assert.ok(text.includes('upstream_stream_error'), '应补一个错误事件');
      assert.ok(text.includes('data: [DONE]'), '错误后仍要正常收尾，避免调用方一直等');

      const callRow = getDb()
        .prepare('SELECT * FROM call_logs WHERE request_id = ?')
        .get(res.headers.get('x-request-id'));
      assert.strictEqual(callRow.status_code, 500);
      assert.match(callRow.error_message, /stream interrupted/);
    } finally {
      await custom.close();
    }
  });

  test('首字节前就失败（全 key 500、免费通道关闭）：干净地回 500 JSON，而不是半个 SSE', async () => {
    const custom = await startCustomUpstream();
    try {
      configureChannel('sponsored', { endpoint: custom.url, model: 'boom-500', apiKeys: ['k1', 'k2'] });
      configureChannel('free', { endpoint: `${officialUpstream}/chat/completions`, model: 'mock-ok' }, false);

      const { res, text } = await callStream({
        messages: [{ role: 'user', content: '上游全挂' }],
        model: 'boom-500',
        stream: true
      });

      assert.strictEqual(res.status, 500);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = JSON.parse(text);
      assert.strictEqual(body.error, 'Internal Server Error');
      assert.ok(body.requestId, '错误响应也要带 requestId 方便排障');
      assert.match(body.message, /after trying all keys/);
    } finally {
      await custom.close();
    }
  });

  test('赞助通道挂掉时改用免费通道：协议降级为单块 SSE（data + [DONE]）', async () => {
    const custom = await startCustomUpstream();
    try {
      configureChannel('sponsored', { endpoint: custom.url, model: 'boom-500', apiKeys: ['k1'] });
      configureChannel('free', { endpoint: `${officialUpstream}/chat/completions`, model: 'mock-ok' }, true);

      const { res, text } = await callStream({
        messages: [{ role: 'user', content: '兜底也要能流式' }],
        model: 'boom-500',
        stream: true
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('x-channel'), 'free');
      assert.strictEqual(res.headers.get('x-fallback'), 'true');
      assert.match(res.headers.get('content-type'), /text\/event-stream/);

      const dataEvents = text.match(/^data: /gm) || [];
      assert.strictEqual(dataEvents.length, 2, '降级路径应为 1 个数据事件 + 1 个 [DONE]');
      assert.ok(text.includes('data: [DONE]'));

      const first = JSON.parse(text.split('\n')[0].replace(/^data: /, ''));
      assert.ok(first.choices, '单块 SSE 里应是完整的响应 JSON');
    } finally {
      await custom.close();
    }
  });
});
