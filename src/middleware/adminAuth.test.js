import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { adminAuth } from './adminAuth.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; }
  };
}

describe('Admin 鉴权（CONTRACT §6）', () => {
  afterEach(() => { delete process.env.ADMIN_TOKEN; });

  test('ADMIN_TOKEN 未设置时放行（兼容本机 Demo）', () => {
    let passed = false;
    const res = mockRes();
    adminAuth({ headers: {} }, res, () => { passed = true; });
    assert.strictEqual(passed, true);
    assert.strictEqual(res.statusCode, 0);
  });

  test('已设置且缺失/错误 x-admin-token 返回 401', () => {
    process.env.ADMIN_TOKEN = 'secret-123';
    for (const headers of [{}, { 'x-admin-token': 'wrong' }]) {
      const res = mockRes();
      adminAuth({ headers }, res, () => { throw new Error('should not pass'); });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error.type, 'invalid_request_error');
    }
  });

  test('x-admin-token 匹配时放行', () => {
    process.env.ADMIN_TOKEN = 'secret-123';
    let passed = false;
    adminAuth({ headers: { 'x-admin-token': 'secret-123' } }, mockRes(), () => { passed = true; });
    assert.strictEqual(passed, true);
  });
});
