// 免费通道进程内滑动窗口限流（CONTRACT §2：仅作用于 type==='free' 的通道）
const WINDOW_MS = 60 * 1000;

// channelId -> number[] 请求时间戳（升序）
const windows = new Map();

export function getFreeChannelRpm() {
  const rpm = parseInt(process.env.FREE_CHANNEL_RPM || '30', 10);
  return Number.isFinite(rpm) ? rpm : 30;
}

export function acquire(channelId, { rpm = getFreeChannelRpm(), now = Date.now() } = {}) {
  if (!(rpm > 0)) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };

  const key = channelId;
  const hits = (windows.get(key) || []).filter(t => now - t < WINDOW_MS);

  if (hits.length >= rpm) {
    windows.set(key, hits);
    const retryAfterSec = Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  hits.push(now);
  windows.set(key, hits);
  return { allowed: true, remaining: rpm - hits.length, retryAfterSec: 0 };
}

export function resetWindow(channelId) {
  if (channelId) windows.delete(channelId);
  else windows.clear();
}
