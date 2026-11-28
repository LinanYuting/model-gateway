import { getDb } from '../db/index.js';
import { FreeChannel } from '../channels/FreeChannel.js';
import { SponsoredChannel } from '../channels/SponsoredChannel.js';
import { AipingChannel } from '../channels/AipingChannel.js';
import { hydrateConfig, sealIncomingConfig, sealPersistedConfig, resolveApiKeyEntries } from './secrets.js';

const channelInstances = new Map();

// 同一句密钥相关警告只打一次，避免每次 loadChannels / 每次请求刷屏
const warnedMessages = new Set();
function warnOnce(message) {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[Secrets] ${message}`);
}

/** 测试用：清掉“已警告”记录 */
export function resetSecretWarnings() {
  warnedMessages.clear();
}

/**
 * 库里的 config_json → 插件运行时配置。
 * 密钥在这里解密 / 读环境变量 / 兼容旧明文，明文只存在于进程内存。
 */
function buildRuntimeConfig(channelId, persistedConfig) {
  const { keys, sources, warnings } = resolveApiKeyEntries(persistedConfig);

  for (const warning of warnings) {
    warnOnce(`通道 ${channelId}: ${warning}`);
  }
  if (sources.includes('legacy-plaintext')) {
    warnOnce(`通道 ${channelId}: 检测到明文 API key，建议执行 node scripts/migrate-secrets.mjs 加密改写`);
  }

  return hydrateConfig(persistedConfig);
}

function createChannelInstance(row) {
  let persistedConfig;
  try {
    persistedConfig = JSON.parse(row.config_json || '{}');
  } catch (_error) {
    console.warn(`[ChannelRegistry] 通道 ${row.id} 的 config_json 不是合法 JSON，已按空配置处理`);
    persistedConfig = {};
  }

  const config = buildRuntimeConfig(row.id, persistedConfig);
  const enabled = row.enabled === 1;

  switch (row.type) {
    case 'free':
      return new FreeChannel(row.id, row.name, enabled, config);
    case 'sponsored':
      return new SponsoredChannel(row.id, row.name, enabled, config);
    case 'aiping':
      return new AipingChannel(row.id, row.name, enabled, config);
    default:
      return null;
  }
}

export function loadChannels() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM channels').all();

  channelInstances.clear();

  for (const row of rows) {
    const channel = createChannelInstance(row);
    if (!channel) continue;
    channelInstances.set(row.id, channel);
  }

  console.log('[ChannelRegistry] Loaded channels:', Array.from(channelInstances.keys()));
  return channelInstances;
}

export function getChannel(id) {
  return channelInstances.get(id);
}

export function listChannels() {
  return Array.from(channelInstances.values()).map(ch => ch.toJSON());
}

export function updateChannelConfig(id, config) {
  const db = getDb();
  const channel = channelInstances.get(id);

  if (!channel) {
    throw new Error(`Channel not found: ${id}`);
  }

  // 1) 调用方提交的明文密钥当场加密（没配主密钥会抛 SecretsError，绝不写明文）
  const sealed = sealIncomingConfig(config || {});

  // 2) 与库里的现有配置合并；旧明文趁这次写入一并加密，避免丢钥匙或把明文写回去
  const merged = { ...sealPersistedConfig(channel.getConfig()), ...sealed };

  // 3) 内存里换成解析后的形态，插件才能真的拿去请求上游（整体替换，避免上一轮的密钥字段残留）
  channel.replaceConfig(buildRuntimeConfig(id, merged));

  // 4) 落库对象由 toPersistableConfig 生成，物理上不含明文字段
  db.prepare('UPDATE channels SET config_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(JSON.stringify(merged), id);

  return channel.toJSON();
}

export function setChannelEnabled(id, enabled) {
  const db = getDb();
  const channel = channelInstances.get(id);

  if (!channel) {
    throw new Error(`Channel not found: ${id}`);
  }

  channel.setEnabled(enabled);

  db.prepare('UPDATE channels SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(enabled ? 1 : 0, id);

  return channel.toJSON();
}

export function deleteChannel(id) {
  const db = getDb();
  const channel = channelInstances.get(id);

  if (!channel) {
    throw new Error(`Channel not found: ${id}`);
  }

  // Delete from DB
  const result = db.prepare('DELETE FROM channels WHERE id = ?').run(id);

  // Remove from memory
  channelInstances.delete(id);

  return result.changes > 0;
}
