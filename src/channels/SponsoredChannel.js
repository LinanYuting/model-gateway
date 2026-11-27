import { ChannelPlugin } from './ChannelPlugin.js';
import axios from 'axios';

function normalizeEndpoint(endpoint) {
  const base = String(endpoint).replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

// 只有这两种上游错误值得"换一把钥匙重试"：
//   429 = 这把钥匙被限流了（太频繁）
//   5xx = 上游服务器自己坏了
// 其它错误（比如 400 参数写错）换多少把钥匙都一样，直接如实报出。
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

export class SponsoredChannel extends ChannelPlugin {
  constructor(id, name, enabled = false, config = {}) {
    super(id, name, enabled, config);
    this.type = 'sponsored';
    this.healthStatus = 'unconfigured';
    this.lastProbeAt = null;

    // 轮询游标：记住"下次该从第几把钥匙开始"。
    // 它只是个下标数字，不是密钥本身，绝不会泄露 key 内容。
    this.keyCursor = 0;
  }

  // 从配置中获取 API keys 数组
  getApiKeys() {
    if (Array.isArray(this.config.apiKeys) && this.config.apiKeys.length > 0) {
      return this.config.apiKeys;
    }
    // 兼容旧配置：单个 apiKey
    if (this.config.apiKey) {
      return [this.config.apiKey];
    }
    return [];
  }

  // 一次请求最多试几把钥匙：从配置读（config.maxAttempts），默认"有几把试几把"。
  // 上限不会被允许超过钥匙总数——同一把钥匙连续试两次没有意义。
  getAttemptBudget(keyCount) {
    const configured = Number(this.config.maxAttempts ?? keyCount);
    const attempts = Number.isFinite(configured) ? Math.floor(configured) : keyCount;
    return Math.max(1, Math.min(attempts, Math.max(keyCount, 1)));
  }

  // 把 axios 抛出的错误整理成一条"可观测记录"。
  // 只记编号、状态码、错误类型和消息 —— 绝不记密钥本身。
  describeError(error) {
    const status = error?.response?.status ?? null;
    return {
      status,
      type: error?.response?.data?.error?.type ?? null,
      message: error?.message || 'unknown error',
      retriable: isRetriableStatus(status)
    };
  }

  // 轮询 + 换钥匙的公共骨架：forward（一次性）和 forwardStream（流式）共用，
  // 差别只在 executor 里"怎么发这一个请求、成功时长什么样"。
  async tryKeys({ payload, label, executor }) {
    const { endpoint, model } = this.config;
    const apiKeys = this.getApiKeys();

    // 超时时长从配置读（config.timeoutMs），不再硬编码在代码里。
    // 不配时仍沿用原来的 30000ms，保证老配置行为不变。
    const timeoutMs = Number(this.config.timeoutMs ?? 30000);

    if (!endpoint) {
      throw new Error('Sponsored channel not configured: missing endpoint');
    }
    if (apiKeys.length === 0) {
      throw new Error('Sponsored channel not configured: missing apiKey(s)');
    }

    // 从游标位置开始绕一圈：本次从 start 号钥匙起步。
    const start = this.keyCursor % apiKeys.length;
    const budget = this.getAttemptBudget(apiKeys.length);
    const attempts = [];

    for (let n = 0; n < budget; n++) {
      const keyIndex = (start + n) % apiKeys.length; // 绕到末尾就回到 0
      const apiKey = apiKeys[keyIndex];
      const startTime = Date.now();

      try {
        const outcome = await executor({ apiKey, keyIndex, startTime, endpoint, model, timeoutMs, payload });

        attempts.push({ keyIndex, status: outcome.status, error: null });
        this.recordSuccess();

        // 下次从"这把的下一把"开始 —— 这就是轮询的关键一行。
        this.keyCursor = (keyIndex + 1) % apiKeys.length;

        return {
          ...outcome.result,
          success: true,
          channel: this.id,
          keyCount: apiKeys.length, // 便于看懂 keyIndex 的取值范围
          attempts                  // 本次用过哪几把、各自结果如何
        };
      } catch (error) {
        const info = this.describeError(error);
        // 流式请求失败时，错误响应体是个流，用完要销毁，否则会漏 socket。
        if (typeof error?.response?.data?.destroy === 'function') {
          error.response.data.destroy();
        }

        attempts.push({ keyIndex, status: info.status, error: info });

        // 记账本逻辑保持原样（每失败一把记一笔）——这一处的设计矛盾
        // 留待向组长确认后再动，本期不改。
        this.recordFailure();

        if (!info.retriable) {
          // 不是 429/5xx：换钥匙没用，如实报出，并把 attempts 挂在错误上。
          this.keyCursor = (keyIndex + 1) % apiKeys.length;
          const err = new Error(
            `Sponsored channel ${label} failed: non-retryable error on key #${keyIndex} (${info.status ?? 'no response'}): ${info.message}`
          );
          err.attempts = attempts;
          err.keyCount = apiKeys.length;
          throw err;
        }

        // 429 / 5xx：已经把这一把的错误记进 attempts，继续试下一把。
      }
    }

    // 所有钥匙都被 429/5xx 挡回来了。
    // 下次从起点的下一把开始，避免每次都从同一把倒霉钥匙起步。
    this.keyCursor = (start + 1) % apiKeys.length;
    const summary = attempts
      .map(a => `#${a.keyIndex}: ${a.error.status ?? 'no response'} ${a.error.message}`)
      .join('; ');
    const err = new Error(`Sponsored channel ${label} failed after trying all keys: ${summary}`);
    err.attempts = attempts;
    err.keyCount = apiKeys.length;
    throw err;
  }

  async forward(payload) {
    return this.tryKeys({
      payload,
      label: 'forward',
      executor: async ({ apiKey, startTime, endpoint, model, timeoutMs }) => {
        const response = await axios.post(
          normalizeEndpoint(endpoint),
          { ...payload, model: model || payload.model },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            timeout: timeoutMs
          }
        );

        return {
          status: response.status,
          result: { data: response.data, latency: Date.now() - startTime }
        };
      }
    });
  }

  // 流式转发（任务书 1.1b）：把上游的 SSE 流原样交给调用方，逐块透传、不收齐整包。
  // 返回的 stream 是 Node Readable，读取它就是在读上游字节。
  async forwardStream(payload) {
    return this.tryKeys({
      payload,
      label: 'stream',
      executor: async ({ apiKey, startTime, endpoint, model, timeoutMs }) => {
        const response = await axios.post(
          normalizeEndpoint(endpoint),
          { ...payload, model: model || payload.model, stream: true },
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Authorization': `Bearer ${apiKey}`
            },
            timeout: timeoutMs,
            // 关键：不要让 axios 把上游攒成一个完整响应，直接拿到可读流。
            responseType: 'stream'
          }
        );

        return {
          status: response.status,
          result: {
            stream: response.data,
            latency: Date.now() - startTime,
            contentType: response.headers?.['content-type'] || null
          }
        };
      }
    });
  }

  async healthCheck() {
    const { endpoint } = this.config;
    const apiKeys = this.getApiKeys();

    if (!endpoint) {
      this.healthStatus = 'unconfigured';
      this.lastProbeAt = new Date().toISOString();
      return false;
    }
    if (apiKeys.length === 0) {
      this.healthStatus = 'unconfigured';
      this.lastProbeAt = new Date().toISOString();
      return false;
    }

    // 只用第一把钥匙做健康检查
    const testKey = apiKeys[0];
    try {
      await axios.get(normalizeEndpoint(endpoint).replace('/chat/completions', '/models'), {
        timeout: Number(this.config.healthTimeoutMs ?? 10000),
        headers: { 'Authorization': `Bearer ${testKey}` }
      });
      this.healthStatus = 'healthy';
      this.recordSuccess();
      return true;
    } catch (error) {
      this.healthStatus = 'unhealthy';
      this.recordFailure();
      return false;
    } finally {
      this.lastProbeAt = new Date().toISOString();
    }
  }
}
