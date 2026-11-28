// 密钥存储安全化（阶段2 任务 1.3）
//
// 目标：channels.config_json 里不再出现明文 API key。
//
// 两种可落库形态（二选一，同一通道只用一种）：
//   1) apiKeysEnc: string[]   —— 密文，算法 AES-256-GCM，格式 `enc:v1:<iv>:<tag>:<密文>`
//   2) apiKeyRefs: string[]   —— 环境变量“名字”（如 SPONSORED_KEY_1），运行时从 process.env 取值，
//                                密钥本身根本不落库
//
// 主密钥取环境变量 GATEWAY_SECRET，用 scrypt 派生 32 字节。
// 没配主密钥时**拒绝写明文**（fail-closed），绝不退回明文存储。
//
// 存量兼容：旧的 apiKey / apiKeys 明文仍然可读（第三优先级），但只当作过渡路径，
// 由 scripts/migrate-secrets.mjs 一次性加密改写，或在管理员改配置时自动加密。

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';

/** 主密钥所在的环境变量名 */
export const MASTER_KEY_ENV = 'GATEWAY_SECRET';
/** 密文前缀，带版本号方便以后换算法 */
export const ENCRYPTED_PREFIX = 'enc:v1:';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM 推荐 96 位
const KDF_SALT = 'model-gateway:secrets:v1';
const ENV_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 密钥相关错误：带 code 便于路由层区分是“没配主密钥”还是“格式不对” */
export class SecretsError extends Error {
  constructor(message, code = 'SECRETS_ERROR') {
    super(message);
    this.name = 'SecretsError';
    this.code = code;
  }
}

// 派生密钥有点慢（scrypt），按 secret 值缓存，换 secret 自动失效。
let cachedKey = null; // { secret, key }

/** 仅测试用：清掉派生密钥缓存 */
export function resetSecretCache() {
  cachedKey = null;
}

/** 主密钥；没配或为空返回 null */
export function getMasterKey() {
  const secret = String(process.env[MASTER_KEY_ENV] ?? '').trim();
  if (!secret) return null;
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;

  // 允许直接给 64 位十六进制密钥，省一次 scrypt；否则把口令拉伸成 32 字节
  const key = /^[0-9a-fA-F]{64}$/.test(secret)
    ? Buffer.from(secret, 'hex')
    : scryptSync(secret, KDF_SALT, KEY_BYTES);

  cachedKey = { secret, key };
  return key;
}

/** 是否配置了主密钥 */
export function hasMasterKey() {
  return getMasterKey() !== null;
}

/** 这个值是不是本模块产出的密文 */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/** 合法环境变量名（用作 apiKeyRefs 的元素） */
export function isEnvRefName(name) {
  return typeof name === 'string' && ENV_REF_PATTERN.test(name.trim());
}

/**
 * 加密一把 key。没配主密钥直接抛错——调用方必须处理，不允许悄悄写明文。
 * @param {string} plain
 * @returns {string} `enc:v1:<iv>:<tag>:<密文>`（base64url 段）
 */
