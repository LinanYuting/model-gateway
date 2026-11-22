import express from 'express';
import { getDb } from '../db/index.js';
import { listChannels } from '../services/channelRegistry.js';

const router = express.Router();

// 获取看板摘要
router.get('/summary', (req, res) => {
  const db = getDb();
  
  const totalRequests = db.prepare('SELECT COUNT(*) as count FROM call_logs').get().count;
  const channels = listChannels();
  const alerts = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE resolved = 0').get().count;
  
  res.json({
    totalRequests,
    activeChannels: channels.filter(c => c.enabled).length,
    totalChannels: channels.length,
    unresolvedAlerts: alerts,
    timestamp: new Date().toISOString()
  });
});

// 获取通道列表
router.get('/channels', (req, res) => {
  res.json(listChannels());
});

// 获取最近调用记录
router.get('/logs', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 20;
  
  const logs = db.prepare(`
    SELECT cl.*, t.project_name, c.name as channel_name
    FROM call_logs cl
    LEFT JOIN tokens t ON cl.token_id = t.id
    LEFT JOIN channels c ON cl.channel_id = c.id
    ORDER BY cl.created_at DESC
    LIMIT ?
  `).all(limit);
  
  res.json(logs);
});

// 获取告警列表
router.get('/alerts', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 20;
  
  const alerts = db.prepare(`
    SELECT * FROM alerts
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
  
  res.json(alerts);
});

// Mock 数据接口（供前端开发使用）
router.get('/mock/summary', (req, res) => {
  res.json({
    totalRequests: 1234,
    activeChannels: 2,
    totalChannels: 3,
    unresolvedAlerts: 1,
    timestamp: new Date().toISOString()
  });
});

router.get('/mock/channels', (req, res) => {
  res.json([
    { id: 'free', name: '免费公共通道', type: 'free', enabled: true, healthStatus: 'healthy', config: { endpoint: '', model: '', apiKey: '' } },
    { id: 'sponsored', name: '赞助密钥通道', type: 'sponsored', enabled: true, healthStatus: 'healthy', config: { endpoint: '', model: '', apiKey: '' } },
    { id: 'aiping', name: 'aiping 通道', type: 'aiping', enabled: false, healthStatus: 'unconfigured', config: { endpoint: '', model: '', apiKey: '' } }
  ]);
});

router.get('/mock/logs', (req, res) => {
  res.json([
    { id: 1, request_id: 'req-001', project_name: '测试项目', channel_name: '免费公共通道', status_code: 200, latency_ms: 150, is_fallback: 0, created_at: new Date().toISOString() },
    { id: 2, request_id: 'req-002', project_name: '演示项目', channel_name: '赞助密钥通道', status_code: 200, latency_ms: 200, is_fallback: 0, created_at: new Date().toISOString() }
  ]);
});

router.get('/mock/alerts', (req, res) => {
  res.json([
    { id: 1, level: 'warning', message: 'Channel aiping (aiping) health check failed', resolved: 0, created_at: new Date().toISOString() }
  ]);
});

export default router;