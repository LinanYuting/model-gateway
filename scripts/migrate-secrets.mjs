#!/usr/bin/env node
// 存量明文密钥迁移脚本（任务 1.3）
//
// 用法：
//   node scripts/migrate-secrets.mjs                  # 就地加密改写 data/gateway.db
//   node scripts/migrate-secrets.mjs --dry-run        # 只看会改什么，不写库
//   node scripts/migrate-secrets.mjs --db ./data/x.db # 指定库文件
//
// 幂等：已经全是密文/环境变量引用的库，重复执行只会报告 0 改动。
// 没有 GATEWAY_SECRET 时不写任何东西，退出码 1。

import { existsSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { MASTER_KEY_ENV, hasMasterKey, migrateConfig, ENCRYPTED_PREFIX } from '../src/services/secrets.js';

function parseArgs(argv) {
  const options = { dryRun: false, dbPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--db') {
      options.dbPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      console.error(`未知参数：${arg}`);
      options.help = true;
    }
  }
  return options;
}

function usage() {
  console.log(`存量明文密钥迁移（任务 1.3）

  node scripts/migrate-secrets.mjs [--dry-run] [--db <path>]

  --dry-run   只报告，不写库
  --db <p>    指定 SQLite 文件（默认取 DB_PATH，否则 ./data/gateway.db）
`);
}

function summarizeKeys(config) {
  const enc = Array.isArray(config.apiKeysEnc) ? config.apiKeysEnc.length : 0;
  const refs = Array.isArray(config.apiKeyRefs) ? config.apiKeyRefs.length : 0;
  const legacy = (Array.isArray(config.apiKeys) ? config.apiKeys.filter(Boolean).length : 0)
    + (typeof config.apiKey === 'string' && config.apiKey.trim() ? 1 : 0);
  return { enc, refs, legacy };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const dbPath = resolve(options.dbPath || process.env.DB_PATH || './data/gateway.db');
  if (!existsSync(dbPath)) {
    console.error(`找不到数据库文件：${dbPath}`);
    console.error('（迁移脚本不会创建新库；请确认 DB_PATH 或 --db 指向现有文件）');
    return 1;
  }

  if (!hasMasterKey()) {
    console.error(`未配置主密钥环境变量 ${MASTER_KEY_ENV}，无法加密改写。`);
    console.error(`请先设置，例如：  $env:${MASTER_KEY_ENV} = "<你的随机长口令>"   （PowerShell）`);
    console.error('  export GATEWAY_SECRET="<你的随机长口令>"                      （bash）');
    console.error('本次未写入任何数据。');
    return 1;
  }

  const db = new Database(dbPath);
  try {
    const rows = db.prepare('SELECT id, name, config_json FROM channels ORDER BY id').all();
    console.log(`数据库：${dbPath}`);
    console.log(`模式：${options.dryRun ? 'dry-run（不写库）' : '就地改写'}`);
    console.log(`通道数：${rows.length}\n`);

    const update = db.prepare("UPDATE channels SET config_json = ?, updated_at = datetime('now') WHERE id = ?");
    let changedChannels = 0;
    let changedKeys = 0;

    const run = db.transaction(() => {
      for (const row of rows) {
        let config;
        try {
          config = JSON.parse(row.config_json || '{}');
        } catch (_error) {
          console.log(`- ${row.id}：config_json 不是合法 JSON，跳过`);
          continue;
        }

        const before = summarizeKeys(config);
        let result;
        try {
          result = migrateConfig(config);
        } catch (error) {
          console.log(`- ${row.id}：迁移失败（${error.message}），跳过`);
          continue;
        }

        if (!result.changed) {
          const state = before.enc > 0
            ? `已是密文（${before.enc} 把）`
            : (before.refs > 0 ? `已用环境变量引用（${before.refs} 个）` : '无密钥');
          console.log(`- ${row.id}：无需改动（${state}）`);
          continue;
        }

        changedChannels += 1;
        changedKeys += result.keyCount;
        const after = summarizeKeys(result.config);
        console.log(
          `- ${row.id}：明文 ${before.legacy} 把 → 密文 ${after.enc} 把`
          + `（前缀 ${ENCRYPTED_PREFIX.slice(0, ENCRYPTED_PREFIX.length - 1)}…）`
        );

        if (!options.dryRun) {
          update.run(JSON.stringify(result.config), row.id);
        }
      }
    });

    run();

    console.log(`\n完成：${changedChannels} 个通道被改写，共 ${changedKeys} 把密钥加密。`);
    if (options.dryRun) {
      console.log('dry-run 模式：数据库未做任何修改。去掉 --dry-run 再执行一次即可真正写入。');
    } else if (changedChannels === 0) {
      console.log('（幂等检查：再跑一次也只会是这个结果）');
    }
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main();
