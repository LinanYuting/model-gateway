import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { acquire, resetWindow, getFreeChannelRpm } from './rateLimiter.js';

describe('免费通道滑动窗口限流（CONTRACT §2）', () => {
  beforeEach(() => resetWindow());
  afterEach(() => { delete process.env.FREE_CHANNEL_RPM; resetWindow(); });

  test('rpm 内全部放行，超出后拒绝并给出 Retry-After', () => {
    const t0 = 1_000_000;
    assert.strictEqual(acquire('free', { rpm: 2, now: t0 }).allowed, true);
    assert.strictEqual(acquire('free', { rpm: 2, now: t0 + 100 }).allowed, true);
    const denied = acquire('free', { rpm: 2, now: t0 + 200 });
    assert.strictEqual(denied.allowed, false);
    assert.strictEqual(denied.remaining, 0);
    assert.ok(denied.retryAfterSec >= 1 && denied.retryAfterSec <= 60);
  });

  test('窗口滑动：最早请求满 60s 后额度恢复', () => {
    const t0 = 0;
    acquire('free', { rpm: 1, now: t0 });
    assert.strictEqual(acquire('free', { rpm: 1, now: t0 + 59_000 }).allowed, false);
    assert.strictEqual(acquire('free', { rpm: 1, now: t0 + 60_001 }).allowed, true);
  });

  test('不同通道窗口相互独立', () => {
    acquire('free', { rpm: 1, now: 0 });
    assert.strictEqual(acquire('sponsored', { rpm: 1, now: 0 }).allowed, true);
  });

  test('rpm <= 0 表示不限流', () => {
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(acquire('free', { rpm: 0, now: i }).allowed, true);
    }
  });

  test('getFreeChannelRpm：env 覆盖与非法值回退 30', () => {
    assert.strictEqual(getFreeChannelRpm(), 30);
    process.env.FREE_CHANNEL_RPM = '15';
    assert.strictEqual(getFreeChannelRpm(), 15);
    process.env.FREE_CHANNEL_RPM = 'abc';
    assert.strictEqual(getFreeChannelRpm(), 30);
  });
});
