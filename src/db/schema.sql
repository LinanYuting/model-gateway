-- channels 表：三类通道配置
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('free', 'sponsored', 'aiping')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'unhealthy', 'unconfigured', 'unknown')),
  last_probe_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  circuit_open_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- tokens 表：访问令牌与配额（配额单位：LLM token 数，UI 以 M 为单位）
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  quota_limit INTEGER NOT NULL DEFAULT 100000000,
  used_count INTEGER NOT NULL DEFAULT 0,
  token_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- call_logs 表：调用记录
CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  channel_id TEXT,
  status_code INTEGER,
  latency_ms INTEGER,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  token_used INTEGER NOT NULL DEFAULT 0,
  -- 详细统计字段
  rounds INTEGER NOT NULL DEFAULT 1,
  tokens_per_sec REAL NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- alerts 表：告警记录
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- jev_decisions 表：Jev 语义路由决策记录（任务 1.4 起写入真实决策，Phase 1 仅建表）
-- 存量库（本机已有的 data/gateway.db）不会被 IF NOT EXISTS 重建，枚举约束由代码侧校验兜底；
-- 新建库按契约 §1 在数据库层直接约束。
CREATE TABLE IF NOT EXISTS jev_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  input_summary TEXT,
  confidence REAL,
  decision TEXT CHECK (decision IN ('free', 'sponsored', 'aiping', 'rule-default')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_call_logs_token ON call_logs(token_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_channel ON call_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
-- Jev 决策记录按 request_id 关联 call_logs / 响应头 X-Request-Id
CREATE INDEX IF NOT EXISTS idx_jev_decisions_request ON jev_decisions(request_id);