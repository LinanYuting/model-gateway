import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, '../../data/test-jev.db');
process.env.DB_PATH = TEST_DB_PATH;

const { initDb, getDb, closeDb } = await import('../db/index.js');
const {
  JevRoute,
  summarizeInput,
  isJevEnabled,
  setJevClassifier,
  resetJevClassifier,
  hasJevClassifier,
  recordJevDecision,
  safelyRecordJevDecision,
  getJevDecisionsByRequestId,
  JEV_DECISIONS,
  JEV_RULE_DEFAULT,
  JEV_CONFIDENCE_THRESHOLD,
  DEFAULT_JEV_TIMEOUT_MS
} = await import('./jev.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Jev 核心（任务 1.4）', () => {
  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
    initDb();
    resetJevClassifier();
    delete process.env.USE_JEV;
  });

  afterEach(() => {
    resetJevClassifier();
    delete process.env.USE_JEV;
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(TEST_DB_PATH + suffix)) rmSync(TEST_DB_PATH + suffix);
    }
  });

  // ---------- 枚举与阈值常量（契约 §1） ----------

  test('decision 枚举与契约 §1 一致（含规则回退值）', () => {
    assert.deepStrictEqual([...JEV_DECISIONS], ['free', 'sponsored', 'aiping', 'rule-default']);
    assert.strictEqual(JEV_RULE_DEFAULT, 'rule-default');
  });

  test('置信度阈值按契约 §1 为 0.6', () => {
    assert.strictEqual(JEV_CONFIDENCE_THRESHOLD, 0.6);
  });

  test('决策器默认超时 3000ms（可被调用参数覆盖）', () => {
    assert.strictEqual(DEFAULT_JEV_TIMEOUT_MS, 3000);
  });

  // ---------- input_summary ----------

  test('取最后一条 user 消息并压成一行', () => {
    const summary = summarizeInput({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '第一个问题' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '  第二个\n问题   带空格  ' }
      ]
    });
    assert.strictEqual(summary, '第二个 问题 带空格');
  });

  test('支持多模态数组 content（只取文本片段）', () => {
    const summary = summarizeInput({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图讲了什么' },
            { type: 'image_url', image_url: { url: 'http://example.com/a.png' } }
          ]
        }
      ]
    });
    assert.strictEqual(summary, '这张图讲了什么');
  });

  test('超过 200 字截断并加省略号', () => {
    const summary = summarizeInput({ messages: [{ role: 'user', content: '啊'.repeat(300) }] });
    assert.ok(summary.length <= 200, `长度应 ≤ 200，实际 ${summary.length}`);
    assert.ok(summary.endsWith('…'));
  });

  test('空请求返回 null', () => {
    assert.strictEqual(summarizeInput(null), null);
    assert.strictEqual(summarizeInput({}), null);
    assert.strictEqual(summarizeInput({ messages: [{ role: 'user', content: '   ' }] }), null);
  });

  // ---------- 总开关 ----------

  test('USE_JEV 未设置时开关关闭；设为 "true" 时打开', () => {
    assert.strictEqual(isJevEnabled(), false);
    process.env.USE_JEV = 'true';
    assert.strictEqual(isJevEnabled(), true);
    process.env.USE_JEV = 'false';
    assert.strictEqual(isJevEnabled(), false);
  });

  test('显式 useJev=true 可强制打开（供上层/测试）', () => {
    assert.strictEqual(isJevEnabled(true), true);
  });

  // ---------- 决策器注入与 JevRoute ----------

  test('没有决策器时 JevRoute 返回 null', async () => {
    assert.strictEqual(hasJevClassifier(), false);
    assert.strictEqual(await JevRoute({ messages: [{ role: 'user', content: 'hi' }] }), null);
  });

  test('决策器给出合规结论时原样规范化返回', async () => {
    setJevClassifier(() => ({ channelId: 'aiping', confidence: 0.9 }));
    const result = await JevRoute({ messages: [{ role: 'user', content: '写一段 Python' }] });
    assert.strictEqual(result.channelId, 'aiping');
    assert.strictEqual(result.confidence, 0.9);
    assert.strictEqual(result.inputSummary, '写一段 Python');
  });

  test('置信度 0.6（阈值本身）会原样返回，交给路由层判定采纳', async () => {
    setJevClassifier(() => ({ channelId: 'free', confidence: 0.6 }));
    const result = await JevRoute({ messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(result.confidence, 0.6);
  });

  test('决策器返回非法通道名 / 非数字置信度 / rule-default 时视为无结论', async () => {
    setJevClassifier(() => ({ channelId: 'not-a-channel', confidence: 0.9 }));
    assert.strictEqual(await JevRoute({ messages: [] }), null);

    setJevClassifier(() => ({ channelId: 'aiping', confidence: 'high' }));
    assert.strictEqual(await JevRoute({ messages: [] }), null);

    setJevClassifier(() => ({ channelId: 'rule-default', confidence: 0.99 }));
    assert.strictEqual(await JevRoute({ messages: [] }), null);

    setJevClassifier(() => null);
    assert.strictEqual(await JevRoute({ messages: [] }), null);
  });

  test('置信度越界会被收敛到 0~1', async () => {
    setJevClassifier(() => ({ channelId: 'free', confidence: 1.7 }));
    assert.strictEqual((await JevRoute({ messages: [] })).confidence, 1);

    setJevClassifier(() => ({ channelId: 'free', confidence: -0.4 }));
    assert.strictEqual((await JevRoute({ messages: [] })).confidence, 0);
  });

  test('决策器抛错时 JevRoute 不抛、返回 null（不得阻断请求）', async () => {
    setJevClassifier(() => {
      throw new Error('模型服务挂了');
    });
    assert.strictEqual(await JevRoute({ messages: [] }), null);
  });

  test('决策器超时返回 null（超时保护生效）', async () => {
    setJevClassifier(async () => {
      await sleep(200);
      return { channelId: 'aiping', confidence: 0.99 };
    });
    const start = Date.now();
    const result = await JevRoute({ messages: [] }, { timeoutMs: 30 });
    assert.strictEqual(result, null);
    assert.ok(Date.now() - start < 150, '应在超时后立刻返回，而不是等决策器跑完');
  });

  // ---------- 落库 ----------

  test('决策记录写入后可按键名与 request_id 查回', () => {
    recordJevDecision({
      requestId: 'req-abc',
      inputSummary: '帮我写个排序算法',
      confidence: 0.87,
      decision: 'sponsored'
    });

    const rows = getJevDecisionsByRequestId('req-abc');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].request_id, 'req-abc');
    assert.strictEqual(rows[0].input_summary, '帮我写个排序算法');
    assert.strictEqual(rows[0].confidence, 0.87);
    assert.strictEqual(rows[0].decision, 'sponsored');
    assert.ok(rows[0].created_at);
  });

  test('decision="rule-default" 可正常落库（回退记录）', () => {
    recordJevDecision({ requestId: 'req-def', inputSummary: 'x', confidence: 0.2, decision: 'rule-default' });
    assert.strictEqual(getJevDecisionsByRequestId('req-def')[0].decision, 'rule-default');
  });

  test('confidence 缺失时存 NULL 而不是 NaN', () => {
    recordJevDecision({ requestId: 'req-null', inputSummary: 'x', decision: 'rule-default' });
    assert.strictEqual(getJevDecisionsByRequestId('req-null')[0].confidence, null);
  });

  test('非法 decision 抛 TypeError（枚举约束）', () => {
    assert.throws(
      () => recordJevDecision({ requestId: 'req-bad', decision: 'openai' }),
      /Invalid jev decision/
    );
    assert.throws(
      () => recordJevDecision({ requestId: 'req-bad', decision: undefined }),
      /Invalid jev decision/
    );
  });

  test('缺少 requestId 抛 TypeError', () => {
    assert.throws(() => recordJevDecision({ decision: 'free' }), /requires requestId/);
  });

  test('safelyRecordJevDecision 吞掉写入异常并返回 false', () => {
    // 表被删掉 = 模拟落库失败；此时绝不能抛错影响主链路
    getDb().exec('DROP TABLE jev_decisions');
    assert.strictEqual(
      safelyRecordJevDecision({ requestId: 'req-drop', decision: 'free' }),
      false
    );
  });
});
