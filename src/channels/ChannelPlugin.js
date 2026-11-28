// 标准通道插件接口
import { sanitizeConfigForOutput } from '../services/secrets.js';

export class ChannelPlugin {
  constructor(id, name, enabled = false, config = {}) {
    this.id = id;
    this.name = name;
    this.enabled = enabled;
    this.config = config;
    this.failureCount = 0;
    this.circuitOpenUntil = null;
  }

  // 子类必须实现
  async forward(payload) {
    throw new Error('forward() must be implemented by subclass');
  }

  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }

  getConfig() {
    return { ...this.config };
  }

  setConfig(config) {
    this.config = { ...this.config, ...config };
  }

  // 整体替换配置（密钥解析流程用：合并语义会把上一轮的字段残留下来）
  replaceConfig(config) {
    this.config = { ...config };
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      enabled: this.enabled,
      // 密钥一律脱敏（任务 1.3）：后台接口不能再把明文 key 吐出去
      config: sanitizeConfigForOutput(this.config),
      healthStatus: this.healthStatus || 'unknown',
      lastProbeAt: this.lastProbeAt || null
    };
  }

  // 熔断相关
  isCircuitOpen() {
    if (!this.circuitOpenUntil) return false;
    const now = new Date();
    if (now >= this.circuitOpenUntil) {
      // 冷却结束，半开状态
      this.circuitOpenUntil = null;
      this.failureCount = 0;
      return false;
    }
    return true;
  }

  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= 3) {
      this.circuitOpenUntil = new Date(Date.now() + 60000); // 60s cooldown
    }
  }

  recordSuccess() {
    this.failureCount = 0;
    this.circuitOpenUntil = null;
  }
}