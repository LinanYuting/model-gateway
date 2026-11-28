import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { adminAuth, isLoopbackRequest } from './adminAuth.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; }
  };
}

function mockReq(overrides = {}) {
  return {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides
  };
}

describe('Admin 鉴权（CONTRACT §6 / 安全审查 1）', () => {
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
    delete process.env.NODE_ENV;
    delete process.env.REQUIRE_ADMIN_TOKEN;
  });

  test('ADMIN_TOKEN 未设置时只放行本机回环请求（原“完全开放”已收紧）', () => {
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      let passed = false;
      const res = mockRes();
      adminAuth(mockReq({ socket: { remoteAddress } }), res, () => { passed = true; });
      assert.strictEqual(passed, true);
      assert.strictEqual(res.statusCode, 0);
    }
  });

  test('ADMIN_TOKEN 未设置 + 非回环来源 → 403 ADMIN_TOKEN_REQUIRED', () => {
    const res = mockRes();
    let passed = false;
    adminAuth(mockReq({ socket: { remoteAddress: '10.1.2.3' } }), res, () => { passed = true; });
    assert.strictEqual(passed, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'ADMIN_TOKEN_REQUIRED');
  });

  test('生产环境未配 ADMIN_TOKEN → 503（fail-closed，不再对外开放）', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    let passed = false;
    adminAuth(mockReq(), res, () => { passed = true; });
    assert.strictEqual(passed, false);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'ADMIN_TOKEN_REQUIRED');
    assert.strictEqual(res.body.error.type, 'configuration_error');
  });

  test('REQUIRE_ADMIN_TOKEN=true 等效于强制配置', () => {
    process.env.REQUIRE_ADMIN_TOKEN = 'true';
    const res = mockRes();
    adminAuth(mockReq(), res, () => {});
    assert.strictEqual(res.statusCode, 503);
  });

  test('已设置且缺失/错误 x-admin-token 返回 401', () => {
    process.env.ADMIN_TOKEN = 'secret-123';
    for (const headers of [{}, { 'x-admin-token': 'wrong' }, { 'x-admin-token': 'secret-1234' }]) {
      const res = mockRes();
      adminAuth(mockReq({ headers }), res, () => { throw new Error('should not pass'); });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error.type, 'invalid_request_error');
    }
  });

  test('x-admin-token 匹配时放行（长度不同不会抛 crypto 错误）', () => {
    process.env.ADMIN_TOKEN = 'secret-123';
    let passed = false;
    adminAuth(mockReq({ headers: { 'x-admin-token': 'secret-123' } }), mockRes(), () => { passed = true; });
    assert.strictEqual(passed, true);
  });

  test('isLoopbackRequest 识别回环地址，取不到地址时按非回环处理', () => {
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.5' } }), false);
    assert.strictEqual(isLoopbackRequest({ headers: {} }), false);
  });
});
