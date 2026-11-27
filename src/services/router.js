import { getChannel } from './channelRegistry.js';
import { isCircuitOpen } from './circuitBreaker.js';
import {
  JevRoute,
  isJevEnabled,
  summarizeInput,
  safelyRecordJevDecision,
  JEV_CONFIDENCE_THRESHOLD,
  JEV_RULE_DEFAULT
} from './jev.js';

// 既有的 Jev 入口/工具继续从 router 导出，兼容旧调用方；实现都在 services/jev.js
export {
  JevRoute,
  isJevEnabled,
  setJevClassifier,
  resetJevClassifier,
  hasJevClassifier,
  JEV_CONFIDENCE_THRESHOLD,
  JEV_DECISIONS,
  JEV_RULE_DEFAULT
} from './jev.js';

/**
 * 基础规则路由（不含 Jev）：契约 §5 的"默认规则"。
 * 测试任务 → free 优先；正式业务 → sponsored → aiping → free；最后兜底扫一遍。
 */
export function ruleBasedRoute(taskType) {
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

  // 兜底：返回第一个可用通道
  for (const id of ['sponsored', 'aiping', 'free']) {
    if (isChannelAvailable(id)) return id;
  }

  return null;
}

/**
 * 同步路由入口：显式指定 > 基础规则。
 * 不涉及 Jev —— Jev 结论是异步拿的，需要决策记录时请用 routeRequestWithJev。
 * （保留该函数是为了不破坏现有调用方与测试。）
 */
export function routeRequest({ specifiedChannel, taskType }) {
  // 1. 用户指定优先
  if (specifiedChannel && isChannelAvailable(specifiedChannel)) {
    return specifiedChannel;
  }

  // 2. 基础规则路由
  return ruleBasedRoute(taskType);
}

/**
 * 带 Jev 的路由入口（任务 1.4）。
 * 契约 §5 优先级：请求显式指定 > Jev（开启且置信度达标）> 基础规则。
 *
 * 返回 { channelId, jev }：
 *   channelId —— 最终通道；null 表示无可用通道
 *   jev       —— 本次决策摘要 { decision, confidence, recorded }；未启用 Jev 时为 null
 *
 * 关键约束：
 *   · 显式指定通道时不做 Jev、不写决策记录（用户说了算，且契约枚举里没有"specified"）
 *   · USE_JEV 关闭时 Jev 代码零介入：不调决策器、不落库、无额外开销
 *   · Jev 失败/超时/置信度不足 → 回退基础规则，并记 decision="rule-default"
 *   · 落库失败不影响本次请求
 */
export async function routeRequestWithJev({
  requestId,
  requestContent,
  specifiedChannel,
  taskType,
  useJev = false,
  timeoutMs
} = {}) {
  // 1. 显式指定最优先（契约 §5）
  if (specifiedChannel && isChannelAvailable(specifiedChannel)) {
    return { channelId: specifiedChannel, jev: null };
  }

  // 2. 总开关关闭：return 前不做任何 Jev 相关动作（零额外开销）
  if (!isJevEnabled(useJev)) {
    return { channelId: ruleBasedRoute(taskType), jev: null };
  }

  // 3. 开关开启：问 Jev，再按置信度阈值决定采纳还是回退
  const suggestion = await JevRoute(requestContent, { timeoutMs });
  const baseChannelId = ruleBasedRoute(taskType);

  let channelId = baseChannelId;
  let decision = JEV_RULE_DEFAULT;
  let confidence = null;

  if (suggestion) {
    confidence = suggestion.confidence;
    const recommended = suggestion.channelId;
    // 置信度达标 且 推荐通道确实可用（启用中、未熔断）才采纳
    if (suggestion.confidence >= JEV_CONFIDENCE_THRESHOLD && isChannelAvailable(recommended)) {
      channelId = recommended;
      decision = recommended;
    }
  }

  // 4. 落库：request_id 与 call_logs.request_id / 响应头 X-Request-Id 同源，可关联查询
  const recorded = safelyRecordJevDecision({
    requestId,
    inputSummary: suggestion?.inputSummary ?? summarizeInput(requestContent),
    confidence,
    decision
  });

  return { channelId, jev: { decision, confidence, recorded } };
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
