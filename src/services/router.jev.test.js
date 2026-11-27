import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-router-jev.db');
process.env.DB_PATH = TEST_DB_PATH;

const { initDb, getDb, closeDb } = await import('../db/index.js');
const { routeRequestWithJev, routeRequest, ruleBasedRoute } = await import('./router.js');
const { loadChannels, setChannelEnabled } = await import('./channelRegistry.js');
const {
  setJevClassifier,
  resetJevClassifier,
  getJevDecisionsByRequestId,
  JEV_RULE_DEFAULT
} = await import('./jev.js');

// 造一个"确定性的"决策器，便于断言路由到底听了谁
function recommend(channelId, confidence) {
  return () => ({ channelId, confidence });
}

const REQUEST = { messages: [{ role: 'user', content: '写一个快排' }], model: 'mock-ok', taskType: 'formal' };

describe('Router × Jev（任务 1.4）', () => {
  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
    initDb();
    loadChannels();
    // 三通道全启用，避免"配置不同"干扰路由断言
    const db = getDb();
    db.prepare('UPDATE channels SET enabled = 1, failure_count = 0, circuit_open_until = NULL').run();
    setChannelEnabled('free', true);
    setChannelEnabled('sponsored', true);
    setChannelEnabled('aiping', true);

    delete process.env.USE_JEV;
    resetJevClassifier();
  });

  afterEach(() => {
    resetJevClassifier();
    delete process.env.USE_JEV;
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
  });

  // ---------- 开关关闭：零介入 ----------

  test('USE_JEV 关闭时：不调决策器、不落库，按基础规则路由', async () => {
    let calls = 0;
    setJevClassifier(() => {
      calls++;
      return { channelId: 'aiping', confidence: 0.99 };
    });

    const result = await routeRequestWithJev({
      requestId: 'req-off',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'sponsored'); // formal 的基础规则
    assert.strictEqual(result.jev, null);              // 未启用 Jev
    assert.strictEqual(calls, 0, '开关关闭时决策器一次都不该被调用');
    assert.deepStrictEqual(getJevDecisionsByRequestId('req-off'), [], '开关关闭时不写决策记录');
  });

  test('USE_JEV 关闭且显式指定通道时：用指定通道、不落库', async () => {
    const result = await routeRequestWithJev({
      requestId: 'req-off-specified',
      requestContent: REQUEST,
      specifiedChannel: 'aiping',
      taskType: 'formal'
    });
    assert.strictEqual(result.channelId, 'aiping');
    assert.strictEqual(result.jev, null);
    assert.deepStrictEqual(getJevDecisionsByRequestId('req-off-specified'), []);
  });

  // ---------- 开关开启：采纳 / 回退 ----------

  test('USE_JEV 开启 + 置信度 0.9 达标 → 采纳 Jev 推荐并落库', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('aiping', 0.9));

    const result = await routeRequestWithJev({
      requestId: 'req-on-high',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'aiping');
    assert.strictEqual(result.jev.decision, 'aiping');
    assert.strictEqual(result.jev.confidence, 0.9);
    assert.strictEqual(result.jev.recorded, true);

    const rows = getJevDecisionsByRequestId('req-on-high');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].decision, 'aiping');
    assert.strictEqual(rows[0].confidence, 0.9);
    assert.strictEqual(rows[0].input_summary, '写一个快排');
  });

  test('置信度恰为 0.6（阈值边界）→ 采纳', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('free', 0.6));

    const result = await routeRequestWithJev({
      requestId: 'req-boundary',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'free');
    assert.strictEqual(getJevDecisionsByRequestId('req-boundary')[0].decision, 'free');
  });

  test('置信度 0.59（低于阈值）→ 放弃 Jev、回退规则，并记 rule-default', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('free', 0.59));

    const result = await routeRequestWithJev({
      requestId: 'req-low',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'sponsored', '应回到 formal 的基础规则');
    assert.strictEqual(result.jev.decision, JEV_RULE_DEFAULT);
    assert.strictEqual(result.jev.confidence, 0.59, '库里仍保留模型当时的置信度，便于排查');

    const row = getJevDecisionsByRequestId('req-low')[0];
    assert.strictEqual(row.decision, 'rule-default');
    assert.strictEqual(row.confidence, 0.59);
  });

  test('Jev 推荐的通道处于熔断中 → 不采纳，回退规则并记 rule-default', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('aiping', 0.95));
    getDb()
      .prepare('UPDATE channels SET circuit_open_until = ? WHERE id = ?')
      .run(new Date(Date.now() + 60000).toISOString(), 'aiping');

    const result = await routeRequestWithJev({
      requestId: 'req-circuit',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'sponsored');
    assert.strictEqual(getJevDecisionsByRequestId('req-circuit')[0].decision, 'rule-default');
  });

  test('Jev 推荐的通道已禁用 → 不采纳，回退规则', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('aiping', 0.95));
    setChannelEnabled('aiping', false);

    const result = await routeRequestWithJev({
      requestId: 'req-disabled',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'sponsored');
    assert.strictEqual(getJevDecisionsByRequestId('req-disabled')[0].decision, 'rule-default');
  });

  test('决策器抛错 → 请求不阻断，回退规则并记 rule-default', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(() => {
      throw new Error('决策模型 502');
    });

    const result = await routeRequestWithJev({
      requestId: 'req-throw',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'sponsored');
    assert.strictEqual(result.jev.decision, 'rule-default');
    assert.strictEqual(result.jev.confidence, null);
    assert.strictEqual(getJevDecisionsByRequestId('req-throw')[0].decision, 'rule-default');
  });

  test('开关开启但本期未接模型（无决策器）→ 规则路由 + rule-default 记录', async () => {
    process.env.USE_JEV = 'true';

    const result = await routeRequestWithJev({
      requestId: 'req-nomodel',
      requestContent: REQUEST,
      taskType: 'test'
    });

    assert.strictEqual(result.channelId, 'free', 'test 任务的基础规则');
    assert.strictEqual(result.jev.decision, 'rule-default');
    assert.strictEqual(result.jev.confidence, null);
    assert.strictEqual(getJevDecisionsByRequestId('req-nomodel').length, 1);
  });

  test('显式指定通道时不做 Jev、不写决策记录（契约 §5 优先级最高）', async () => {
    process.env.USE_JEV = 'true';
    let calls = 0;
    setJevClassifier(() => {
      calls++;
      return { channelId: 'free', confidence: 0.99 };
    });

    const result = await routeRequestWithJev({
      requestId: 'req-specified',
      requestContent: REQUEST,
      specifiedChannel: 'aiping',
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'aiping');
    assert.strictEqual(result.jev, null);
    assert.strictEqual(calls, 0, '显式指定时不该打扰决策器');
    assert.deepStrictEqual(getJevDecisionsByRequestId('req-specified'), []);
  });

  test('落库失败不影响本次路由（决策记录只是可观测性）', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('aiping', 0.9));
    getDb().exec('DROP TABLE jev_decisions'); // 模拟写库失败

    const result = await routeRequestWithJev({
      requestId: 'req-db-fail',
      requestContent: REQUEST,
      taskType: 'formal'
    });

    assert.strictEqual(result.channelId, 'aiping', '路由结果不受落库失败影响');
    assert.strictEqual(result.jev.recorded, false);
  });

  // ---------- 与既有同步入口的兼容 ----------

  test('routeRequest（同步入口）行为不变：显式指定 > 基础规则', () => {
    assert.strictEqual(routeRequest({ specifiedChannel: 'aiping', taskType: 'formal' }), 'aiping');
    assert.strictEqual(routeRequest({ taskType: 'formal' }), 'sponsored');
    assert.strictEqual(routeRequest({ taskType: 'test' }), 'free');
  });

  test('ruleBasedRoute 独立可用（供其他模块复用规则）', () => {
    assert.strictEqual(ruleBasedRoute('dev'), 'free');
    assert.strictEqual(ruleBasedRoute('formal'), 'sponsored');
  });

  test('同一个 request_id 的多次决策可按请求聚合（供 X-Request-Id 关联查询）', async () => {
    process.env.USE_JEV = 'true';
    setJevClassifier(recommend('aiping', 0.9));

    await routeRequestWithJev({ requestId: 'req-multi', requestContent: REQUEST, taskType: 'formal' });
    await routeRequestWithJev({ requestId: 'req-multi', requestContent: REQUEST, taskType: 'formal' });

    assert.strictEqual(getJevDecisionsByRequestId('req-multi').length, 2);
    assert.strictEqual(getJevDecisionsByRequestId('req-other').length, 0);
  });
});
