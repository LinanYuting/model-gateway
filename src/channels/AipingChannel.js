import { ChannelPlugin } from './ChannelPlugin.js';
import axios from 'axios';

// aiping 通道对接的是 AI Ping（https://aiping.cn）——兼容 OpenAI 接口的模型聚合平台。
// 它的接口约定是：
//   · 对话：POST {base}/chat/completions
//   · 模型列表：GET  {base}/models
// 用户在配置里填的 endpoint 可能是 base 地址（例如 https://aiping.cn/api/v1），
// 也可能已经带了 /chat/completions（和 free 通道的写法一致），两种都要能用，
// 所以统一在这里补齐路径，而不是要求用户记住"该填哪一个"。
function normalizeEndpoint(endpoint) {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

// 健康检查打的是"模型列表"接口：拿到 200 就说明域名通、钥匙有效。
// 它和对话接口共用同一个 base，所以把 /chat/completions 去掉再补 /models。
function modelsEndpoint(endpoint) {
  const base = String(endpoint ?? '').trim().replace(/\/+$/, '');
  return `${base.replace(/\/chat\/completions$/, '')}/models`;
}

// 只有这两种上游错误值得"换一把钥匙再试"：
//   429 = 这把钥匙被限流了
//   5xx = 上游服务器自己坏了
// 其它错误（400 参数写错、401 钥匙无效）换钥匙也没用，直接如实报出，
// 免得一次参数错误就把所有钥匙都记上一笔失败、误触发熔断。
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

export class AipingChannel extends ChannelPlugin {
  constructor(id, name, enabled = false, config = {}) {
    super(id, name, enabled, config);
    this.type = 'aiping';
    this.healthStatus = 'unconfigured';
    this.lastProbeAt = null;

    // 轮询游标：记录"下次该从第几把钥匙开始"。它只是个下标数字，不含密钥内容。
    this.keyCursor = 0;
  }

  // 从配置里取钥匙：支持新写法 apiKeys: [] 与旧写法单个 apiKey。
  // 顺手把空字符串、纯空格过滤掉——空的"钥匙"既发不出去，也容易让人误以为已经配好了。
  getApiKeys() {
    const raw = Array.isArray(this.config.apiKeys) && this.config.apiKeys.length > 0
      ? this.config.apiKeys
      : (this.config.apiKey ? [this.config.apiKey] : []);

    return raw
      .filter(key => typeof key === 'string')
      .map(key => key.trim())
      .filter(key => key.length > 0);
  }

  // "配好了没有"：地址和至少一把钥匙都得有。
  // 未配置不是故障，healthCheck 会据此返回 false 且把状态记成 unconfigured（任务书 1.2）。
  isConfigured() {
    const endpoint = String(this.config.endpoint ?? '').trim();
    return endpoint.length > 0 && this.getApiKeys().length > 0;
  }

  // 一次请求最多试几把钥匙：从配置读（config.maxAttempts），默认"有几把试几把"。
  getAttemptBudget(keyCount) {
    const configured = Number(this.config.maxAttempts ?? keyCount);
    const attempts = Number.isFinite(configured) ? Math.floor(configured) : keyCount;
    return Math.max(1, Math.min(attempts, Math.max(keyCount, 1)));
  }

  // 把 axios 抛出的错误整理成一条可观测记录：只记状态码/错误类型/消息，绝不记密钥。
  describeError(error) {
    const status = error?.response?.status ?? null;
    return {
      status,
      type: error?.response?.data?.error?.type ?? null,
      message: error?.message || 'unknown error',
      retriable: isRetriableStatus(status)
    };
  }

  async forward(payload) {
    const endpoint = String(this.config.endpoint ?? '').trim();
    const apiKeys = this.getApiKeys();
    const model = this.config.model;

    // 没配置就不要发请求：抛出可读的错误，由路由层决定是否兜底到别的通道。
    if (!endpoint) {
      throw new Error('Aiping channel not configured: missing endpoint');
    }
    if (apiKeys.length === 0) {
      throw new Error('Aiping channel not configured: missing apiKey(s)');
    }

    // 超时时长从配置读（config.timeoutMs），不配时沿用 30000ms。
    const timeoutMs = Number(this.config.timeoutMs ?? 30000);
    const start = this.keyCursor % apiKeys.length;
    const budget = this.getAttemptBudget(apiKeys.length);
    const attempts = [];

    for (let n = 0; n < budget; n++) {
      const keyIndex = (start + n) % apiKeys.length;
      const apiKey = apiKeys[keyIndex];
      const startTime = Date.now();

      try {
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

        attempts.push({ keyIndex, status: response.status, error: null });
        this.recordSuccess();
        this.keyCursor = (keyIndex + 1) % apiKeys.length;

        return {
          success: true,
          data: response.data,
          latency: Date.now() - startTime,
          channel: this.id,
          keyCount: apiKeys.length,
          attempts
        };
      } catch (error) {
        const info = this.describeError(error);
        attempts.push({ keyIndex, status: info.status, error: info });
        this.recordFailure();

        if (!info.retriable) {
          // 不是 429/5xx：换钥匙没用，如实报出。
          this.keyCursor = (keyIndex + 1) % apiKeys.length;
          const err = new Error(
            `Aiping channel forward failed: non-retryable error on key #${keyIndex} (${info.status ?? 'no response'}): ${info.message}`
          );
          err.attempts = attempts;
          err.keyCount = apiKeys.length;
          throw err;
        }
        // 429 / 5xx：继续试下一把。
      }
    }

    this.keyCursor = (start + 1) % apiKeys.length;
    const summary = attempts
      .map(a => `#${a.keyIndex}: ${a.error.status ?? 'no response'} ${a.error.message}`)
      .join('; ');
    const err = new Error(`Aiping channel forward failed after trying all keys: ${summary}`);
    err.attempts = attempts;
    err.keyCount = apiKeys.length;
    throw err;
  }

  // 健康检查（任务书 1.2 的核心条款）：
  //   · 配置为空 → 返回 false，状态记 unconfigured，不抛异常、也不发任何网络请求；
  //   · 配置好了 → GET {base}/models，200 记 healthy，否则 unhealthy；
  //   · 无论发生什么（地址写错、DNS 炸了、超时）都只是返回 false，绝不让异常冒出去，
  //     否则后台 60s 一次的探测任务会被未处理的 Promise 打断。
  async healthCheck() {
    try {
      if (!this.isConfigured()) {
        this.healthStatus = 'unconfigured';
        return false;
      }

      const testKey = this.getApiKeys()[0];
      await axios.get(modelsEndpoint(this.config.endpoint), {
        // 探测超时单独可配（config.healthTimeoutMs），比业务请求更短，避免拖慢探测轮次。
        timeout: Number(this.config.healthTimeoutMs ?? 10000),
        headers: { 'Authorization': `Bearer ${testKey}` }
      });

      this.healthStatus = 'healthy';
      this.recordSuccess();
      return true;
    } catch (error) {
      // 走到这里有两种可能：地址/钥匙配错了（401/404），或者网络问题。
      // 都是"配置了但不可用"，记 unhealthy；如果是配置本身写错，日志里能看到原因。
      this.healthStatus = 'unhealthy';
      this.recordFailure();
      return false;
    } finally {
      this.lastProbeAt = new Date().toISOString();
    }
  }

  // 配置快照（契约 §5 要求的方法之一）。
  // 在基类字段之外补两个"状态位"，方便看板/排障时一眼看出通道是不是还没配置：
  //   configured —— 地址和钥匙是否齐备（未配置时健康检查根本不会发请求）
  //   keyCount   —— 配了几把钥匙（只是数量，不含钥匙内容）
  toJSON() {
    return {
      ...super.toJSON(),
      configured: this.isConfigured(),
      keyCount: this.getApiKeys().length
    };
  }
}
