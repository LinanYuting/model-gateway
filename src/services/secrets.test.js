// 密钥存储安全化（任务 1.3）单元测试
// 只测 src/services/secrets.js 本身，不碰数据库。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  MASTER_KEY_ENV,
  ENCRYPTED_PREFIX,
  SecretsError,
  hasMasterKey,
  getMasterKey,
  resetSecretCache,
  isEncrypted,
  isEnvRefName,
  encryptSecret,
  decryptSecret,
  maskSecret,
  resolveApiKeyEntries,
  resolveApiKeys,
  hydrateConfig,
  toPersistableConfig,
  sealIncomingConfig,
  sealPersistedConfig,
  sanitizeConfigForOutput,
  migrateConfig
} from './secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '../..');

const TEST_SECRET = 'test-master-secret-for-unit-tests';

function withMasterKey() {
  process.env[MASTER_KEY_ENV] = TEST_SECRET;
  resetSecretCache();
}

function withoutMasterKey() {
  delete process.env[MASTER_KEY_ENV];
  resetSecretCache();
}

describe('密钥加解密（AES-256-GCM）', () => {
  beforeEach(withMasterKey);
  afterEach(() => {
    delete process.env.TEST_ENV_KEY;
    withoutMasterKey();
  });

  test('各种明文都能原样解回来', () => {
    const samples = [
      'sk-1234567890abcdef',
      '普通中文密钥-测试',
      'a'.repeat(2000),
      '含空格 和 : 冒号 的 key',
      'emoji-🔑-key'
    ];

    for (const plain of samples) {
      const cipher = encryptSecret(plain);
      assert.ok(isEncrypted(cipher), `应带 ${ENCRYPTED_PREFIX} 前缀`);
      assert.notStrictEqual(cipher, plain);
      assert.ok(!cipher.includes(plain), '密文里不应出现明文');
      assert.strictEqual(decryptSecret(cipher), plain);
    }
  });

  test('每次加密的 IV 都不同，但都能解回同一明文', () => {
    const plain = 'sk-same-key';
    const first = encryptSecret(plain);
    const second = encryptSecret(plain);

    assert.notStrictEqual(first, second, '同一明文两次密文必须不同（随机 IV）');
    assert.strictEqual(decryptSecret(first), plain);
    assert.strictEqual(decryptSecret(second), plain);
  });

  test('密文被篡改：解密失败而不是解出垃圾', () => {
    const cipher = encryptSecret('sk-tamper-me');
    const parts = cipher.split(':');
    const lastIndex = parts.length - 1;
    // 改掉密文段的最后一个字符
    const tampered = [...parts.slice(0, lastIndex), parts[lastIndex].slice(0, -2) + 'AA'].join(':');

    assert.throws(() => decryptSecret(tampered), (error) => {
      assert.ok(error instanceof SecretsError);
      assert.strictEqual(error.code, 'DECRYPT_FAILED');
      return true;
    });
  });

  test('格式不对的密文给出 INVALID_CIPHERTEXT', () => {
    assert.throws(() => decryptSecret('不是密文'), /不是本模块生成的密文/);
    assert.throws(
      () => decryptSecret('enc:v1:只有一段'),
      (error) => error.code === 'INVALID_CIPHERTEXT'
    );
  });

  test('没配主密钥：拒绝加密，也拒绝解密', () => {
    withoutMasterKey();
    assert.strictEqual(hasMasterKey(), false);
    assert.strictEqual(getMasterKey(), null);

    assert.throws(() => encryptSecret('sk-x'), (error) => {
      assert.ok(error instanceof SecretsError);
      assert.strictEqual(error.code, 'NO_MASTER_KEY');
      return true;
    });

    withMasterKey();
    const cipher = encryptSecret('sk-x');
    withoutMasterKey();
    assert.throws(() => decryptSecret(cipher), (error) => error.code === 'NO_MASTER_KEY');
  });

  test('同一口令派生结果稳定：清掉缓存后仍能解之前写的密文', () => {
    const cipher = encryptSecret('sk-stable');
    resetSecretCache();
    assert.strictEqual(decryptSecret(cipher), 'sk-stable');
  });

  test('换主密钥后旧密文解不开（本期不做密钥轮换）', () => {
    const cipher = encryptSecret('sk-rotate');
    process.env[MASTER_KEY_ENV] = 'a-completely-different-secret';
    resetSecretCache();

    assert.throws(() => decryptSecret(cipher), (error) => error.code === 'DECRYPT_FAILED');
  });

  test('64 位十六进制直接当密钥用（跳过 scrypt）', () => {
    process.env[MASTER_KEY_ENV] = 'a'.repeat(64);
    resetSecretCache();

    const key = getMasterKey();
    assert.strictEqual(key.length, 32);
    const cipher = encryptSecret('sk-hex');
    assert.strictEqual(decryptSecret(cipher), 'sk-hex');
  });
});

