import { ChannelPlugin } from './ChannelPlugin.js';
import axios from 'axios';

function normalizeEndpoint(endpoint) {
  const base = String(endpoint).replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export class SponsoredChannel extends ChannelPlugin {
  constructor(id, name, enabled = false, config = {}) {
    super(id, name, enabled, config);
    this.type = 'sponsored';
    this.healthStatus = 'unconfigured';
    this.lastProbeAt = null;
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

  async forward(payload) {
    const { endpoint, model } = this.config;
    const apiKeys = this.getApiKeys();
    
    if (!endpoint) {
      throw new Error('Sponsored channel not configured: missing endpoint');
    }
    if (apiKeys.length === 0) {
      throw new Error('Sponsored channel not configured: missing apiKey(s)');
    }

    let lastError;
    for (const apiKey of apiKeys) {
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
            timeout: 30000
          }
        );
        
        this.recordSuccess();
        return {
          success: true,
          data: response.data,
          latency: Date.now() - startTime,
          channel: this.id
        };
      } catch (error) {
        this.recordFailure();
        lastError = error;
        // 继续尝试下一个 key
      }
    }
    
    throw new Error(`Sponsored channel forward failed after trying all keys: ${lastError?.message || 'unknown error'}`);
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

    // 只用第一个 key 做健康检查
    const testKey = apiKeys[0];
    try {
      await axios.get(normalizeEndpoint(endpoint).replace('/chat/completions', '/models'), {
        timeout: 10000,
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