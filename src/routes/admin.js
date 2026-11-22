import express from 'express';
import { getDb } from '../db/index.js';
import { getChannel, listChannels, updateChannelConfig, setChannelEnabled, deleteChannel } from '../services/channelRegistry.js';
import { createToken, listTokens, refreshToken, updateQuota, deleteToken } from '../services/quota.js';
import { getCircuitStatus } from '../services/circuitBreaker.js';

const router = express.Router();

// 获取所有通道
router.get('/channels', (req, res) => {
  res.json(listChannels());
});

// 更新通道配置
router.put('/channels/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { enabled, config } = req.body;
    
    if (enabled !== undefined) {
      setChannelEnabled(id, enabled);
    }
    
    if (config) {
      updateChannelConfig(id, config);
    }
    
    res.json(getChannel(id).toJSON());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 获取所有令牌
router.get('/tokens', (req, res) => {
  res.json(listTokens());
});

// 创建令牌
router.post('/tokens', (req, res) => {
  try {
    const { projectName, quotaLimit } = req.body;
    
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    
    const token = createToken(projectName, quotaLimit || 1000);
    res.status(201).json(token);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 刷新令牌
router.post('/tokens/:id/refresh', (req, res) => {
  try {
    const { id } = req.params;
    const token = refreshToken(id);
    res.json(token);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 更新配额
router.put('/tokens/:id/quota', (req, res) => {
  try {
    const { id } = req.params;
    const { quotaLimit } = req.body;
    
    if (!quotaLimit || quotaLimit <= 0) {
      return res.status(400).json({ error: 'quotaLimit must be positive' });
    }
    
    const token = updateQuota(id, quotaLimit);
    res.json(token);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 删除令牌
router.delete('/tokens/:id', (req, res) => {
  console.log('[Admin] DELETE /tokens/:id', req.params.id);
  try {
    const { id } = req.params;
    const deleted = deleteToken(id);
    if (!deleted) {
      console.log('[Admin] Token not found:', id);
      return res.status(404).json({ error: 'Token not found' });
    }
    console.log('[Admin] Token deleted:', id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 删除通道
router.delete('/channels/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = deleteChannel(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 获取熔断状态
router.get('/circuit-breaker/:id', (req, res) => {
  res.json(getCircuitStatus(req.params.id));
});

export default router;