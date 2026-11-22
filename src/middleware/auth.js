import { getTokenByToken, checkQuota, incrementUsage, isQuotaExceeded } from '../services/quota.js';

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const apiKey = req.headers['x-api-key'];
  
  let token = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (apiKey) {
    token = apiKey;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }
  
  const tokenRow = getTokenByToken(token);
  
  if (!tokenRow) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
  
  const quotaCheck = checkQuota(tokenRow);
  
  if (!quotaCheck.allowed) {
    if (quotaCheck.reason === 'quota_exceeded') {
      // 标记配额超限，后续路由会降级到免费通道
      req.quotaExceeded = true;
    } else {
      return res.status(401).json({ error: 'Token validation failed' });
    }
  }
  
  req.token = tokenRow;
  req.tokenId = tokenRow.id;
  
  next();
}