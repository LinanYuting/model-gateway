import { getDb } from '../db/index.js';

// ============================================================
// Jev 语义路由核心（任务 1.4）
// ------------------------------------------------------------
// Jev 是什么：一个"可选"的辅助决策模块 —— 看一眼请求内容，
// 建议这次该走哪条通道（free / sponsored / aiping）。
//
// 本期只做"接口 + 落库"（任务书原文：接入真实决策模型一步延后）：
//   · 决策器（classifier）通过 setJevClassifier() 注入；默认没有决策器，
//     也就是"Jev 不发表意见"，主链路行为与 Phase 1 完全一致。
//   · 决策结果按契约 §1 写入 jev_decisions 表，可用 request_id 与 call_logs 关联。
//   · 置信度 < 0.6 一律放弃 Jev 结论、回退规则路由，并记 decision = "rule-default"。
//   · 总开关 USE_JEV 关闭时，本文件的所有逻辑都不参与主链路（零额外开销）。
//   · Jev 调用失败（抛错 / 超时）不得阻断正常请求。
// ============================================================

// 契约 §1：decision 字段只能取这四个值（枚举约束）
export const JEV_DECISIONS = Object.freeze(['free', 'sponsored', 'aiping', 'rule-default']);

// 回退规则的标记值：表示"这次没采纳 Jev 的结论，是按基础规则走的"
export const JEV_RULE_DEFAULT = 'rule-default';

// 契约 §1：置信度低于该值必须放弃 Jev 结论
export const JEV_CONFIDENCE_THRESHOLD = 0.6;

// 决策器自身的超时保护：即使将来接了真实模型，也不能让网关无限等它。
// 默认 3s，调用方可用 { timeoutMs } 覆盖（测试里注入小值即可快速验证超时分支）。
export const DEFAULT_JEV_TIMEOUT_MS = 3000;

// input_summary 的长度上限：只存"摘要"，不把整段 prompt 抄进库
const MAX_SUMMARY_CHARS = 200;

// 当前挂载的决策器；null = 本期默认状态（不接模型）
let classifier = null;

/**
 * 注入决策器。决策器签名：
 *   (requestContent) => { channelId, confidence, summary? } | null
 * requestContent 形如 { messages, model, taskType }。
 * 传 null 表示卸载（回到"Jev 不发表意见"）。
 */
export function setJevClassifier(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new TypeError('Jev classifier must be a function or null');
  }
  classifier = fn;
}

export function hasJevClassifier() {
  return typeof classifier === 'function';
}

export function resetJevClassifier() {
  classifier = null;
}

/**
 * 总开关是否打开。契约 §0：USE_JEV 默认 false。
 * 这里每次调用都现读 process.env（而不是模块加载时读一次），
 * 这样测试可以在同一个进程里分别验证"开"和"关"两种状态。
 * 显式传 useJev=true 可强制打开（供上层/测试使用）。
 */
export function isJevEnabled(useJev = false) {
  if (useJev === true) return true;
  return process.env.USE_JEV === 'true';
}

// 把 OpenAI 风格的 content（字符串或多模态数组）压成纯文本
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * 生成 input_summary：取最后一条 user 消息，压成一行，超长截断。
 * 这样即使调用方贴了很长的 prompt，库里也只留一条便于排查的摘要。
 */
export function summarizeInput(requestContent) {
  if (!requestContent || typeof requestContent !== 'object') return null;

  const messages = Array.isArray(requestContent.messages) ? requestContent.messages : [];

  let text = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
      text = contentToText(msg.content);
      if (text.trim()) break;
    }
  }
  // 没有 user 消息时退回最后一条消息，至少留个线索
  if (!text.trim() && messages.length > 0) {
    text = contentToText(messages[messages.length - 1]?.content);
  }

  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > MAX_SUMMARY_CHARS
    ? oneLine.slice(0, MAX_SUMMARY_CHARS - 1) + '…'
    : oneLine;
}

// 给决策器套一个超时：超时就当它失败，绝不无限等待
function withTimeout(run, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Jev classifier timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    Promise.resolve()
      .then(run)
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

// 把决策器返回的东西整理成统一格式；不合规一律视为"没有结论"
function normalizeResult(raw, requestContent) {
  if (!raw || typeof raw !== 'object') return null;

  const channelId = raw.channelId ?? raw.decision ?? null;
  // 只接受三条真实通道；"rule-default" 是回退标记，决策器不能直接报它
  if (!JEV_DECISIONS.includes(channelId) || channelId === JEV_RULE_DEFAULT) return null;

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) return null;

  return {
    channelId,
    // 防御性收敛到 0~1，避免决策器给出 1.5 / -0.2 这种越界值
    confidence: Math.min(1, Math.max(0, confidence)),
    inputSummary: raw.summary
      ? String(raw.summary).replace(/\s+/g, ' ').slice(0, MAX_SUMMARY_CHARS)
      : summarizeInput(requestContent)
  };
}

/**
 * 问 Jev 要一个建议。
 * 返回 null 表示"没有可用结论"（没接决策器 / 决策器报错 / 超时 / 返回值不合规）。
 * 注意：置信度不足 0.6 的结论也会原样返回（带 confidence），
 * 由调用方（router）决定是否采纳并记录 —— 这样库里能看到模型当时到底多自信。
 */
export async function JevRoute(requestContent, { timeoutMs = DEFAULT_JEV_TIMEOUT_MS } = {}) {
  if (typeof classifier !== 'function') return null; // 本期默认：没接模型，不发表意见

  let raw;
  try {
    raw = await withTimeout(() => classifier(requestContent), timeoutMs);
  } catch (error) {
    // 任务书：Jev 调用失败不得阻断正常请求 —— 一律降级为"没有结论"
    return null;
  }

  return normalizeResult(raw, requestContent);
}

/**
 * 写一条决策记录（契约 §1 字段）。
 * decision 必须属于枚举，否则抛 TypeError（这是程序员错误，不是运行时错误）。
 */
export function recordJevDecision({ requestId, inputSummary, confidence, decision }) {
  if (!requestId) {
    throw new TypeError('recordJevDecision requires requestId');
  }
  if (!JEV_DECISIONS.includes(decision)) {
    throw new TypeError(
      `Invalid jev decision: ${JSON.stringify(decision)} (allowed: ${JEV_DECISIONS.join(', ')})`
    );
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO jev_decisions (request_id, input_summary, confidence, decision)
    VALUES (?, ?, ?, ?)
  `).run(
    requestId,
    inputSummary ?? null,
    Number.isFinite(confidence) ? confidence : null,
    decision
  );
}

/**
 * 落库但绝不抛错：决策记录只是"可观测性"，不能因为它写失败就毁掉用户请求。
 * 返回 true/false 便于上层观测。
 */
export function safelyRecordJevDecision(payload) {
  try {
    recordJevDecision(payload);
    return true;
  } catch (error) {
    return false;
  }
}

/** 按 request_id 查决策记录（对应响应头 X-Request-Id） */
export function getJevDecisionsByRequestId(requestId) {
  const db = getDb();
  return db.prepare('SELECT * FROM jev_decisions WHERE request_id = ? ORDER BY id').all(requestId);
}
