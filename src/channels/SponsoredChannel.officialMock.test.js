import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SponsoredChannel } from './SponsoredChannel.js';

// 严格按任务书验收：故障注入的唯一来源是组长提供的官方 mock —— test/mocks/mock-channel.mjs（契约 §7）
// 这里用子进程真实启动那个脚本，而不是自己另写一个假上游。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCK_SCRIPT = join(__dirname, '../../test/mocks/mock-channel.mjs');
const MOCK_PORT = 18999; // 避开 .env 默认的 18901，防止和别人/别的测试抢端口
const ENDPOINT = `http://127.0.0.1:${MOCK_PORT}/v1`;

let mockProcess;

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

describe('SponsoredChannel 1.1a —— 组长官方 mock 验收（契约 §7）', () => {
  before(async () => {
    mockProcess = spawn(process.execPath, [MOCK_SCRIPT], {
      env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
      stdio: 'ignore'
    });
    await waitForMock();
  });

  after(() => {
    if (mockProcess && !mockProcess.killed) mockProcess.kill();
  });

  test('验收1：三把 key 经官方 mock-ok 轮询，顺序 0→1→2→0 且可观测', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: ENDPOINT,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    const used = [];
    for (let i = 0; i < 4; i++) {
      const result = await channel.forward({ messages: [], model: 'mock-ok' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts.length, 1);
      used.push(result.attempts[0].keyIndex);
    }
    assert.deepStrictEqual(used, [0, 1, 2, 0]);
  });

  test('验收2：官方 mock-429 触发换 key，三把全试且错误逐条记录', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: ENDPOINT,
      apiKeys: ['key-0', 'key-1', 'key-2']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-429' }),
      err => {
        assert.ok(Array.isArray(err.attempts));
        assert.strictEqual(err.attempts.length, 3);
        assert.deepStrictEqual(err.attempts.map(a => a.keyIndex), [0, 1, 2]);
        assert.ok(err.attempts.every(a =>
          a.error.status === 429 &&
          a.error.type === 'rate_limit_error' &&
          a.error.retriable === true
        ));
        return true;
      }
    );
  });

  test('验收2补充：官方 mock-5xx 同样触发换 key', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助通道', true, {
      endpoint: ENDPOINT,
      apiKeys: ['key-0', 'key-1']
    });

    await assert.rejects(
      () => channel.forward({ messages: [], model: 'mock-5xx' }),
      err => {
        assert.strictEqual(err.attempts.length, 2);
        assert.ok(err.attempts.every(a => a.error.status === 500 && a.error.retriable === true));
        return true;
      }
    );
  });
});
