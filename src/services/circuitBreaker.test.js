import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initDb, getDb, closeDb } from '../db/index.js';
import { recordFailure, recordSuccess, isCircuitOpen, getCircuitStatus } from './circuitBreaker.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-breaker.db');
process.env.DB_PATH = TEST_DB_PATH;

describe('Circuit Breaker', () => {
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

  test('记录失败并打开熔断', () => {
    // 默认阈值 3
    assert.strictEqual(isCircuitOpen('free'), false);
    
    recordFailure('free');
    recordFailure('free');
    assert.strictEqual(isCircuitOpen('free'), false);
    
    recordFailure('free');
    assert.strictEqual(isCircuitOpen('free'), true);
  });

  test('记录成功重置熔断', () => {
    recordFailure('free');
    recordFailure('free');
    recordFailure('free');
    
    assert.strictEqual(isCircuitOpen('free'), true);
    
    recordSuccess('free');
    assert.strictEqual(isCircuitOpen('free'), false);
  });

  test('获取熔断状态', () => {
    recordFailure('free');
    
    const status = getCircuitStatus('free');
    
    assert.strictEqual(status.failureCount, 1);
    assert.strictEqual(status.circuitOpenUntil, null);
    assert.strictEqual(status.isOpen, false);
  });

  test('熔断冷却后自动恢复', async () => {
    recordFailure('free');
    recordFailure('free');
    recordFailure('free');
    
    assert.strictEqual(isCircuitOpen('free'), true);
    
    // 模拟时间流逝（手动设置 open_until 为过去时间）
    const db = getDb();
    db.prepare('UPDATE channels SET circuit_open_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), 'free');
    
    assert.strictEqual(isCircuitOpen('free'), false);
    assert.strictEqual(getCircuitStatus('free').failureCount, 0);
  });
});