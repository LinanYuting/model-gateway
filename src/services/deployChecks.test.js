// 部署期安全检查（第二轮安全审查 1、2）单元测试
// 只用临时目录构造 .env / .gitignore，不碰真实配置。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  checkEnvFilePermissions,
  isEnvFileIgnored,
  collectStartupSecurityWarnings,
  logStartupSecurityChecks
} from './deployChecks.js';
import { MASTER_KEY_ENV, resetSecretCache, getMasterKeyId } from './secrets.js';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-deploy-checks-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.ADMIN_TOKEN;
  delete process.env.NODE_ENV;
  delete process.env[MASTER_KEY_ENV];
  resetSecretCache();
});

describe('.env 权限检查', () => {
  test('文件不存在时返回 exists=false 并提示', () => {
    const result = checkEnvFilePermissions(path.join(tempDir, '.env'));

    assert.strictEqual(result.exists, false);
    assert.ok(result.warnings.length >= 1);
  });

  test('POSIX 下权限过宽给出 chmod 600 建议', { skip: process.platform === 'win32' }, () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'A=1\n');
    fs.chmodSync(envPath, 0o644);

    const result = checkEnvFilePermissions(envPath);
    assert.strictEqual(result.exists, true);
    assert.ok(result.warnings.some((warning) => warning.includes('chmod 600')), result.warnings.join('|'));
  });

  test('POSIX 下 600 不告警', { skip: process.platform === 'win32' }, () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'A=1\n');
    fs.chmodSync(envPath, 0o600);

    assert.deepStrictEqual(checkEnvFilePermissions(envPath).warnings, []);
  });
});

describe('.env 是否被 .gitignore 覆盖', () => {
  test('存在 .env 行 → 已忽略', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\ndata/\n.env\n');
    assert.strictEqual(isEnvFileIgnored(tempDir), true);
  });

  test('.env* 通配也算已忽略', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.env*\n');
    assert.strictEqual(isEnvFileIgnored(tempDir), true);
  });

  test('没有 .env 行 → 未忽略（要告警）', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');
    assert.strictEqual(isEnvFileIgnored(tempDir), false);
  });

  test('没有 .gitignore → 未忽略', () => {
    assert.strictEqual(isEnvFileIgnored(tempDir), false);
  });
});

describe('启动安全提示汇总', () => {
  test('未配 ADMIN_TOKEN 时提示，且区分生产环境文案', () => {
    const devMessages = collectStartupSecurityWarnings(tempDir).map((item) => item.message);
    assert.ok(devMessages.some((message) => message.includes('ADMIN_TOKEN') && message.includes('回环')));

    process.env.NODE_ENV = 'production';
    const prodMessages = collectStartupSecurityWarnings(tempDir).map((item) => item.message);
    assert.ok(prodMessages.some((message) => message.includes('ADMIN_TOKEN') && message.includes('拒绝')));
  });

  test('配了 ADMIN_TOKEN 就不再提示', () => {
    process.env.ADMIN_TOKEN = 'some-token';
    const messages = collectStartupSecurityWarnings(tempDir).map((item) => item.message);
    assert.ok(!messages.some((message) => message.includes('ADMIN_TOKEN')));
  });

  test('主密钥已配时打印指纹（不含密钥本身），未配时告警', () => {
    process.env[MASTER_KEY_ENV] = 'deploy-check-master-secret';
    resetSecretCache();

    const items = collectStartupSecurityWarnings(tempDir);
    const info = items.find((item) => item.level === 'info' && item.message.includes('指纹'));
    assert.ok(info, '应有一条 info 指纹');
    assert.ok(info.message.includes(getMasterKeyId()));
    assert.ok(!info.message.includes('deploy-check-master-secret'), '日志里不得出现主密钥明文');

    delete process.env[MASTER_KEY_ENV];
    resetSecretCache();
    const warnings = collectStartupSecurityWarnings(tempDir).map((item) => item.message);
    assert.ok(warnings.some((message) => message.includes(MASTER_KEY_ENV)));
  });

  test('.env 未被 gitignore 覆盖时提示', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

    const messages = collectStartupSecurityWarnings(tempDir).map((item) => item.message);
    assert.ok(messages.some((message) => message.includes('.env') && message.includes('.gitignore')));
  });

  test('logStartupSecurityChecks 统一带 [Security] 前缀', () => {
    const lines = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args) => lines.push(args.join(' '));
    console.log = (...args) => lines.push(args.join(' '));

    try {
      logStartupSecurityChecks(tempDir);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(line.startsWith('[Security] '), line);
  });
});
