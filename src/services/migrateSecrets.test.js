// 密钥存储安全化（任务 1.3）· 存量迁移脚本测试
//
// 验收原文：「迁移方案可复现」。所以这里是真的用子进程去跑
// scripts/migrate-secrets.mjs，而不是在进程内复算一遍逻辑。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, rmSync } from 'fs';

import { initDb, getDb, closeDb } from '../db/index.js';
import { MASTER_KEY_ENV, resetSecretCache, decryptSecret } from './secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const TEST_DB_PATH = join(__dirname, '../../data/test-migrate-secrets.db');
const SCRIPT = join(PROJECT_ROOT, 'scripts/migrate-secrets.mjs');
const TEST_SECRET = 'test-master-secret-for-migration';

process.env.DB_PATH = TEST_DB_PATH;

function removeTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
}

// 用子进程跑脚本，环境变量可以逐个覆盖（传 undefined 表示"这次不要这个变量"）
function runScript(args = [], envOverrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env
  });
}

function readConfig(id) {
  const row = getDb().prepare('SELECT config_json FROM channels WHERE id = ?').get(id);
  return row ? JSON.parse(row.config_json) : null;
}

// 造一份"阶段1 遗留"的库：密钥裸奔在 config_json 里
function seedLegacyDatabase() {
  initDb();
  getDb()
    .prepare('UPDATE channels SET config_json = ? WHERE id = ?')
    .run(JSON.stringify({
      endpoint: 'http://127.0.0.1:18901/v1/chat/completions',
      model: 'mock-ok',
      apiKey: '',
      apiKeys: ['sk-legacy-aaaa', 'sk-legacy-bbbb']
    }), 'sponsored');
  getDb()
    .prepare('UPDATE channels SET config_json = ? WHERE id = ?')
    .run(JSON.stringify({
      endpoint: 'https://aiping.cn/api/v1',
      model: 'qwen-max',
      apiKeyRefs: ['AIPING_KEY_1'],
      apiKeysEnc: []
    }), 'aiping');
  closeDb(); // 交给子进程独占这个文件
}

describe('密钥存储安全化 · 存量迁移脚本', () => {
  beforeEach(() => {
    removeTestDb();
    resetSecretCache();
    seedLegacyDatabase();
  });

  afterEach(() => {
    try { closeDb(); } catch (_error) { /* 已经关掉了 */ }
    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();
    removeTestDb();
  });

  test('--dry-run 只报告不写库', () => {
    const result = runScript(['--db', TEST_DB_PATH, '--dry-run'], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0, `脚本应正常退出，stderr=${result.stderr}`);
    assert.match(result.stdout, /dry-run（不写库）/);
    assert.match(result.stdout, /明文 2 把 → 密文 2 把/);
    assert.match(result.stdout, /dry-run 模式：数据库未做任何修改/);

    // 库必须保持原样：明文还在
    const config = readConfig('sponsored');
    assert.deepStrictEqual(config.apiKeys, ['sk-legacy-aaaa', 'sk-legacy-bbbb']);
    assert.strictEqual(config.apiKeysEnc, undefined);
  });

  test('真跑一次：明文变密文，且密文能解回原钥匙', () => {
    const result = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0, `脚本应正常退出，stderr=${result.stderr}`);
    assert.match(result.stdout, /完成：1 个通道被改写，共 2 把密钥加密。/);

    const raw = readConfig('sponsored');
    const rawText = JSON.stringify(raw);
    assert.strictEqual(raw.apiKeys, undefined, '改写后不得残留明文数组');
    assert.strictEqual(raw.apiKey, undefined);
    assert.strictEqual(raw.apiKeysEnc.length, 2);
    assert.ok(!rawText.includes('sk-legacy-'), '改写后库里不该还有明文');

    // 用同一把主密钥解密，必须能拿回原来的钥匙
    process.env[MASTER_KEY_ENV] = TEST_SECRET;
    resetSecretCache();
    assert.deepStrictEqual(
      raw.apiKeysEnc.map(decryptSecret),
      ['sk-legacy-aaaa', 'sk-legacy-bbbb']
    );
  });

  test('重复执行幂等：第二次报告 0 个通道被改写', () => {
    const first = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });
    assert.strictEqual(first.status, 0);

    const second = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });
    assert.strictEqual(second.status, 0);
    assert.match(second.stdout, /完成：0 个通道被改写，共 0 把密钥加密。/);
    assert.match(second.stdout, /sponsored：无需改动（已是密文（2 把））/);
    assert.match(second.stdout, /幂等检查/);
  });

  test('已用环境变量引用的通道不动', () => {
    const result = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /aiping：无需改动（已用环境变量引用（1 个））/);

    const aiping = readConfig('aiping');
    assert.deepStrictEqual(aiping.apiKeyRefs, ['AIPING_KEY_1']);
    assert.deepStrictEqual(aiping.apiKeysEnc, [], '引用方式的通道不需要密文，保持空数组');
  });

  test('没有主密钥：退出码 1，且一个字都不写库', () => {
    const before = JSON.stringify(readConfig('sponsored'));

    const result = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: undefined });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /未配置主密钥/);
    assert.match(result.stderr, /本次未写入任何数据/);

    initDb();
    assert.strictEqual(JSON.stringify(readConfig('sponsored')), before, '库内容必须一字不改');
  });

  test('库文件不存在：退出码 1，并且不会顺手建个新库', () => {
    const missing = join(__dirname, '../../data/test-migrate-missing.db');
    if (existsSync(missing)) rmSync(missing);

    const result = runScript(['--db', missing], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /找不到数据库文件/);
    assert.strictEqual(existsSync(missing), false, '迁移脚本不该创建新库');
  });
});
