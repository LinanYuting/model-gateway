// Admin 接口鉴权（CONTRACT §6）：ADMIN_TOKEN 未设置时保持开放
export function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return next();

  if (req.headers['x-admin-token'] !== expected) {
    return res.status(401).json({
      error: { type: 'invalid_request_error', message: 'Invalid or missing x-admin-token' }
    });
  }
  next();
}