export function encryptSecret(plain) {
  const key = getMasterKey();
  if (!key) {
    throw new SecretsError(
      `未配置 ${MASTER_KEY_ENV}，拒绝把明文密钥写入数据库；请先设置主密钥，或改用 apiKeyRefs 引用环境变量`,
      'NO_MASTER_KEY'
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTED_PREFIX + iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join(':');
}

/**
 * 解密。
 * @param {string} payload
 * @returns {string} 明文
 */
export function decryptSecret(payload) {
  if (!isEncrypted(payload)) {
    throw new SecretsError('不是本模块生成的密文（缺少 enc:v1: 前缀）', 'INVALID_CIPHERTEXT');
  }

  const key = getMasterKey();
  if (!key) {
    throw new SecretsError(`未配置 ${MASTER_KEY_ENV}，无法解密密钥`, 'NO_MASTER_KEY');
  }

  const parts = payload.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretsError('密文格式不正确，应为 enc:v1:<iv>:<tag>:<密文>', 'INVALID_CIPHERTEXT');
  }

  const [ivPart, tagPart, dataPart] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (_error) {
    // 换过主密钥、密文被改过、数据损坏都会走到这里
    throw new SecretsError('密钥解密失败：主密钥不匹配或密文已损坏', 'DECRYPT_FAILED');
  }
}

/**
 * 脱敏展示：`sk-1234567890abcd` → `sk-1…abcd`；太短的一律 `****`，避免“脱敏后反而能猜出来”。
 */
export function maskSecret(secret) {
  const s = String(secret ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

/** 旧格式明文（apiKeys 数组 + 单个 apiKey），已去空、去重、保序 */
function collectLegacyPlainKeys(config = {}) {
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) return;
    out.push(trimmed);
  };

  for (const item of toArray(config.apiKeys)) push(item);
  push(config.apiKey);
  return out;
}

/**
 * 把任意形态的配置解析成运行时明文 key 列表。
 * 优先级：环境变量引用 > 密文 > 旧明文（只为兼容存量）。
 *
 * 解析失败不抛错（不能让一把坏 key 把整个网关带崩），记进 warnings 由调用方决定怎么提示。
 *
 * @param {object} config
 * @returns {{ keys: string[], sources: string[], warnings: string[] }}
 */
export function resolveApiKeyEntries(config = {}) {
  /** @type {{key: string, source: string}[]} */
  const entries = [];
  const warnings = [];
  const seen = new Set();

  const push = (key, source) => {
    if (typeof key !== 'string') return;
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    entries.push({ key: trimmed, source });
  };

  // 1) 环境变量引用：密钥值不进数据库，DB 里只有变量名
  for (const ref of toArray(config.apiKeyRefs)) {
    if (!isEnvRefName(ref)) {
      warnings.push(`apiKeyRefs 中的 "${ref}" 不是合法的环境变量名，已忽略`);
      continue;
    }
    const name = ref.trim();
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      warnings.push(`环境变量 ${name} 未设置或为空，该引用已跳过`);
      continue;
    }
    push(value, `env:${name}`);
  }

  // 2) 密文
  for (const item of toArray(config.apiKeysEnc)) {
    try {
      push(decryptSecret(item), 'encrypted');
    } catch (error) {
      warnings.push(`密文解密失败已跳过：${error.message}`);
    }
  }

  // 3) 旧明文（过渡期兼容）
  for (const item of collectLegacyPlainKeys(config)) {
    push(item, 'legacy-plaintext');
  }

  return { keys: entries.map((entry) => entry.key), sources: entries.map((entry) => entry.source), warnings };
}

/** 只要明文数组 */
export function resolveApiKeys(config = {}) {
  return resolveApiKeyEntries(config).keys;
}

/**
 * 落库形态 → 运行时形态：配置里多一份解析好的明文 apiKeys，插件照旧读它。
 * 明文只活在进程内存，写库必须走 toPersistableConfig()。
 */
export function hydrateConfig(config = {}) {
  const { keys, sources } = resolveApiKeyEntries(config);
  return {
    ...config,
    apiKey: keys[0] || '',
    apiKeys: keys,
    apiKeySources: sources
  };
}

/** 运行时形态 → 落库形态：物理上剔除明文 key 与内部字段 */
export function toPersistableConfig(config = {}) {
  const out = { ...config };
  delete out.apiKey;
  delete out.apiKeys;
  delete out.apiKeySources;
  return out;
}

/**
 * 处理调用方新提交的配置：明文 apiKeys/apiKey 一律当场加密成 apiKeysEnc。
 * - 传空数组/空串 = 明确要清空密钥
 * - 没配主密钥就抛 SecretsError('NO_MASTER_KEY')
 * - apiKeyRefs 与 apiKeys 同时出现时以 apiKeyRefs 为准
 *
 * @returns {object} 可以合并进 config_json 的对象（不含明文）
 */
