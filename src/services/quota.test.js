import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initDb, getDb, closeDb } from '../db/index.js';
import { createToken, listTokens, refreshToken, updateQuota, checkQuota, getTokenByToken, evalQuotaWarning } from './quota.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-quota.db');
process.env.DB_PATH = TEST_DB_PATH;

describe('Quota Service', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
    initDb();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
  });

  test('创建令牌', () => {
    const token = createToken('Test Project', 100);
    
    assert.ok(token.id);
    assert.ok(token.token);
    assert.strictEqual(token.projectName, 'Test Project');
    assert.strictEqual(token.quotaLimit, 100);
    assert.strictEqual(token.usedCount, 0);
  });

  test('获取令牌', () => {
    const created = createToken('Test Project', 100);
    const retrieved = getTokenByToken(created.token);
    
    assert.ok(retrieved);
    assert.strictEqual(retrieved.id, created.id);
    assert.strictEqual(retrieved.project_name, 'Test Project');
  });

  test('刷新令牌', () => {
    const created = createToken('Test Project', 100);
    const oldToken = created.token;
    
    const refreshed = refreshToken(created.id);
    
    assert.notStrictEqual(refreshed.token, oldToken);
    assert.strictEqual(refreshed.id, created.id);
    assert.strictEqual(refreshed.project_name, 'Test Project');
  });

  test('更新配额', () => {
    const created = createToken('Test Project', 100);
    
    const updated = updateQuota(created.id, 500);
    
    assert.strictEqual(updated.quota_limit, 500);
  });

  test('配额检查：未超限', () => {
    const created = createToken('Test Project', 100);
    const tokenRow = getTokenByToken(created.token);
    
    const result = checkQuota(tokenRow);
    
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.used, 0);
    assert.strictEqual(result.limit, 100);
  });

  test('配额检查：已超限', () => {
    const created = createToken('Test Project', 10);
    const db = getDb();
    
    // 模拟使用 15 token
    db.prepare('UPDATE tokens SET token_used = 15 WHERE id = ?').run(created.id);
    
    const tokenRow = getTokenByToken(created.token);
    const result = checkQuota(tokenRow);
    
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'quota_exceeded');
  });

  test('配额检查：无效令牌', () => {
    const result = checkQuota(null);
    
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'invalid_token');
  });
});
describe('evalQuotaWarning（配额阈值告警判定，CONTRACT §2）', () => {
  test('跨越阈值的那次请求触发告警', () => {
    const r = evalQuotaWarning(70, 100, 10, 80);
    assert.strictEqual(r.shouldWarn, true);
    assert.strictEqual(r.afterPercent, 80);
  });

  test('已超阈值后继续用量不重复告警', () => {
    const r = evalQuotaWarning(85, 100, 5, 80);
    assert.strictEqual(r.shouldWarn, false);
  });

  test('增量未达阈值不告警', () => {
    const r = evalQuotaWarning(70, 100, 5, 80);
    assert.strictEqual(r.shouldWarn, false);
  });

  test('边界：恰好 100% 阈值可配置', () => {
    assert.strictEqual(evalQuotaWarning(90, 100, 10, 100).shouldWarn, true);
    assert.strictEqual(evalQuotaWarning(90, 100, 5, 100).shouldWarn, false);
  });

  test('边界：limit 缺省按 1 亿，addedTokens 为 0 不告警', () => {
    assert.strictEqual(evalQuotaWarning(0, 0, 5, 80).shouldWarn, false);
    assert.strictEqual(evalQuotaWarning(99999999, null, 0, 80).shouldWarn, false);
  });
});
