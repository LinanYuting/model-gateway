import { getDb } from '../db/index.js';
import { getChannel } from './channelRegistry.js';

const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '3');
const CIRCUIT_BREAKER_COOLDOWN_SEC = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_SEC || '60');

export function isCircuitOpen(channelId) {
  const db = getDb();
  const row = db.prepare('SELECT circuit_open_until, failure_count FROM channels WHERE id = ?').get(channelId);
  
  if (!row || !row.circuit_open_until) return false;
  
  const openUntil = new Date(row.circuit_open_until);
  const now = new Date();
  
  if (now >= openUntil) {
    // 冷却结束，重置
    db.prepare('UPDATE channels SET circuit_open_until = NULL, failure_count = 0, updated_at = datetime(\'now\') WHERE id = ?').run(channelId);
    return false;
  }
  
  return true;
}

export function recordFailure(channelId) {
  const db = getDb();
  const row = db.prepare('SELECT failure_count FROM channels WHERE id = ?').get(channelId);
  
  if (!row) return;
  
  const newCount = row.failure_count + 1;
  let openUntil = null;
  
  if (newCount >= CIRCUIT_BREAKER_THRESHOLD) {
    openUntil = new Date(Date.now() + CIRCUIT_BREAKER_COOLDOWN_SEC * 1000).toISOString();
  }
  
  db.prepare('UPDATE channels SET failure_count = ?, circuit_open_until = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newCount, openUntil, channelId);
  
  // 同步更新内存中的通道实例
  const channel = getChannel(channelId);
  if (channel) {
    channel.failureCount = newCount;
    channel.circuitOpenUntil = openUntil ? new Date(openUntil) : null;
  }
  
  if (openUntil) {
    console.log(`[CircuitBreaker] Channel ${channelId} circuit opened until ${openUntil}`);
  }
}

export function recordSuccess(channelId) {
  const db = getDb();
  db.prepare('UPDATE channels SET failure_count = 0, circuit_open_until = NULL, updated_at = datetime(\'now\') WHERE id = ?')
    .run(channelId);
  
  const channel = getChannel(channelId);
  if (channel) {
    channel.failureCount = 0;
    channel.circuitOpenUntil = null;
  }
}

export function getCircuitStatus(channelId) {
  const db = getDb();
  const row = db.prepare('SELECT failure_count, circuit_open_until FROM channels WHERE id = ?').get(channelId);
  return {
    failureCount: row?.failure_count || 0,
    circuitOpenUntil: row?.circuit_open_until || null,
    isOpen: isCircuitOpen(channelId)
  };
}