export function sealIncomingConfig(incoming = {}) {
  const sealed = toPersistableConfig(incoming);
  const hasInlineKeys = Object.prototype.hasOwnProperty.call(incoming, 'apiKey')
    || Object.prototype.hasOwnProperty.call(incoming, 'apiKeys');
  const hasRefs = Array.isArray(incoming.apiKeyRefs);

  if (hasRefs) {
    const refs = [];
    for (const ref of incoming.apiKeyRefs) {
      if (!isEnvRefName(ref)) {
        throw new SecretsError(
          `apiKeyRefs 中的 "${ref}" 不是合法的环境变量名（只允许字母、数字、下划线，且不能以数字开头）`,
          'INVALID_REF_NAME'
        );
      }
      const name = ref.trim();
      if (!refs.includes(name)) refs.push(name);
    }
    sealed.apiKeyRefs = refs;
    if (refs.length > 0) {
      // 引用优先：显式清掉密文，避免“环境变量 + 密文”两套来源同时生效
      sealed.apiKeysEnc = [];
    }
    return sealed;
  }

  if (!hasInlineKeys) return sealed;

  const plain = collectLegacyPlainKeys(incoming);
  if (plain.length === 0) {
    // 明确清空
    sealed.apiKeysEnc = [];
    sealed.apiKeyRefs = [];
    return sealed;
  }

  sealed.apiKeysEnc = plain.map((key) => encryptSecret(key));
  sealed.apiKeyRefs = [];
  return sealed;
}

/**
 * 更新配置时对「库里的旧配置」做一次收口：
 * 旧明文 key 若还没加密，就趁这次写入加密掉，既不会丢密钥，也不会把明文再写回去。
 */
export function sealPersistedConfig(config = {}) {
  const out = toPersistableConfig(config);
  const legacy = collectLegacyPlainKeys(config);
  if (legacy.length === 0) return out;

  const alreadyStored = (Array.isArray(out.apiKeysEnc) && out.apiKeysEnc.length > 0)
    || (Array.isArray(out.apiKeyRefs) && out.apiKeyRefs.length > 0);
  if (alreadyStored) return out; // 明文只是运行时解析出来的，丢掉即可

  out.apiKeysEnc = legacy.map((key) => encryptSecret(key)); // 没主密钥会抛，符合 fail-closed
  return out;
}

/**
 * 对外输出用的配置快照：密钥脱敏，密文与内部来源信息不外露。
 */
export function sanitizeConfigForOutput(config = {}) {
  const keys = resolveApiKeys(config);
  const out = toPersistableConfig(config);
  delete out.apiKeysEnc; // 密文也不该出现在任何接口响应里

  out.apiKey = keys[0] ? maskSecret(keys[0]) : '';
  out.apiKeys = keys.map(maskSecret);
  out.apiKeyRefs = Array.isArray(config.apiKeyRefs) ? [...config.apiKeyRefs] : [];
  out.keyCount = keys.length;
  return out;
}

/**
 * 存量配置迁移：明文 → 密文。幂等，已是密文/引用的原样返回 changed=false。
 * @returns {{ config: object, changed: boolean, keyCount: number }}
 */
export function migrateConfig(config = {}) {
  const legacy = collectLegacyPlainKeys(config);
  const hasRefs = Array.isArray(config.apiKeyRefs) && config.apiKeyRefs.length > 0;

  if (legacy.length === 0) {
    return { config: toPersistableConfig(config), changed: false, keyCount: 0 };
  }

  // 已经改用环境变量引用的通道：明文只是运行时解析残留，丢掉就行，不用加密
  if (hasRefs) {
    return { config: toPersistableConfig(config), changed: true, keyCount: 0 };
  }

  const encrypted = legacy.map((key) => encryptSecret(key)); // 没主密钥会抛
  return {
    config: { ...toPersistableConfig(config), apiKeysEnc: encrypted, apiKeyRefs: [] },
    changed: true,
    keyCount: legacy.length
  };
}
