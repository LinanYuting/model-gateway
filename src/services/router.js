import { getDb } from '../db/index.js';
import { getChannel } from './channelRegistry.js';
import { isCircuitOpen } from './circuitBreaker.js';

const USE_JEV = process.env.USE_JEV === 'true';

// Jev 语义路由空壳（Phase 1 仅预留，不实现真实逻辑）
export function JevRoute(requestContent) {
  // Phase 1: 仅图纸，不盖房子
  // 未来可在此接入轻量级第三方模型进行意图识别
  // 返回 null 表示不使用 Jev，走基础规则
  return null;
}

export function routeRequest({ specifiedChannel, taskType, useJev = false }) {
  // 1. 用户指定优先
  if (specifiedChannel) {
    const channel = getChannel(specifiedChannel);
    if (channel && channel.isEnabled() && !isCircuitOpen(specifiedChannel)) {
      return specifiedChannel;
    }
  }

  // 2. Jev 语义路由（Phase 1 为空壳）
  if (useJev || USE_JEV) {
    const jevDecision = JevRoute(null);
    if (jevDecision && jevDecision.channelId) {
      // 未来 Jev 实现后在此处理
      const channel = getChannel(jevDecision.channelId);
      if (channel && channel.isEnabled() && !isCircuitOpen(jevDecision.channelId)) {
        return jevDecision.channelId;
      }
    }
  }

  // 3. 基础规则路由
  // taskType: test -> free; formal/demo -> sponsored/aiping
  if (taskType === 'test' || taskType === 'dev') {
    // 测试任务优先走免费通道
    if (isChannelAvailable('free')) return 'free';
    if (isChannelAvailable('sponsored')) return 'sponsored';
    if (isChannelAvailable('aiping')) return 'aiping';
  } else {
    // 正式/演示任务优先走赞助或 aiping
    if (isChannelAvailable('sponsored')) return 'sponsored';
    if (isChannelAvailable('aiping')) return 'aiping';
    if (isChannelAvailable('free')) return 'free';
  }

  // 4. 兜底：返回第一个可用通道
  const channels = ['sponsored', 'aiping', 'free'];
  for (const id of channels) {
    if (isChannelAvailable(id)) return id;
  }

  return null;
}

function isChannelAvailable(channelId) {
  const channel = getChannel(channelId);
  if (!channel || !channel.isEnabled()) return false;
  if (isCircuitOpen(channelId)) return false;
  return true;
}

export function buildCandidatePool(channels) {
  return channels.filter(ch => {
    const channel = getChannel(ch.id || ch);
    return channel && channel.isEnabled() && !isCircuitOpen(ch.id || ch);
  });
}