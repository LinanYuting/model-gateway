import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initDb, getDb, closeDb } from './index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 使用临时测试数据库
const TEST_DB_PATH = join(__dirname, '../data/test-gateway.db');
process.env.DB_PATH = TEST_DB_PATH;

describe('Database Layer', () => {
  beforeEach(() => {
    // 清理测试数据库
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
  });

  test('初始化数据库并创建表', () => {
    initDb();
    const db = getDb();
    
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    
    assert.ok(tableNames.includes('channels'));
    assert.ok(tableNames.includes('tokens'));
    assert.ok(tableNames.includes('call_logs'));
    assert.ok(tableNames.includes('alerts'));
    assert.ok(tableNames.includes('jev_decisions'));
  });

  test('种子数据：默认通道存在', () => {
    initDb();
    const db = getDb();
    
    const channels = db.prepare('SELECT * FROM channels').all();
    assert.strictEqual(channels.length, 3);
    assert.ok(channels.find(c => c.id === 'free'));
    assert.ok(channels.find(c => c.id === 'sponsored'));
    assert.ok(channels.find(c => c.id === 'aiping'));
  });

  test('WAL 模式已启用', () => {
    initDb();
    const db = getDb();
    const journalMode = db.pragma('journal_mode', { simple: true });
    assert.strictEqual(journalMode, 'wal');
  });
});