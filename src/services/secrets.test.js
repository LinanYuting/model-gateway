// 密钥存储安全化（任务 1.3）单元测试
// 只测 src/services/secrets.js 本身，不碰数据库。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  MASTER_KEY_ENV,
  MASTER_KEY_PREVIOUS_ENV,
  ALLOW_MISSING_ENV_REFS_ENV,
  ENCRYPTED_PREFIX,
  RESERVED_ENV_REF_NAMES,
  SecretsError,
  hasMasterKey,
  getMasterKey,
  getPreviousMasterKey,
  getMasterKeyId,
  resetSecretCache,
  isEncrypted,
  isEnvRefName,
  isReservedEnvRefName,
  assertEnvRefName,
  missingApiKeyRefs,
  encryptSecret,
  decryptSecret,
  decryptSecretWithInfo,
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

// ---------------------------------------------------------------------------
// 第二轮安全审查（2026-11-28）
// ---------------------------------------------------------------------------

describe('环境变量引用限制（安全审查 3）', () => {
  beforeEach(() => {
    withMasterKey();
    process.env.SPONSORED_KEY_1 = 'sk-sponsored-1';
    process.env.AIPING_KEY_1 = 'sk-aiping-1';
  });

  afterEach(() => {
    delete process.env.SPONSORED_KEY_1;
    delete process.env.AIPING_KEY_1;
    delete process.env.SOME_MISSING_KEY_1;
    delete process.env[ALLOW_MISSING_ENV_REFS_ENV];
    delete process.env.TEST_ENV_KEY;
    withoutMasterKey();
  });

  test('内部敏感变量一律拒绝引用（GATEWAY_SECRET / ADMIN_TOKEN / DATABASE_PASSWORD）', () => {
    for (const name of ['GATEWAY_SECRET', 'GATEWAY_SECRET_PREVIOUS', 'ADMIN_TOKEN', 'DATABASE_PASSWORD']) {
      assert.throws(
        () => sealIncomingConfig({ apiKeyRefs: [name] }),
        (error) => {
          assert.ok(error instanceof SecretsError);
          assert.strictEqual(error.code, 'RESERVED_REF_NAME', `${name} 应被拒绝`);
          return true;
        }
      );
    }
    // 这几个确实都在保留名单里（防止以后有人把名单改空）
    for (const name of ['GATEWAY_SECRET', 'ADMIN_TOKEN', 'DATABASE_PASSWORD']) {
      assert.ok(RESERVED_ENV_REF_NAMES.includes(name));
      assert.strictEqual(isReservedEnvRefName(name), true);
    }
  });

  test('名字里带 SECRET / PASSWORD，或以 GATEWAY_ 开头，也拒绝', () => {
    for (const name of ['MY_SECRET_KEY', 'AIPING_PASSWORD', 'GATEWAY_FOO', 'X_CREDENTIAL_Y', 'APP_PRIVATE_KEY']) {
      assert.strictEqual(isReservedEnvRefName(name), true, `${name} 应被拒绝`);
      assert.throws(() => assertEnvRefName(name), (error) => error.code === 'RESERVED_REF_NAME');
    }
  });

  test('正常业务变量名（*_KEY_n）不受影响', () => {
    for (const name of ['SPONSORED_KEY_1', 'AIPING_KEY_1', 'TEST_ENV_KEY']) {
      assert.strictEqual(isReservedEnvRefName(name), false);
      assert.strictEqual(assertEnvRefName(` ${name} `), name, '应返回去掉空白后的名字');
    }
    assert.deepStrictEqual(
      sealIncomingConfig({ apiKeyRefs: ['SPONSORED_KEY_1'] }).apiKeyRefs,
      ['SPONSORED_KEY_1']
    );
  });

  test('格式不合法的引用名仍是 INVALID_REF_NAME', () => {
    assert.throws(
      () => sealIncomingConfig({ apiKeyRefs: ['1INVALID'] }),
      (error) => error.code === 'INVALID_REF_NAME'
    );
  });

  test('引用的环境变量不存在 → ENV_REF_NOT_FOUND（明确报错，不静默跳过）', () => {
    assert.throws(
      () => sealIncomingConfig({ apiKeyRefs: ['SPONSORED_KEY_1', 'SOME_MISSING_KEY_1'] }),
      (error) => {
        assert.strictEqual(error.code, 'ENV_REF_NOT_FOUND');
        assert.match(error.message, /SOME_MISSING_KEY_1/);
        assert.ok(!error.message.includes('SPONSORED_KEY_1'), '已存在的变量不该出现在报错里');
        return true;
      }
    );
  });

  test('变量存在但值为空也算"没配"', () => {
    process.env.SOME_MISSING_KEY_1 = '   ';
    assert.throws(
      () => sealIncomingConfig({ apiKeyRefs: ['SOME_MISSING_KEY_1'] }),
      (error) => error.code === 'ENV_REF_NOT_FOUND'
    );
  });

  test('显式设 ALLOW_MISSING_ENV_REFS=true 时允许"先写配置后注入密钥"', () => {
    process.env[ALLOW_MISSING_ENV_REFS_ENV] = 'true';
    const sealed = sealIncomingConfig({ apiKeyRefs: ['SOME_MISSING_KEY_1'] });

    assert.deepStrictEqual(sealed.apiKeyRefs, ['SOME_MISSING_KEY_1']);
    // 但运行时解析不到值，并标记为缺失
    const runtime = hydrateConfig(sealed);
    assert.deepStrictEqual(runtime.apiKeys, []);
    assert.deepStrictEqual(runtime.apiKeyRefsMissing, ['SOME_MISSING_KEY_1']);
  });

  test('存量库里若已有敏感引用，运行时拒绝解析（不因为旧数据放行）', () => {
    const { keys, warnings } = resolveApiKeyEntries({ apiKeyRefs: ['GATEWAY_SECRET'] });

    assert.deepStrictEqual(keys, []);
    assert.ok(warnings.some((warning) => warning.includes('内部敏感变量')));
  });

  test('missingApiKeyRefs 只报缺失的变量名，不返回值', () => {
    const missing = missingApiKeyRefs({ apiKeyRefs: ['SPONSORED_KEY_1', 'SOME_MISSING_KEY_1'] });

    assert.deepStrictEqual(missing, ['SOME_MISSING_KEY_1']);
    assert.ok(!JSON.stringify(missing).includes('sk-sponsored-1'));
  });
});

