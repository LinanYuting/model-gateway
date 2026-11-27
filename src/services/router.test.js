import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initDb, getDb, closeDb } from '../db/index.js';
import { routeRequest, buildCandidatePool, JevRoute } from './router.js';
import { loadChannels, setChannelEnabled } from './channelRegistry.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-router.db');
process.env.DB_PATH = TEST_DB_PATH;

describe('Router', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
    initDb();
    loadChannels();
    // Enable all channels for testing
    const db = getDb();
    db.prepare('UPDATE channels SET enabled = 1').run();
    // Update in-memory instances
    setChannelEnabled('free', true);
    setChannelEnabled('sponsored', true);
    setChannelEnabled('aiping', true);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
  });

  test('测试任务优先走免费通道', () => {
    const channelId = routeRequest({ taskType: 'test' });
    assert.strictEqual(channelId, 'free');
  });

  test('正式任务优先走赞助通道', () => {
    const channelId = routeRequest({ taskType: 'formal' });
    assert.strictEqual(channelId, 'sponsored');
  });

  test('用户指定通道优先', () => {
    const channelId = routeRequest({ specifiedChannel: 'aiping', taskType: 'formal' });
    assert.strictEqual(channelId, 'aiping');
  });

  test('未注入决策器时 JevRoute 返回 null（本期默认状态）', async () => {
    const result = await JevRoute('test input');
    assert.strictEqual(result, null);
  });

  test('候选池过滤熔断通道', () => {
    // 手动打开熔断
    const db = getDb();
    db.prepare('UPDATE channels SET circuit_open_until = ? WHERE id = ?')
      .run(new Date(Date.now() + 60000).toISOString(), 'sponsored');
    
    const pool = buildCandidatePool([
      { id: 'free' },
      { id: 'sponsored' },
      { id: 'aiping' }
    ]);
    
    assert.strictEqual(pool.length, 2);
    assert.ok(pool.find(c => c.id === 'free'));
    assert.ok(pool.find(c => c.id === 'aiping'));
    assert.strictEqual(pool.find(c => c.id === 'sponsored'), undefined);
  });
});