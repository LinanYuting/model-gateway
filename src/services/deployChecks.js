// 部署期安全检查（第二轮安全审查 第 1、2 条）
//
// 这里只做"启动时能提示就提示"的检查，不阻断启动（生产环境由 adminAuth 兜底拒绝服务）：
//   1. ADMIN_TOKEN 有没有配 —— 空着意味着后台接口对公网开放，必须让人看见
//   2. GATEWAY_SECRET 有没有配 —— 空着意味着无法加密落库密钥
//   3. .env 文件权限 —— POSIX 下要求只有属主可读写（600），Windows 交由 icacls 人工确认
//   4. .env 是否被 .gitignore 覆盖 —— 防止主密钥被 push 上去

import fs from 'fs';
import path from 'path';
import { hasMasterKey, MASTER_KEY_ENV, getMasterKeyId } from './secrets.js';

/**
 * .env 文件权限检查。Windows 的 mode 位不可信（Node 统一报 0o666），因此只对 POSIX 判定，
 * Windows 给出"请用 icacls 自查"的提示而不误报失败。
 * @returns {{ exists: boolean, warnings: string[] }}
 */
export function checkEnvFilePermissions(envPath) {
  if (!fs.existsSync(envPath)) {
    return { exists: false, warnings: [`未找到 ${path.basename(envPath)}（使用外部环境变量注入也算合规）`] };
  }

  const warnings = [];
  if (process.platform === 'win32') {
    warnings.push('Windows 下请用 icacls 确认 .env 仅当前用户可读（本检查不自动判定 ACL）');
    return { exists: true, warnings };
  }

  const stat = fs.statSync(envPath);
  const groupOrOtherBits = stat.mode & 0o077;
  if (groupOrOtherBits !== 0) {
    warnings.push(
      `${path.basename(envPath)} 权限过宽（mode=${(stat.mode & 0o777).toString(8)}），`
      + `建议 chmod 600 ${path.basename(envPath)}`
    );
  }
  return { exists: true, warnings };
}

/** .env 是否被 .gitignore 覆盖 */
export function isEnvFileIgnored(projectRoot, envFileName = '.env') {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return false;
  const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  return lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    return trimmed === envFileName || trimmed === `/${envFileName}` || trimmed === `${envFileName}*`;
  });
}

/**
 * 汇总启动期安全检查结果。
 * @returns {{ level: 'warn'|'info', message: string }[]}
 */
export function collectStartupSecurityWarnings(projectRoot, envFileName = '.env') {
  const results = [];
  const envPath = path.join(projectRoot, envFileName);

  if (!process.env.ADMIN_TOKEN) {
    const scope = process.env.NODE_ENV === 'production' ? '生产环境下 /api/admin/* 将拒绝所有请求' : '未配时仅允许本机回环访问';
    results.push({ level: 'warn', message: `ADMIN_TOKEN 未设置：${scope}（任务1.3 安全审查）` });
  }

  if (!hasMasterKey()) {
    results.push({ level: 'warn', message: `${MASTER_KEY_ENV} 未设置：无法加密落库密钥，写明文会被拒绝` });
  } else {
    results.push({ level: 'info', message: `主密钥指纹 ${getMasterKeyId()}（不含密钥本身，可用于核对备份）` });
  }

  const envCheck = checkEnvFilePermissions(envPath);
  for (const warning of envCheck.warnings) {
    results.push({ level: 'warn', message: warning });
  }

  if (!isEnvFileIgnored(projectRoot, envFileName)) {
    results.push({ level: 'warn', message: `${envFileName} 没有被 .gitignore 覆盖，存在误提交风险` });
  }

  return results;
}

/** 把检查结果打到日志（启动时调用） */
export function logStartupSecurityChecks(projectRoot, envFileName = '.env') {
  for (const item of collectStartupSecurityWarnings(projectRoot, envFileName)) {
    const line = `[Security] ${item.message}`;
    if (item.level === 'warn') console.warn(line);
    else console.log(line);
  }
}
