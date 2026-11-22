import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';

export function createToken(projectName, quotaLimit = 100000000) {
  const db = getDb();
  const id = uuidv4();
  const token = uuidv4();
  
  db.prepare(`
    INSERT INTO tokens (id, token, project_name, quota_limit, used_count, token_used)
    VALUES (?, ?, ?, ?, 0, 0)
  `).run(id, token, projectName, quotaLimit);
  
  return { id, token, projectName, quotaLimit, usedCount: 0, tokenUsed: 0 };
}

export function getTokenByToken(token) {
  const db = getDb();
  return db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
}

export function getTokenById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
}

export function listTokens() {
  const db = getDb();
  return db.prepare('SELECT * FROM tokens').all();
}

export function refreshToken(id) {
  const db = getDb();
  const newToken = uuidv4();
  
  db.prepare('UPDATE tokens SET token = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newToken, id);
  
  return getTokenById(id);
}

export function updateQuota(id, quotaLimit) {
  const db = getDb();
  db.prepare('UPDATE tokens SET quota_limit = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(quotaLimit, id);
  return getTokenById(id);
}

export function checkQuota(tokenRow) {
  if (!tokenRow) return { allowed: false, reason: 'invalid_token' };
  const used = tokenRow.token_used || 0;
  const limit = tokenRow.quota_limit || 100000000;
  if (used >= limit) {
    return { allowed: false, reason: 'quota_exceeded', used, limit };
  }
  return { allowed: true, used, limit };
}

export function incrementUsage(tokenId, tokenCount = 0) {
  const db = getDb();
  // 增加请求次数计数（用于统计）
  // 增加 token 用量（tokenCount 为真实 LLM token 数）
  db.prepare('UPDATE tokens SET used_count = used_count + 1, token_used = token_used + ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(tokenCount, tokenId);
}

export function isQuotaExceeded(tokenRow) {
  const used = tokenRow.token_used || 0;
  const limit = tokenRow.quota_limit || 100000000;
  return used >= limit;
}

export function getWarnPercent() {
  const p = parseInt(process.env.QUOTA_WARN_PERCENT || '80', 10);
  return Number.isFinite(p) && p > 0 && p <= 100 ? p : 80;
}

// 本次增量是否使使用率跨越告警阈值（CONTRACT §2：仅跨越瞬间告警一次）
export function evalQuotaWarning(beforeUsed, limit, addedTokens, warnPercent = getWarnPercent()) {
  const effectiveLimit = limit || 100000000;
  if (!(effectiveLimit > 0) || !(addedTokens > 0)) return { shouldWarn: false, afterPercent: 0 };
  const threshold = effectiveLimit * warnPercent / 100;
  const before = beforeUsed || 0;
  const after = before + addedTokens;
  return {
    shouldWarn: before < threshold && after >= threshold,
    afterPercent: Math.floor((after / effectiveLimit) * 100)
  };
}

export function deleteToken(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  return result.changes > 0;
}