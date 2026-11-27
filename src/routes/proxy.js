import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { getChannel } from '../services/channelRegistry.js';
import { routeRequestWithJev } from '../services/router.js';
import { recordFailure, recordSuccess, isCircuitOpen } from '../services/circuitBreaker.js';
import { evalQuotaWarning } from '../services/quota.js';
import { incrementUsage } from '../services/quota.js';
import { acquire } from '../services/rateLimiter.js';
import { authMiddleware } from '../middleware/auth.js';
import { isStreamRequest, createSseWriter, pipeUpstream, writeSingleShotSse } from '../services/streaming.js';

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
  
  // 配额硬限（CONTRACT §2）：超限直接 403，不再兜底走免费通道
  let targetChannelId = null;
  let isFallback = false;
  
  if (req.quotaExceeded) {
    res.set('X-Request-Id', requestId);
    return res.status(403).json({
      error: { type: 'quota_exceeded', message: 'Project quota exceeded' }
    });
  }

  // 路由：显式指定 > Jev（USE_JEV 开启且置信度达标）> 基础规则（契约 §5）
  // requestId 同时写进 call_logs 与 jev_decisions，并回填响应头 X-Request-Id，三者可互查
  const routed = await routeRequestWithJev({
    requestId,
    requestContent: { messages, model, taskType: taskType || 'formal' },
    specifiedChannel,
    taskType: taskType || 'formal'
  });
  targetChannelId = routed.channelId;
  
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
  
  // 免费通道内部限流（CONTRACT §2）
  if (channel.type === 'free') {
    const rl = acquire('free');
    if (!rl.allowed) {
      res.set('X-Request-Id', requestId);
      res.set('Retry-After', String(rl.retryAfterSec));
      return res.status(429).json({
        error: { type: 'rate_limit_error', message: `Free channel rate limited, retry after ${rl.retryAfterSec}s` }
      });
    }
  }
  
  // 流式请求（任务书 1.1b）：逐块透传给调用方，不走下面"收齐整包再 res.json"的路径
  if (isStreamRequest(req.body)) {
    return handleStreamRequest({
      req,
      res,
      channel,
      targetChannelId,
      requestId,
      startTime,
      payload: { messages, model, stream: true },
      isFallback
    });
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
    
    maybeWarnQuota(req.token, stats.totalTokens);
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
      if (freeChannel && freeChannel.isEnabled() && !isCircuitOpen('free') && acquire('free').allowed) {
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
          
          maybeWarnQuota(req.token, stats.totalTokens);
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

// tokenRow 必须是增量累计之前的快照行
function maybeWarnQuota(tokenRow, addedTokens) {
  const { shouldWarn, afterPercent } = evalQuotaWarning(tokenRow.token_used || 0, tokenRow.quota_limit, addedTokens);
  if (shouldWarn) {
    recordAlert('warning', `Token ${tokenRow.project_name} 用量达到 ${afterPercent}%（阈值 ${process.env.QUOTA_WARN_PERCENT || 80}%）`);
  }
}

// ---- 流式（SSE）转发：任务书 1.1b ----
//
// 契约要点（同步写进 CONTRACT.md §2）：
//   · 首字节发出前失败 → 仍可正常返回 500 JSON，并照旧尝试免费通道兜底；
//   · 首字节发出后失败 → 只能补一个 SSE 错误事件收尾，不再换通道（调用方已经看到部分内容）；
//   · 流式响应头在首字节时才发出，所以 X-Total-Tokens 这类"事后才知道"的统计头在流式下不保证有，
//     用量照样写进 call_logs 可查。

function insertCallLog({ requestId, tokenId, channelId, statusCode, latencyMs, isFallback, stats = null, errorMessage = null }) {
  const db = getDb();
  if (stats) {
    db.prepare(`
      INSERT INTO call_logs (
        request_id, token_id, channel_id, status_code, latency_ms, is_fallback,
        token_used, rounds, tokens_per_sec, cache_hit, prompt_tokens, completion_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, tokenId, channelId, statusCode, latencyMs, isFallback ? 1 : 0,
      stats.totalTokens, stats.rounds, stats.tokensPerSec, stats.cacheHit,
      stats.promptTokens, stats.completionTokens
    );
    return;
  }
  db.prepare(`
    INSERT INTO call_logs (request_id, token_id, channel_id, status_code, latency_ms, is_fallback, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, tokenId, channelId, statusCode, latencyMs, isFallback ? 1 : 0, errorMessage);
}

async function handleStreamRequest({ req, res, channel, targetChannelId, requestId, startTime, payload, isFallback, attemptFallback = true }) {
  const sseHeaders = { 'X-Channel': targetChannelId, 'X-Request-Id': requestId };
  if (isFallback) sseHeaders['X-Fallback'] = 'true';

  // 该通道没实现流式（当前是 free / aiping）：整包转发后一次性以 SSE 送出。
  // 这是契约里写明的降级语义——协议仍是 SSE，只是不再逐块。
  if (typeof channel.forwardStream !== 'function') {
    let result;
    try {
      // 明确向不支持的通道要"非流式整包"：否则上游看到 stream=true 可能回 SSE 文本，
      // 我们就会把一整段 SSE 文本当成 data 再包一层，调用方解析会错乱。
      result = await channel.forward({ ...payload, stream: false });
    } catch (error) {
      return failStreamRequest({ req, res, requestId, startTime, targetChannelId, payload, isFallback, attemptFallback, error });
    }
    const latencyMs = Date.now() - startTime;
    const stats = extractUsageStats(result.data?.usage || {}, latencyMs);
    insertCallLog({ requestId, tokenId: req.tokenId, channelId: targetChannelId, statusCode: 200, latencyMs, isFallback, stats });
    maybeWarnQuota(req.token, stats.totalTokens);
    incrementUsage(req.tokenId, stats.totalTokens);

    writeSingleShotSse(createSseWriter(res, sseHeaders), result.data);
    return;
  }

  // 先把上游连上，再决定要不要发响应头——这样"上游当场 400/429"还能干净地回 500 JSON。
  let upstream;
  try {
    upstream = await channel.forwardStream(payload);
  } catch (error) {
    return failStreamRequest({ req, res, requestId, startTime, targetChannelId, payload, isFallback, attemptFallback, error });
  }

  const writer = createSseWriter(res, sseHeaders);
  const outcome = await pipeUpstream(upstream.stream, writer, res);
  const latencyMs = Date.now() - startTime;

  if (outcome.error) {
    recordFailure(targetChannelId);

    if (writer.opened) {
      // 已经给调用方发过字节了，不能改成 500 JSON，只能补一个错误事件收尾
      insertCallLog({
        requestId, tokenId: req.tokenId, channelId: targetChannelId,
        statusCode: 500, latencyMs, isFallback,
        errorMessage: `stream interrupted after ${outcome.bytesWritten} bytes: ${outcome.error.message}`
      });
      writer.writeEvent({ error: { type: 'upstream_stream_error', message: outcome.error.message } });
      writer.writeDone();
      writer.end();
      return;
    }

    return failStreamRequest({ req, res, requestId, startTime, targetChannelId, payload, isFallback, attemptFallback, error: outcome.error });
  }

  if (outcome.clientClosed) {
    // 客户端自己先断开（模型还在生成，前端被关掉/取消）：记 499，不再写任何字节
    insertCallLog({
      requestId, tokenId: req.tokenId, channelId: targetChannelId,
      statusCode: 499, latencyMs, isFallback, errorMessage: 'client closed connection'
    });
    return;
  }

  const stats = extractUsageStats(outcome.usage || {}, latencyMs);
  insertCallLog({ requestId, tokenId: req.tokenId, channelId: targetChannelId, statusCode: 200, latencyMs, isFallback, stats });
  maybeWarnQuota(req.token, stats.totalTokens);
  incrementUsage(req.tokenId, stats.totalTokens);
  writer.end();
}

// 流式请求的失败处理：先看能不能照旧兜底到免费通道，不能就回 500 JSON。
async function failStreamRequest({ req, res, requestId, startTime, targetChannelId, payload, isFallback, attemptFallback, error }) {
  const latencyMs = Date.now() - startTime;
  recordFailure(targetChannelId);
  insertCallLog({
    requestId, tokenId: req.tokenId, channelId: targetChannelId,
    statusCode: 500, latencyMs, isFallback, errorMessage: error.message
  });

  if (attemptFallback && targetChannelId !== 'free') {
    const freeChannel = getChannel('free');
    if (freeChannel && freeChannel.isEnabled() && !isCircuitOpen('free') && acquire('free').allowed) {
      return handleStreamRequest({
        req, res, requestId, startTime, payload,
        channel: freeChannel, targetChannelId: 'free',
        isFallback: true, attemptFallback: false
      });
    }
  }

  return res.status(500).json({
    error: 'Internal Server Error',
    message: error.message,
    requestId
  });
}

export default router;