import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { getChannel } from '../services/channelRegistry.js';
import { routeRequest } from '../services/router.js';
import { recordFailure, recordSuccess, isCircuitOpen } from '../services/circuitBreaker.js';
import { isQuotaExceeded } from '../services/quota.js';
import { incrementUsage } from '../services/quota.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

function extractUsageStats(usage, latencyMs) {
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
  const cacheHit = usage.cache_read ? 1 : (usage.cache_hit ? 1 : 0);
  const rounds = usage.rounds || 1;
  
  // tokens/s = completion_tokens / (latency_ms / 1000)
  const tokensPerSec = latencyMs > 0 && completionTokens > 0 
    ? Math.round(completionTokens / (latencyMs / 1000)) 
    : 0;

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    cacheHit,
    rounds,
    tokensPerSec
  };
}

router.post('/chat/completions', authMiddleware, async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();
  const { messages, model, specifiedChannel, taskType } = req.body;
  
  // 配额超限处理：降级到免费通道
  let targetChannelId = null;
  let isFallback = false;
  
  if (req.quotaExceeded) {
    const freeChannel = getChannel('free');
    if (freeChannel && freeChannel.isEnabled()) {
      targetChannelId = 'free';
      isFallback = true;
    } else {
      recordAlert('critical', `Quota exceeded and free channel unavailable for token ${req.tokenId}`);
      return res.status(429).json({ 
        error: 'Too Many Requests',
        message: 'Quota exceeded and no fallback channel available'
      });
    }
  } else {
    targetChannelId = routeRequest({
      specifiedChannel,
      taskType: taskType || 'formal',
      useJev: false
    });
  }
  
  if (!targetChannelId) {
    return res.status(503).json({ 
      error: 'Service Unavailable',
      message: 'No available channel'
    });
  }
  
  const channel = getChannel(targetChannelId);
  
  if (!channel) {
    return res.status(503).json({ error: 'Channel not found' });
  }
  
  try {
    const result = await channel.forward({ messages, model });
    
    const latencyMs = Date.now() - startTime;
    const stats = extractUsageStats(result.data?.usage || {}, latencyMs);
    
    // 记录调用日志（含详细统计）
    const db = getDb();
    db.prepare(`
      INSERT INTO call_logs (
        request_id, token_id, channel_id, status_code, latency_ms, is_fallback,
        token_used, rounds, tokens_per_sec, cache_hit, prompt_tokens, completion_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, req.tokenId, targetChannelId, 200, latencyMs, isFallback ? 1 : 0,
      stats.totalTokens, stats.rounds, stats.tokensPerSec, stats.cacheHit,
      stats.promptTokens, stats.completionTokens
    );
    
    incrementUsage(req.tokenId, stats.totalTokens);
    
    res.set('X-Channel', targetChannelId);
    res.set('X-Request-Id', requestId);
    res.set('X-Total-Tokens', stats.totalTokens);
    res.set('X-Prompt-Tokens', stats.promptTokens);
    res.set('X-Completion-Tokens', stats.completionTokens);
    res.set('X-Tokens-Per-Sec', stats.tokensPerSec);
    res.set('X-Cache-Hit', stats.cacheHit);
    res.set('X-Rounds', stats.rounds);
    res.json(result.data);
    
  } catch (error) {
    recordFailure(targetChannelId);
    
    const db = getDb();
    const latencyMs = Date.now() - startTime;
    db.prepare(`
      INSERT INTO call_logs (request_id, token_id, channel_id, status_code, latency_ms, is_fallback, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(requestId, req.tokenId, targetChannelId, 500, latencyMs, isFallback ? 1 : 0, error.message);
    
    if (targetChannelId !== 'free') {
      const freeChannel = getChannel('free');
      if (freeChannel && freeChannel.isEnabled() && !isCircuitOpen('free')) {
        try {
          const fallbackResult = await freeChannel.forward({ messages, model });
          
          const latencyMs = Date.now() - startTime;
          const stats = extractUsageStats(fallbackResult.data?.usage || {}, latencyMs);
          
          db.prepare(`
            INSERT INTO call_logs (
              request_id, token_id, channel_id, status_code, latency_ms, is_fallback,
              token_used, rounds, tokens_per_sec, cache_hit, prompt_tokens, completion_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            requestId, req.tokenId, 'free', 200, latencyMs, 1,
            stats.totalTokens, stats.rounds, stats.tokensPerSec, stats.cacheHit,
            stats.promptTokens, stats.completionTokens
          );
          
          incrementUsage(req.tokenId, stats.totalTokens);
          res.set('X-Channel', 'free');
          res.set('X-Fallback', 'true');
          res.set('X-Total-Tokens', stats.totalTokens);
          res.set('X-Prompt-Tokens', stats.promptTokens);
          res.set('X-Completion-Tokens', stats.completionTokens);
          res.set('X-Tokens-Per-Sec', stats.tokensPerSec);
          res.set('X-Cache-Hit', stats.cacheHit);
          res.set('X-Rounds', stats.rounds);
          return res.json(fallbackResult.data);
        } catch (fallbackError) {
          recordFailure('free');
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message,
      requestId
    });
  }
});

function recordAlert(level, message) {
  const db = getDb();
  db.prepare('INSERT INTO alerts (level, message) VALUES (?, ?)').run(level, message);
}

export default router;