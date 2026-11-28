// 密钥存储安全化（任务 1.3）· 通道注册表集成测试
// 验证「明文不进库、运行时能解出、接口输出脱敏、存量明文兼容」这条完整链路。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, rmSync } from 'fs';

import { initDb, getDb, closeDb } from '../db/index.js';
import { loadChannels, getChannel, updateChannelConfig, resetSecretWarnings } from './channelRegistry.js';
import { MASTER_KEY_ENV, resetSecretCache, decryptSecret, isEncrypted } from './secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-channel-registry-secrets.db');
process.env.DB_PATH = TEST_DB_PATH;

const TEST_SECRET = 'test-master-secret-for-registry';
const AIPING_ENV_KEY = 'TEST_AIPING_KEY';

function readChannelRow(id) {
  return getDb().prepare('SELECT config_json FROM channels WHERE id = ?').get(id);
}

function writeRawConfig(id, config) {
  getDb().prepare('UPDATE channels SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
}

function removeTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
  }
}

describe('密钥存储安全化 · 通道注册表', () => {
  beforeEach(() => {
    removeTestDb();
    process.env[MASTER_KEY_ENV] = TEST_SECRET;
    process.env[AIPING_ENV_KEY] = 'sk-from-environment';
    resetSecretCache();
    resetSecretWarnings();
    initDb();
    loadChannels();
  });

  afterEach(() => {
    closeDb();
    delete process.env[AIPING_ENV_KEY];
    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();
    removeTestDb();
  });

  test('更新配置时明文 key 被加密落库，运行时仍能解出明文', () => {
    updateChannelConfig('sponsored', {
      endpoint: 'http://127.0.0.1:18901/v1/chat/completions',
      model: 'mock-ok',
      apiKeys: ['sk-live-1111', 'sk-live-2222']
    });

    // 1) 库里没有明文，只有密文
    const raw = readChannelRow('sponsored').config_json;
    assert.ok(!raw.includes('sk-live'), 'config_json 里不得出现明文密钥');
    const persisted = JSON.parse(raw);
    assert.strictEqual(persisted.apiKeys, undefined);
    assert.strictEqual(persisted.apiKey, undefined);
    assert.strictEqual(persisted.apiKeysEnc.length, 2);
    assert.ok(persisted.apiKeysEnc.every(isEncrypted));
    assert.deepStrictEqual(persisted.apiKeysEnc.map(decryptSecret), ['sk-live-1111', 'sk-live-2222']);

    // 2) 内存里能拿到明文，插件才能真的去请求上游
    assert.deepStrictEqual(getChannel('sponsored').getApiKeys(), ['sk-live-1111', 'sk-live-2222']);
    assert.strictEqual(getChannel('sponsored').getApiKeys().length, 2);
  });

  test('重新加载（模拟重启）后依然能用密文解出明文', () => {
    updateChannelConfig('sponsored', { endpoint: 'http://x', model: 'mock-ok', apiKeys: ['sk-restart'] });

    loadChannels(); // 丢掉内存实例，重新从库里加载

    assert.deepStrictEqual(getChannel('sponsored').getApiKeys(), ['sk-restart']);
  });

  test('对外快照 toJSON 脱敏：不含明文，也不含密文', () => {
    updateChannelConfig('sponsored', {
      endpoint: 'http://x',
      model: 'mock-ok',
      apiKeys: ['sk-1234567890abcdef']
    });

    const snapshot = getChannel('sponsored').toJSON();
    const json = JSON.stringify(snapshot);

    assert.strictEqual(snapshot.config.keyCount, 1);
    assert.deepStrictEqual(snapshot.config.apiKeys, ['sk-1…cdef']);
    assert.strictEqual(snapshot.config.apiKeysEnc, undefined);
    assert.ok(!json.includes('sk-1234567890abcdef'), '快照里不得出现明文');
    assert.ok(!json.includes('enc:v1:'), '快照里也不该出现密文');
  });

  test('没配主密钥时拒绝写明文，且库里的旧配置不变', () => {
    updateChannelConfig('sponsored', { endpoint: 'http://x', model: 'before', apiKeys: ['sk-before'] });
    const before = readChannelRow('sponsored').config_json;

    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();

    assert.throws(
      () => updateChannelConfig('sponsored', { model: 'after', apiKeys: ['sk-plain-would-be'] }),
      (error) => error.code === 'NO_MASTER_KEY'
    );

    assert.strictEqual(readChannelRow('sponsored').config_json, before, '失败时不得写库');
  });

  test('存量明文记录：仍可正常加载（兼容），改配置时自动加密且不丢钥匙', () => {
    // 模拟阶段1 留下的旧数据：明文直接躺在 config_json 里
    writeRawConfig('sponsored', {
      endpoint: 'http://legacy',
      model: 'legacy-model',
      apiKey: '',
      apiKeys: ['sk-legacy-1', 'sk-legacy-2']
    });
    loadChannels();

    assert.deepStrictEqual(
      getChannel('sponsored').getApiKeys(),
      ['sk-legacy-1', 'sk-legacy-2'],
      '旧明文必须还能读，升级后不能一上来就全挂'
    );
    assert.ok(
      !JSON.stringify(getChannel('sponsored').toJSON()).includes('sk-legacy-1'),
      '读得到，但接口输出必须照样脱敏'
    );

    // 只改 model，不碰密钥
    updateChannelConfig('sponsored', { model: 'new-model' });

    const persisted = JSON.parse(readChannelRow('sponsored').config_json);
    assert.strictEqual(persisted.model, 'new-model');
    assert.strictEqual(persisted.apiKeys, undefined, '改配置时明文必须被收口掉');
    assert.strictEqual(persisted.apiKeysEnc.length, 2);
    assert.deepStrictEqual(
      persisted.apiKeysEnc.map(decryptSecret),
      ['sk-legacy-1', 'sk-legacy-2'],
      '不能因为改了个 model 就把钥匙弄丢了'
    );
  });

  test('环境变量引用：库里只有变量名，运行时从进程环境取', () => {
    updateChannelConfig('aiping', {
      endpoint: 'https://aiping.cn/api/v1',
      model: 'qwen-max',
      apiKeyRefs: [AIPING_ENV_KEY]
    });

    const raw = readChannelRow('aiping').config_json;
    assert.ok(!raw.includes('sk-from-environment'), '引用方式下密钥值根本不落库');
    const persisted = JSON.parse(raw);
    assert.deepStrictEqual(persisted.apiKeyRefs, [AIPING_ENV_KEY]);
    assert.deepStrictEqual(persisted.apiKeysEnc, []);

    assert.deepStrictEqual(getChannel('aiping').getApiKeys(), ['sk-from-environment']);
    assert.strictEqual(getChannel('aiping').isConfigured(), true);
    assert.deepStrictEqual(getChannel('aiping').toJSON().config.apiKeyRefs, [AIPING_ENV_KEY]);
  });

  test('引用优先：同时交来环境和明文时以环境变量为准', () => {
    updateChannelConfig('sponsored', {
      endpoint: 'http://x',
      apiKeyRefs: [AIPING_ENV_KEY],
      apiKeys: ['sk-should-not-win']
    });

    const persisted = JSON.parse(readChannelRow('sponsored').config_json);
    assert.deepStrictEqual(persisted.apiKeyRefs, [AIPING_ENV_KEY]);
    assert.deepStrictEqual(persisted.apiKeysEnc, []);
    assert.deepStrictEqual(getChannel('sponsored').getApiKeys(), ['sk-from-environment']);
  });

  test('清空密钥：传空数组后通道回到未配置', () => {
    updateChannelConfig('sponsored', { endpoint: 'http://x', apiKeys: ['sk-to-clear'] });
    assert.strictEqual(getChannel('sponsored').getApiKeys().length, 1);

    updateChannelConfig('sponsored', { apiKeys: [] });

    assert.deepStrictEqual(getChannel('sponsored').getApiKeys(), []);
    assert.strictEqual(getChannel('sponsored').getApiKeys().length, 0);
    assert.deepStrictEqual(JSON.parse(readChannelRow('sponsored').config_json).apiKeysEnc, []);
  });
});
