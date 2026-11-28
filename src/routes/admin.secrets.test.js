// 密钥存储安全化（任务 1.3）· 管理接口端到端
//
// 验收原文：「新写入的配置不含明文密钥」。这里从 HTTP 层真发 PUT/GET，
// 两头都查：响应里看不到明文，库里也看不到明文。

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-admin-secrets.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.ADMIN_TOKEN = 'test-admin-token';

const { initDb, getDb, closeDb } = await import('../db/index.js');
const { loadChannels, resetSecretWarnings } = await import('../services/channelRegistry.js');
const { MASTER_KEY_ENV, resetSecretCache } = await import('../services/secrets.js');
const adminRoutes = (await import('./admin.js')).default;
const dashboardRoutes = (await import('./dashboard.js')).default;

const TEST_SECRET = 'test-master-secret-for-admin';
const ENV_REF_NAME = 'ADMIN_TEST_SPONSORED_KEY';

let server;
let baseUrl;

const authHeaders = {
  'Content-Type': 'application/json',
  'X-Admin-Token': 'test-admin-token'
};

async function putChannel(id, body) {
  const res = await fetch(`${baseUrl}/api/admin/channels/${id}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { res, text, json };
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { res, text, json };
}

function channelRowJson(id) {
  const row = getDb().prepare('SELECT config_json FROM channels WHERE id = ?').get(id);
  return row ? row.config_json : null;
}

describe('密钥存储安全化 · 管理接口', () => {
  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
    process.env[MASTER_KEY_ENV] = TEST_SECRET;
    process.env[ENV_REF_NAME] = 'sk-key-from-env';
    resetSecretCache();
    resetSecretWarnings();

    initDb();
    loadChannels();

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use('/api/dashboard', dashboardRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb();
    delete process.env[MASTER_KEY_ENV];
    delete process.env[ENV_REF_NAME];
    resetSecretCache();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
  });

  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = TEST_SECRET;
    process.env[ENV_REF_NAME] = 'sk-key-from-env';
    resetSecretCache();
  });

  test('PUT 传明文密钥：200，库里落密文，响应已脱敏', async () => {
    const { res, json, text } = await putChannel('sponsored', {
      config: {
        endpoint: 'http://127.0.0.1:18901/v1/chat/completions',
        model: 'mock-ok',
        apiKeys: ['sk-plain-admin-aaaa', 'sk-plain-admin-bbbb']
      }
    });

    assert.strictEqual(res.status, 200, text);
    assert.strictEqual(json.config.keyCount, 2);
    assert.strictEqual(json.config.apiKeysEnc, undefined);
    assert.ok(!text.includes('sk-plain-admin'), '响应里不得出现明文');

    const row = channelRowJson('sponsored');
    assert.ok(!row.includes('sk-plain-admin'), '库里不得出现明文');
    const persisted = JSON.parse(row);
    assert.strictEqual(persisted.apiKeysEnc.length, 2);
    assert.ok(persisted.apiKeysEnc.every((item) => item.startsWith('enc:v1:')));
  });

  test('GET /api/admin/channels 整体扫描：没有明文，也没有密文', async () => {
    await putChannel('sponsored', {
      config: { endpoint: 'http://127.0.0.1:18901/v1/chat/completions', apiKeys: ['sk-get-scan-1234'] }
    });

    const { res, json, text } = await getJson('/api/admin/channels');
    assert.strictEqual(res.status, 200);
    assert.ok(!text.includes('sk-get-scan-1234'), '通道列表不得吐明文');
    assert.ok(!text.includes('enc:v1:'), '密文也不该出现在接口里');

    const sponsored = json.find((item) => item.id === 'sponsored');
    assert.strictEqual(sponsored.config.keyCount, 1);
    assert.deepStrictEqual(sponsored.config.apiKeys, ['sk-g…1234']);
  });

  test('GET /api/dashboard/channels 同样脱敏（看板不经 admin 路由，另一个出口）', async () => {
    await putChannel('sponsored', {
      config: { endpoint: 'http://127.0.0.1:18901/v1/chat/completions', apiKeys: ['sk-dash-9876'] }
    });

    const { res, text } = await getJson('/api/dashboard/channels');
    assert.strictEqual(res.status, 200);
    assert.ok(!text.includes('sk-dash-9876'), '看板接口也不得吐明文');
    assert.ok(!text.includes('enc:v1:'));
  });

  test('没配主密钥时写明文：400 + code=NO_MASTER_KEY，且库里没有半截改动', async () => {
    const before = channelRowJson('sponsored');

    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();

    const { res, json } = await putChannel('sponsored', {
      config: { apiKeys: ['sk-would-be-plain'] }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.code, 'NO_MASTER_KEY');
    assert.ok(!channelRowJson('sponsored').includes('sk-would-be-plain'), '失败时不得写库');
    assert.strictEqual(channelRowJson('sponsored'), before, '库内容必须一字不改');
  });

  test('用环境变量引用写配置：库里只有变量名', async () => {
    const { res, text } = await putChannel('sponsored', {
      config: {
        endpoint: 'http://127.0.0.1:18901/v1/chat/completions',
        model: 'mock-ok',
        apiKeyRefs: [ENV_REF_NAME]
      }
    });

    assert.strictEqual(res.status, 200, text);
    const persisted = JSON.parse(channelRowJson('sponsored'));
    assert.deepStrictEqual(persisted.apiKeyRefs, [ENV_REF_NAME]);
    assert.deepStrictEqual(persisted.apiKeysEnc, []);
    assert.ok(!channelRowJson('sponsored').includes('sk-key-from-env'), '变量值不该落库');
  });

  test('非法引用名：400 + code=INVALID_REF_NAME', async () => {
    const { res, json } = await putChannel('sponsored', {
      config: { apiKeyRefs: ['not a valid name!'] }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.code, 'INVALID_REF_NAME');
  });
});
