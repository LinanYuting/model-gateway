import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initDb, getDb, closeDb } from '../db/index.js';
import { FreeChannel } from './FreeChannel.js';
import { SponsoredChannel } from './SponsoredChannel.js';
import { AipingChannel } from './AipingChannel.js';
import { ChannelPlugin } from './ChannelPlugin.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-channels.db');
process.env.DB_PATH = TEST_DB_PATH;

describe('Channel Plugins', () => {
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

  test('ChannelPlugin 基类方法', () => {
    const plugin = new ChannelPlugin('test', 'Test Plugin', true, { key: 'value' });
    
    assert.strictEqual(plugin.id, 'test');
    assert.strictEqual(plugin.name, 'Test Plugin');
    assert.strictEqual(plugin.isEnabled(), true);
    assert.deepStrictEqual(plugin.getConfig(), { key: 'value' });
    
    plugin.setConfig({ newKey: 'newValue' });
    assert.deepStrictEqual(plugin.getConfig(), { key: 'value', newKey: 'newValue' });
    
    plugin.setEnabled(false);
    assert.strictEqual(plugin.isEnabled(), false);
  });

  test('ChannelPlugin 熔断逻辑', () => {
    const plugin = new ChannelPlugin('test', 'Test Plugin', true, {});
    
    // 初始状态
    assert.strictEqual(plugin.isCircuitOpen(), false);
    assert.strictEqual(plugin.failureCount, 0);
    
    // 记录失败
    plugin.recordFailure();
    assert.strictEqual(plugin.failureCount, 1);
    assert.strictEqual(plugin.isCircuitOpen(), false);
    
    plugin.recordFailure();
    plugin.recordFailure();
    assert.strictEqual(plugin.failureCount, 3);
    assert.strictEqual(plugin.isCircuitOpen(), true);
    
    // 成功重置
    plugin.recordSuccess();
    assert.strictEqual(plugin.failureCount, 0);
    assert.strictEqual(plugin.isCircuitOpen(), false);
  });

  test('FreeChannel 无配置时可使用 OFM 默认端点', async () => {
    const channel = new FreeChannel('free', '免费公共通道', true, {});
    
    // 免费通道无需 API Key，应基于 OFM 默认端点运行
    const apiKeys = channel.getApiKeys();
    assert.strictEqual(apiKeys.length, 0);
    
    const healthy = await channel.healthCheck();
    // OFM 默认端点可能未启动，healthCheck 可能返回 false，但不应抛出错误
    assert.ok([true, false].includes(healthy));
  });

  test('SponsoredChannel 未配置时 healthCheck 返回 false', async () => {
    const channel = new SponsoredChannel('sponsored', '赞助密钥通道', true, {});
    
    const healthy = await channel.healthCheck();
    assert.strictEqual(healthy, false);
    assert.strictEqual(channel.healthStatus, 'unconfigured');
  });

  test('AipingChannel 未配置时 healthCheck 返回 false', async () => {
    const channel = new AipingChannel('aiping', 'aiping 通道', true, {});
    
    const healthy = await channel.healthCheck();
    assert.strictEqual(healthy, false);
    assert.strictEqual(channel.healthStatus, 'unconfigured');
  });
});