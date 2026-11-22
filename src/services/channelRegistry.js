import { getDb } from '../db/index.js';
import { FreeChannel } from '../channels/FreeChannel.js';
import { SponsoredChannel } from '../channels/SponsoredChannel.js';
import { AipingChannel } from '../channels/AipingChannel.js';

const channelInstances = new Map();

export function loadChannels() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM channels').all();
  
  channelInstances.clear();
  
  for (const row of rows) {
    let channel;
    switch (row.type) {
      case 'free':
        channel = new FreeChannel(row.id, row.name, row.enabled === 1, JSON.parse(row.config_json || '{}'));
        break;
      case 'sponsored':
        channel = new SponsoredChannel(row.id, row.name, row.enabled === 1, JSON.parse(row.config_json || '{}'));
        break;
      case 'aiping':
        channel = new AipingChannel(row.id, row.name, row.enabled === 1, JSON.parse(row.config_json || '{}'));
        break;
      default:
        continue;
    }
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
  
  const newConfig = { ...channel.getConfig(), ...config };
  channel.setConfig(newConfig);
  
  db.prepare('UPDATE channels SET config_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(JSON.stringify(newConfig), id);
  
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