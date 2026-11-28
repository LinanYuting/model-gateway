// 密钥存储安全化（任务 1.3）· 存量迁移脚本测试
//
// 验收原文：「迁移方案可复现」。所以这里是真的用子进程去跑
// scripts/migrate-secrets.mjs，而不是在进程内复算一遍逻辑。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync, rmSync, readdirSync, readFileSync } from 'fs';

import { initDb, getDb, closeDb } from '../db/index.js';
import { MASTER_KEY_ENV, MASTER_KEY_PREVIOUS_ENV, resetSecretCache, decryptSecret } from './secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const TEST_DB_PATH = join(__dirname, '../../data/test-migrate-secrets.db');
const SCRIPT = join(PROJECT_ROOT, 'scripts/migrate-secrets.mjs');
const TEST_SECRET = 'test-master-secret-for-migration';

process.env.DB_PATH = TEST_DB_PATH;

function listBackups() {
  const dir = dirname(TEST_DB_PATH);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(TEST_DB_PATH)}.bak-`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dir, name));
}

function removeTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
  for (const backup of listBackups()) rmSync(backup);
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

  // ---- 第二轮安全审查第 4 条：迁移前备份、异常恢复、并发保护 ----

  test('真跑前自动备份：备份里有迁移前的明文，路径会打印出来', () => {
    const result = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /已备份到：.+\.bak-\d{8}-\d{6}/);

    const backups = listBackups();
    assert.strictEqual(backups.length, 1, '应恰好生成一个备份文件');

    // 备份是迁移前的整库拷贝：里面应该还是明文
    const backupBytes = readFileSync(backups[0]).toString('latin1');
    assert.ok(backupBytes.includes('sk-legacy-aaaa'), '备份必须保留迁移前的内容，否则回不去');
  });

  test('--no-backup：不生成备份文件', () => {
    const result = runScript(['--db', TEST_DB_PATH, '--no-backup'], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /已按 --no-backup 跳过备份/);
    assert.deepStrictEqual(listBackups(), []);
  });

  test('--restore 不加 --yes：拒绝执行，库保持现状', () => {
    const migrate = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });
    assert.strictEqual(migrate.status, 0);
    const [backup] = listBackups();
    assert.ok(backup);
    const migratedRaw = readFileSync(TEST_DB_PATH).toString('latin1');

    const result = runScript(['--db', TEST_DB_PATH, '--restore', backup], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /--yes/);
    assert.strictEqual(readFileSync(TEST_DB_PATH).toString('latin1'), migratedRaw, '库不得被改动');
  });

  test('--restore 加 --yes：用备份覆盖回迁移前状态', () => {
    const migrate = runScript(['--db', TEST_DB_PATH], { [MASTER_KEY_ENV]: TEST_SECRET });
    assert.strictEqual(migrate.status, 0);
    const [backup] = listBackups();

    const result = runScript(['--db', TEST_DB_PATH, '--restore', backup, '--yes'], { [MASTER_KEY_ENV]: TEST_SECRET });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /已用备份恢复/);

    initDb();
    const config = readConfig('sponsored');
    assert.deepStrictEqual(config.apiKeys, ['sk-legacy-aaaa', 'sk-legacy-bbbb'], '应回到明文状态');
    assert.strictEqual(config.apiKeysEnc, undefined);
    closeDb();
  });

  test('备份文件不存在时 --restore 报错退出，不创建任何东西', () => {
    const result = runScript(
      ['--db', TEST_DB_PATH, '--restore', join(__dirname, '../../data/nope.bak-20200101-000000'), '--yes'],
      { [MASTER_KEY_ENV]: TEST_SECRET }
    );

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /找不到备份文件/);
  });

  test('配了 GATEWAY_SECRET_PREVIOUS：能解开旧密钥密文并提示还需重加密', () => {
    // 第一步：用"旧主密钥"把明文加密落库
    const first = runScript(['--db', TEST_DB_PATH, '--no-backup'], { [MASTER_KEY_ENV]: TEST_SECRET });
    assert.strictEqual(first.status, 0, first.stderr);

    // 第二步：换成"新主密钥"，旧密钥放进 PREVIOUS —— 模拟轮换过渡期
    const result = runScript(['--db', TEST_DB_PATH, '--no-backup'], {
      [MASTER_KEY_ENV]: 'the-new-master-secret',
      [MASTER_KEY_PREVIOUS_ENV]: TEST_SECRET
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /另配了上一版主密钥/);
    assert.match(result.stdout, /校验通过/);
    assert.match(result.stdout, /2 条是用 GATEWAY_SECRET_PREVIOUS 解开的/, result.stdout);
  });
});
