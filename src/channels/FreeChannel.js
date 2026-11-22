import { ChannelPlugin } from './ChannelPlugin.js';
import axios from 'axios';

// OFM 默认免费端点（本地转发，无需 API Key）
const DEFAULT_ENDPOINT = 'http://localhost:18900/v1/chat/completions';

export class FreeChannel extends ChannelPlugin {
  constructor(id, name, enabled = false, config = {}) {
    super(id, name, enabled, config);
    this.type = 'free';
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
    // 免费通道：无 key 也可使用（基于 OFM 默认免费池）
    return [];
  }

  async forward(payload) {
    const { endpoint, model } = this.config;
    const apiKeys = this.getApiKeys();
    const targetEndpoint = endpoint || DEFAULT_ENDPOINT;

    if (!model) {
      throw new Error('Free channel not configured: missing model');
    }

    let lastError;
    // 免费通道：如果没有 apiKey，则不发送 Authorization 头（基于 OFM 免费池）
    const keysToTry = apiKeys.length > 0 ? apiKeys : [null];
    for (const apiKey of keysToTry) {
      const startTime = Date.now();
      try {
        const headers = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await axios.post(
          targetEndpoint,
          { ...payload, model: model || payload.model },
          {
            headers,
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
      }
    }
    
    throw new Error(`Free channel forward failed: ${lastError?.message || 'unknown error'}`);
  }

  async healthCheck() {
    const { endpoint } = this.config;
    const targetEndpoint = endpoint || DEFAULT_ENDPOINT;

    const headers = {};
    const apiKey = this.getApiKeys()[0];
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      await axios.get(targetEndpoint.replace('/chat/completions', '/models'), {
        headers,
        timeout: 10000
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