// Admin 接口鉴权（CONTRACT §6）
//
// 第二轮安全审查第 1 条：
//   - 原来「ADMIN_TOKEN 未设置就完全开放」在生产环境等于后台裸奔，改成默认只信本机回环；
//   - NODE_ENV=production（或显式 REQUIRE_ADMIN_TOKEN=true）时未配 ADMIN_TOKEN 直接拒绝服务，
//     让"忘了配"变成启动即可见的故障，而不是悄悄对外开放；
//   - 比较 token 用 timingSafeEqual，避免按字节比较泄漏长度/前缀信息。
import { timingSafeEqual } from 'crypto';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 请求是不是从本机回环地址来的（Express 的 req.socket.remoteAddress） */
export function isLoopbackRequest(req) {
  const raw = req?.socket?.remoteAddress
    || req?.connection?.remoteAddress
    || req?.ip
    || '';
  return LOOPBACK_ADDRESSES.has(String(raw));
}

/** 生产环境（或显式要求）必须配 ADMIN_TOKEN */
function mustConfigureAdminToken() {
  return process.env.NODE_ENV === 'production' || process.env.REQUIRE_ADMIN_TOKEN === 'true';
}

export function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;

  if (expected) {
    if (!safeEqual(req.headers['x-admin-token'], expected)) {
      return res.status(401).json({
        error: { type: 'invalid_request_error', message: 'Invalid or missing x-admin-token' }
      });
    }
    return next();
  }

  // 没配 ADMIN_TOKEN
  if (mustConfigureAdminToken()) {
    return res.status(503).json({
      error: {
        type: 'configuration_error',
        message: 'ADMIN_TOKEN is not configured; admin API is disabled in this environment'
      },
      code: 'ADMIN_TOKEN_REQUIRED'
    });
  }

  // 开发环境：只允许本机访问（curl 本机 / 本机浏览器看板）
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({
      error: {
        type: 'invalid_request_error',
        message: 'Admin API without ADMIN_TOKEN is limited to loopback requests; set ADMIN_TOKEN to allow remote access'
      },
      code: 'ADMIN_TOKEN_REQUIRED'
    });
  }

  return next();
}