describe('密钥脱敏', () => {
  test('长 key 保留前 4 后 4，中间省略', () => {
    assert.strictEqual(maskSecret('sk-1234567890abcdef'), 'sk-1…cdef');
  });

  test('短 key 一律 ****，避免脱敏后反而能拼出来', () => {
    assert.strictEqual(maskSecret('short'), '****');
    assert.strictEqual(maskSecret('12345678'), '****');
  });

  test('空值返回空串', () => {
    assert.strictEqual(maskSecret(''), '');
    assert.strictEqual(maskSecret(null), '');
    assert.strictEqual(maskSecret(undefined), '');
  });
});

describe('解析运行时密钥', () => {
  beforeEach(withMasterKey);
  afterEach(() => {
    delete process.env.TEST_ENV_KEY;
    delete process.env.TEST_ENV_KEY_2;
    withoutMasterKey();
  });

  test('环境变量引用：DB 里只有变量名，明文来自进程环境', () => {
    process.env.TEST_ENV_KEY = 'sk-from-env';

    const config = { apiKeyRefs: ['TEST_ENV_KEY'] };
    const { keys, sources } = resolveApiKeyEntries(config);

    assert.deepStrictEqual(keys, ['sk-from-env']);
    assert.deepStrictEqual(sources, ['env:TEST_ENV_KEY']);
    assert.ok(!JSON.stringify(config).includes('sk-from-env'), '配置对象里不应有明文');
  });

  test('引用的环境变量没设置：跳过并给警告', () => {
    const { keys, warnings } = resolveApiKeyEntries({ apiKeyRefs: ['TEST_ENV_KEY_MISSING'] });

    assert.deepStrictEqual(keys, []);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /TEST_ENV_KEY_MISSING/);
  });

  test('非法环境变量名被忽略', () => {
    const { keys, warnings } = resolveApiKeyEntries({ apiKeyRefs: ['1-bad-name', 'has space'] });

    assert.deepStrictEqual(keys, []);
    assert.strictEqual(warnings.length, 2);
    assert.ok(isEnvRefName('GOOD_NAME'));
    assert.ok(!isEnvRefName('1-BAD'));
    assert.ok(!isEnvRefName('has space'));
  });

  test('密文解密后用；坏密文跳过不抛错（不能一把坏 key 把网关带崩）', () => {
    const good = encryptSecret('sk-good');
    const { keys, warnings } = resolveApiKeyEntries({ apiKeysEnc: [good, 'enc:v1:坏数据:坏数据:坏数据'] });

    assert.deepStrictEqual(keys, ['sk-good']);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /解密失败/);
  });

  test('旧明文兼容：source 标成 legacy-plaintext', () => {
    const { keys, sources } = resolveApiKeyEntries({ apiKey: 'sk-legacy', apiKeys: ['sk-legacy-2', ''] });

    assert.deepStrictEqual(keys, ['sk-legacy-2', 'sk-legacy']);
    assert.deepStrictEqual(sources, ['legacy-plaintext', 'legacy-plaintext']);
  });

  test('优先级：环境变量引用 > 密文 > 旧明文', () => {
    process.env.TEST_ENV_KEY = 'sk-env';

    const { keys, sources } = resolveApiKeyEntries({
      apiKeyRefs: ['TEST_ENV_KEY'],
      apiKeysEnc: [encryptSecret('sk-enc')],
      apiKeys: ['sk-legacy']
    });

    assert.deepStrictEqual(keys, ['sk-env', 'sk-enc', 'sk-legacy']);
    assert.deepStrictEqual(sources, ['env:TEST_ENV_KEY', 'encrypted', 'legacy-plaintext']);
  });

  test('同一把 key 出现在多个来源时只保留第一次', () => {
    process.env.TEST_ENV_KEY = 'sk-dup';
    const { keys } = resolveApiKeyEntries({
      apiKeyRefs: ['TEST_ENV_KEY'],
      apiKeysEnc: [encryptSecret('sk-dup')],
      apiKeys: ['sk-dup']
    });

    assert.deepStrictEqual(keys, ['sk-dup']);
  });

  test('hydrateConfig 让插件照旧读 apiKeys，明文只在内存', () => {
    const runtime = hydrateConfig({ endpoint: 'http://x', apiKeysEnc: [encryptSecret('sk-mem')] });

    assert.deepStrictEqual(resolveApiKeys(runtime), ['sk-mem']);
    assert.strictEqual(runtime.apiKey, 'sk-mem');
    assert.deepStrictEqual(runtime.apiKeys, ['sk-mem']);
    assert.deepStrictEqual(runtime.apiKeySources, ['encrypted']);
  });

  test('toPersistableConfig 物理剔除明文字段', () => {
    const persisted = toPersistableConfig({
      endpoint: 'http://x',
      apiKey: 'sk-plain',
      apiKeys: ['sk-plain'],
      apiKeySources: ['encrypted'],
      apiKeysEnc: ['enc:v1:aaa:bbb:ccc']
    });

    assert.deepStrictEqual(persisted, { endpoint: 'http://x', apiKeysEnc: ['enc:v1:aaa:bbb:ccc'] });
    assert.ok(!JSON.stringify(persisted).includes('sk-plain'));
  });
});