describe('主密钥指纹与轮换过渡（安全审查 2 / 5）', () => {
  afterEach(() => {
    delete process.env[MASTER_KEY_ENV];
    delete process.env[MASTER_KEY_PREVIOUS_ENV];
    resetSecretCache();
  });

  test('指纹是 8 位十六进制、稳定、可区分不同主密钥，且不是密钥本身', () => {
    withMasterKey();
    const first = getMasterKeyId();
    assert.match(first, /^[0-9a-f]{8}$/);
    assert.strictEqual(getMasterKeyId(), first, '同一把主密钥指纹应稳定');
    assert.ok(!TEST_SECRET.includes(first) && first !== TEST_SECRET.slice(0, 8), '指纹不能是密钥明文片段');

    process.env[MASTER_KEY_ENV] = 'another-master-secret';
    resetSecretCache();
    assert.notStrictEqual(getMasterKeyId(), first);
  });

  test('密文只带版本号、不嵌指纹（轮换只能全量重加密，设计如此）', () => {
    withMasterKey();
    const cipher = encryptSecret('sk-format-check');

    assert.ok(cipher.startsWith(ENCRYPTED_PREFIX));
    assert.strictEqual(cipher.slice(ENCRYPTED_PREFIX.length).split(':').length, 3);
    assert.ok(!cipher.includes(getMasterKeyId()));
  });

  test('配了 GATEWAY_SECRET_PREVIOUS：旧密文仍能解开并标记 usedPreviousKey', () => {
    withMasterKey();
    const oldCipher = encryptSecret('sk-before-rotation');

    // 模拟轮换：新主密钥 + 旧主密钥放进 PREVIOUS
    process.env[MASTER_KEY_ENV] = 'brand-new-master-secret';
    process.env[MASTER_KEY_PREVIOUS_ENV] = TEST_SECRET;
    resetSecretCache();

    const info = decryptSecretWithInfo(oldCipher);
    assert.strictEqual(info.plain, 'sk-before-rotation');
    assert.strictEqual(info.usedPreviousKey, true);
    assert.strictEqual(decryptSecret(oldCipher), 'sk-before-rotation');

    // 新密文用当前主密钥，不应走 PREVIOUS
    const newCipher = encryptSecret('sk-after-rotation');
    assert.strictEqual(decryptSecretWithInfo(newCipher).usedPreviousKey, false);
  });

  test('没配 GATEWAY_SECRET_PREVIOUS 时旧密文解不开（DECRYPT_FAILED，不吐明文）', () => {
    withMasterKey();
    const oldCipher = encryptSecret('sk-old');

    process.env[MASTER_KEY_ENV] = 'brand-new-master-secret';
    resetSecretCache();

    assert.throws(
      () => decryptSecret(oldCipher),
      (error) => {
        assert.strictEqual(error.code, 'DECRYPT_FAILED');
        assert.ok(!error.message.includes('sk-old'));
        return true;
      }
    );
  });

  test('getPreviousMasterKey 没配时返回 null', () => {
    withMasterKey();
    assert.strictEqual(getPreviousMasterKey(), null);
  });

  test('错误信息里不出现主密钥与明文（不落普通日志的前提）', () => {
    withMasterKey();
    const cipher = encryptSecret('sk-error-check');

    const errors = [];
    try { decryptSecret('not-a-cipher'); } catch (error) { errors.push(error); }
    try { decryptSecret(cipher.slice(0, -4) + 'AAAA'); } catch (error) { errors.push(error); }
    const savedSecret = process.env[MASTER_KEY_ENV];
    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();
    try { decryptSecret(cipher); } catch (error) { errors.push(error); }
    process.env[MASTER_KEY_ENV] = savedSecret;
    resetSecretCache();

    assert.strictEqual(errors.length, 3);
    for (const error of errors) {
      const text = `${error.name}: ${error.message}`;
      assert.ok(!text.includes('sk-error-check'), '错误信息不得含明文密钥');
      assert.ok(!text.includes(savedSecret), '错误信息不得含主密钥');
    }
  });

  test('hydrateConfig 暴露缺失引用；落库与对外输出都不带它', () => {
    withMasterKey();
    const runtime = hydrateConfig({ apiKeyRefs: ['SOME_MISSING_KEY_1'] });

    assert.deepStrictEqual(runtime.apiKeyRefsMissing, ['SOME_MISSING_KEY_1']);
    assert.strictEqual(toPersistableConfig(runtime).apiKeyRefsMissing, undefined);

    const output = sanitizeConfigForOutput(runtime);
    assert.deepStrictEqual(output.missingApiKeyRefs, ['SOME_MISSING_KEY_1']);
    assert.strictEqual(output.apiKeyRefsMissing, undefined);
  });
});
