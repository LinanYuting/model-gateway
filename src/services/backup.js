import cron from 'node-cron';
import { getDb } from '../db/index.js';
import { getChannel, listChannels } from './channelRegistry.js';
import { isCircuitOpen } from './circuitBreaker.js';
import fs from 'fs';
import path from 'path';

let healthProbeInterval = null;
let backupCronJob = null;

export function startHealthProbe() {
  const intervalMs = parseInt(process.env.HEALTH_PROBE_INTERVAL_MS || '60000');
  
  // 立即执行一次
  runHealthProbe();
  
  // 定时执行
  healthProbeInterval = setInterval(runHealthProbe, intervalMs);
  console.log(`[HealthProbe] Started, interval: ${intervalMs}ms`);
}

export async function runHealthProbe() {
  const channels = listChannels();
  
  for (const ch of channels) {
    if (!ch.enabled) continue;
    
    const channel = getChannel(ch.id);
    if (!channel) continue;
    
    try {
      const healthy = await channel.healthCheck();

      // "没配置"和"配置了但坏了"是两回事（任务书 1.2）：
      // 未配置的通道（比如默认关闭、还没填地址和钥匙的 aiping）健康状态要保留 unconfigured，
      // 也不能每 60 秒刷一条「健康检查失败」告警——那不是故障，只是还没启用。
      const healthStatus = channel.healthStatus === 'unconfigured'
        ? 'unconfigured'
        : (healthy ? 'healthy' : 'unhealthy');

      const db = getDb();
      db.prepare(`
        UPDATE channels 
        SET health_status = ?, last_probe_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(healthStatus, ch.id);
      
      if (healthStatus === 'unhealthy' && !isCircuitOpen(ch.id)) {
        // 记录告警
        db.prepare('INSERT INTO alerts (level, message) VALUES (?, ?)').run(
          'warning',
          `Channel ${ch.name} (${ch.id}) health check failed`
        );
      }
    } catch (error) {
      console.error(`[HealthProbe] Error probing ${ch.id}:`, error.message);
    }
  }
}

export function startBackupCron() {
  const cronExpr = process.env.BACKUP_CRON || '0 0 * * *';
  
  backupCronJob = cron.schedule(cronExpr, () => {
    runBackup();
  });
  
  console.log(`[Backup] Scheduled with cron: ${cronExpr}`);
}

export function runBackup() {
  const db = getDb();
  const backupDir = path.join(process.cwd(), 'backups');
  
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `gateway-${timestamp}.db`);
  
  try {
    // 使用 better-sqlite3 的 backup 方法
    db.backup(backupPath);
    
    // 清理 7 天前的备份
    cleanupOldBackups(backupDir, 7);
    
    console.log(`[Backup] Backup created: ${backupPath}`);
    return { success: true, path: backupPath };
  } catch (error) {
    console.error('[Backup] Backup failed:', error);
    return { success: false, error: error.message };
  }
}

function cleanupOldBackups(backupDir, keepDays) {
  const files = fs.readdirSync(backupDir).filter(f => f.startsWith('gateway-') && f.endsWith('.db'));
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  
  for (const file of files) {
    const filePath = path.join(backupDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      console.log(`[Backup] Cleaned old backup: ${file}`);
    }
  }
}

export function stopServices() {
  if (healthProbeInterval) {
    clearInterval(healthProbeInterval);
    healthProbeInterval = null;
  }
  if (backupCronJob) {
    backupCronJob.stop();
    backupCronJob = null;
  }
}