describe('写入前收口（sealIncomingConfig）', () => {
  beforeEach(withMasterKey);
  afterEach(() => {
    delete process.env.TEST_ENV_KEY;
    withoutMasterKey();
  });

  test('明文 apiKeys 当场加密，落库对象里没有明文', () => {
    const sealed = sealIncomingConfig({ endpoint: 'http://x', apiKeys: ['sk-write-1', 'sk-write-2'] });

    assert.strictEqual(sealed.apiKeysEnc.length, 2);
    assert.deepStrictEqual(sealed.apiKeyRefs, []);
    assert.strictEqual(sealed.apiKey, undefined);
    assert.strictEqual(sealed.apiKeys, undefined);
    assert.ok(!JSON.stringify(sealed).includes('sk-write'), '落库对象里不能出现明文');
    assert.deepStrictEqual(sealed.apiKeysEnc.map(decryptSecret), ['sk-write-1', 'sk-write-2']);
  });

  test('旧写法单个 apiKey 也会被加密', () => {
    const sealed = sealIncomingConfig({ apiKey: 'sk-single' });

    assert.strictEqual(sealed.apiKeysEnc.length, 1);
    assert.strictEqual(decryptSecret(sealed.apiKeysEnc[0]), 'sk-single');
  });

  test('传空数组 = 明确清空密钥', () => {
    const sealed = sealIncomingConfig({ apiKeys: [] });

    assert.deepStrictEqual(sealed.apiKeysEnc, []);
    assert.deepStrictEqual(sealed.apiKeyRefs, []);
  });

  test('没配主密钥时拒绝写明文（fail-closed）', () => {
    withoutMasterKey();

    assert.throws(() => sealIncomingConfig({ apiKeys: ['sk-nope'] }), (error) => {
      assert.ok(error instanceof SecretsError);
      assert.strictEqual(error.code, 'NO_MASTER_KEY');
      assert.match(error.message, /apiKeyRefs/);
      return true;
    });
  });

  test('没配主密钥但走环境变量引用：允许（密钥本来就不落库）', () => {
    withoutMasterKey();
    process.env.TEST_ENV_KEY = 'sk-env-only';

    const sealed = sealIncomingConfig({ apiKeyRefs: ['TEST_ENV_KEY'] });
    assert.deepStrictEqual(sealed.apiKeyRefs, ['TEST_ENV_KEY']);
  });

  test('非法引用名直接报错', () => {
    assert.throws(
      () => sealIncomingConfig({ apiKeyRefs: ['bad name'] }),
      (error) => error.code === 'INVALID_REF_NAME'
    );
  });

  test('引用与明文同时给出：以引用为准，密文清空', () => {
    process.env.TEST_ENV_KEY = 'sk-env';

    const sealed = sealIncomingConfig({ apiKeyRefs: ['TEST_ENV_KEY'], apiKeys: ['sk-should-be-ignored'] });
    assert.deepStrictEqual(sealed.apiKeyRefs, ['TEST_ENV_KEY']);
    assert.deepStrictEqual(sealed.apiKeysEnc, []);
    assert.ok(!JSON.stringify(sealed).includes('sk-should-be-ignored'));
  });

  test('sealPersistedConfig：库里旧明文在改配置时被自动加密，不丢钥匙', () => {
    const legacyRuntime = hydrateConfig({ endpoint: 'http://old', apiKeys: ['sk-legacy-keep'] });
    assert.deepStrictEqual(legacyRuntime.apiKeys, ['sk-legacy-keep']);

    const sealed = sealPersistedConfig(legacyRuntime);
    assert.strictEqual(sealed.apiKeysEnc.length, 1);
    assert.strictEqual(decryptSecret(sealed.apiKeysEnc[0]), 'sk-legacy-keep');
    assert.ok(!JSON.stringify(sealed).includes('sk-legacy-keep'));
  });

  test('sealPersistedConfig：已有密文时只丢掉运行时明文残留，不重复加密', () => {
    const runtime = hydrateConfig({ apiKeysEnc: [encryptSecret('sk-already')] });
    const sealed = sealPersistedConfig(runtime);

    assert.deepStrictEqual(sealed.apiKeysEnc, runtime.apiKeysEnc);
    assert.strictEqual(sealed.apiKeys, undefined);
  });
});

describe('对外输出脱敏（sanitizeConfigForOutput）', () => {
  beforeEach(withMasterKey);
  afterEach(withoutMasterKey);

  test('密文运行时：输出不含明文也不含密文，只给脱敏串与 keyCount', () => {
    const runtime = hydrateConfig({
      endpoint: 'http://x',
      apiKeysEnc: [encryptSecret('sk-1234567890abcdef')]
    });
    const output = sanitizeConfigForOutput(runtime);

    assert.strictEqual(output.endpoint, 'http://x');
    assert.deepStrictEqual(output.apiKeys, ['sk-1…cdef']);
    assert.strictEqual(output.apiKey, 'sk-1…cdef');
    assert.strictEqual(output.keyCount, 1);
    assert.strictEqual(output.apiKeysEnc, undefined, '密文不应出现在输出里');

    const json = JSON.stringify(output);
    assert.ok(!json.includes('sk-1234567890abcdef'));
    assert.ok(!json.includes(ENCRYPTED_PREFIX.replace(/:$/, '')));
  });

  test('旧明文运行时：同样脱敏', () => {
    const output = sanitizeConfigForOutput({ apiKeys: ['sk-abcdefghijkl'] });

    assert.deepStrictEqual(output.apiKeys, ['sk-a…ijkl']);
    assert.ok(!JSON.stringify(output).includes('sk-abcdefghijkl'));
  });

  test('未配置通道：keyCount 为 0，字段保持空串/空数组', () => {
    const output = sanitizeConfigForOutput({ endpoint: '', model: '' });

    assert.strictEqual(output.keyCount, 0);
    assert.strictEqual(output.apiKey, '');
    assert.deepStrictEqual(output.apiKeys, []);
    assert.deepStrictEqual(output.apiKeyRefs, []);
  });
});

describe('存量迁移（migrateConfig）', () => {
  beforeEach(withMasterKey);
  afterEach(withoutMasterKey);

  test('明文 → 密文，且幂等（第二次报告无改动）', () => {
    const legacy = { endpoint: 'http://x', model: 'm', apiKey: '', apiKeys: ['sk-old-1', 'sk-old-2'] };

    const first = migrateConfig(legacy);
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.keyCount, 2);
    assert.strictEqual(first.config.apiKeysEnc.length, 2);
    assert.strictEqual(first.config.apiKeys, undefined);
    assert.strictEqual(first.config.apiKey, undefined);
    assert.deepStrictEqual(first.config.apiKeysEnc.map(decryptSecret), ['sk-old-1', 'sk-old-2']);

    const second = migrateConfig(first.config);
    assert.strictEqual(second.changed, false, '重复迁移必须是幂等的');
    assert.deepStrictEqual(second.config, first.config);

    // 迁移后的配置仍能正常解析出明文
    assert.deepStrictEqual(resolveApiKeys(first.config), ['sk-old-1', 'sk-old-2']);
  });

  test('已是环境变量引用的通道：只丢弃明文残留', () => {
    const result = migrateConfig({ apiKeyRefs: ['TEST_ENV_KEY'], apiKeys: ['sk-runtime-leftover'] });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.keyCount, 0);
    assert.deepStrictEqual(result.config.apiKeyRefs, ['TEST_ENV_KEY']);
    assert.ok(!JSON.stringify(result.config).includes('sk-runtime-leftover'));
  });

  test('没配主密钥时迁移失败，不会写入任何东西', () => {
    withoutMasterKey();

    assert.throws(
      () => migrateConfig({ apiKeys: ['sk-no-key'] }),
      (error) => error.code === 'NO_MASTER_KEY'
    );
  });

  test('没有密钥的通道无需迁移', () => {
    const result = migrateConfig({ endpoint: 'http://x', model: 'm' });

    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.keyCount, 0);
  });
});

describe('data/ 目录不入库（验收第 3 条）', () => {
  test('.gitignore 仍然排除 data/ 与 .env', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf-8');
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());

    assert.ok(lines.includes('data/'), '.gitignore 必须继续排除 data/');
    assert.ok(lines.includes('.env'), '.gitignore 必须继续排除 .env');
  });
});
