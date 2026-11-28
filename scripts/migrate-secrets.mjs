#!/usr/bin/env node
// 存量明文密钥迁移脚本（任务 1.3 / 第二轮安全审查第 4 条）
//
// 用法：
//   node scripts/migrate-secrets.mjs                  # 就地加密改写 data/gateway.db（自动先备份）
//   node scripts/migrate-secrets.mjs --dry-run        # 只看会改什么，不写库、不备份
//   node scripts/migrate-secrets.mjs --db ./data/x.db # 指定库文件
//   node scripts/migrate-secrets.mjs --no-backup      # 不生成 .bak 备份（自己已另外备份时）
//   node scripts/migrate-secrets.mjs --restore ./data/gateway.db.bak-20260101-120000 --yes
//                                                     # 用备份覆盖当前库（回滚用，必须显式 --yes）
//
// 安全设计：
//   * 写库前先把库文件整份拷贝成 `<db>.bak-<时间戳>`，并打印路径
//   * 全部改写放在一个 IMMEDIATE 事务里：要么全成，要么全不动
//   * busy_timeout=5000：迁移时若还有别的进程在写，先等一会儿而不是立刻报 SQLITE_BUSY
//   * 提交后逐条解密校验，校验不过就自动把备份还原回去，并提示目录里的备份文件
//   * 幂等：已经全是密文/环境变量引用的库，重复执行只报告 0 改动
//   * 没有 GATEWAY_SECRET 时不写任何东西，退出码 1

import fs from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import {
  MASTER_KEY_ENV,
  MASTER_KEY_PREVIOUS_ENV,
  hasMasterKey,
  migrateConfig,
  decryptSecretWithInfo,
  getMasterKeyId,
  isEncrypted,
  ENCRYPTED_PREFIX
} from '../src/services/secrets.js';

function parseArgs(argv) {
  const options = { dryRun: false, dbPath: null, backup: true, restorePath: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--db') {
      options.dbPath = argv[++i];
    } else if (arg === '--no-backup') {
      options.backup = false;
    } else if (arg === '--restore') {
      options.restorePath = argv[++i];
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
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

  node scripts/migrate-secrets.mjs [--dry-run] [--db <path>] [--no-backup]
  node scripts/migrate-secrets.mjs --restore <backup> --yes

  --dry-run      只报告，不写库、不备份
  --db <p>       指定 SQLite 文件（默认取 DB_PATH，否则 ./data/gateway.db）
  --no-backup    跳过 <db>.bak-<时间戳> 备份
  --restore <b>  用备份文件覆盖当前库（需要 --yes 才会真的写）
`);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
}

/** 迁移前把整份库拷一份（WAL 先落盘，保证备份里数据是全的） */
function createBackup(db, dbPath) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_error) {
    // 不是 WAL 模式或没有权限，忽略
  }
  const backupPath = `${dbPath}.bak-${timestamp()}`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function summarizeKeys(config) {
  const enc = Array.isArray(config.apiKeysEnc) ? config.apiKeysEnc.length : 0;
  const refs = Array.isArray(config.apiKeyRefs) ? config.apiKeyRefs.length : 0;
  const legacy = (Array.isArray(config.apiKeys) ? config.apiKeys.filter(Boolean).length : 0)
    + (typeof config.apiKey === 'string' && config.apiKey.trim() ? 1 : 0);
  return { enc, refs, legacy };
}

function handleRestore(options) {
  const dbPath = resolve(options.dbPath || process.env.DB_PATH || './data/gateway.db');
  const backupPath = resolve(options.restorePath);
  if (!fs.existsSync(backupPath)) {
    console.error(`找不到备份文件：${backupPath}`);
    return 1;
  }
  if (!options.yes) {
    console.error('恢复会覆盖当前数据库，属于破坏性操作。确认无误后请加 --yes 再执行。');
    console.error(`将执行：用 ${backupPath} 覆盖 ${dbPath}`);
    return 1;
  }
  fs.copyFileSync(backupPath, dbPath);
  // 旧的 WAL/SHM 还留着就可能把旧数据又叠回去，一并清掉
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  console.log(`已用备份恢复：${backupPath} → ${dbPath}`);
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (options.restorePath) return handleRestore(options);

  const dbPath = resolve(options.dbPath || process.env.DB_PATH || './data/gateway.db');
  if (!fs.existsSync(dbPath)) {
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

  // 并发写入风险提示：WAL 非空说明很可能有别的进程（正在跑的网关）在写
  const walPath = `${dbPath}-wal`;
  if (!options.dryRun && fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    console.warn(`[警告] 检测到 ${walPath} 非空，可能有其他进程正在写这个库（例如正在运行的网关）。`);
    console.warn('       建议先停掉网关再迁移；脚本会用 IMMEDIATE 事务 + busy_timeout 尽量避开竞争，');
    console.warn('       但并发写入期间仍可能读到旧配置。');
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  let closed = false;
  const closeDb = () => {
    if (closed) return;
    closed = true;
    db.close();
  };

  try {
    const rows = db.prepare('SELECT id, name, config_json FROM channels ORDER BY id').all();
    console.log(`数据库：${dbPath}`);
    console.log(`模式：${options.dryRun ? 'dry-run（不写库）' : '就地改写'}`);
    if (process.env[MASTER_KEY_PREVIOUS_ENV]) {
      console.log(`主密钥指纹：${getMasterKeyId()}（另配了上一版主密钥，仅用于解密过渡）`);
    } else {
      console.log(`主密钥指纹：${getMasterKeyId()}`);
    }
    console.log(`通道数：${rows.length}\n`);

    const update = db.prepare("UPDATE channels SET config_json = ?, updated_at = datetime('now') WHERE id = ?");
    let changedChannels = 0;
    let changedKeys = 0;
    const changedIds = [];
    const expectedCounts = new Map();

    const applyChanges = () => {
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
          // 没配主密钥 / 加密失败：整批回滚，绝不写半截
          throw new Error(`通道 ${row.id} 迁移失败（${error.message}）`);
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
        changedIds.push(row.id);
        expectedCounts.set(row.id, (result.config.apiKeysEnc || []).length);

        const after = summarizeKeys(result.config);
        console.log(
          `- ${row.id}：明文 ${before.legacy} 把 → 密文 ${after.enc} 把`
          + `（前缀 ${ENCRYPTED_PREFIX.slice(0, ENCRYPTED_PREFIX.length - 1)}…）`
        );

        if (!options.dryRun) {
          update.run(JSON.stringify(result.config), row.id);
        }
      }
    };

    const transaction = db.transaction(applyChanges);

    let backupPath = null;
    if (options.dryRun) {
      transaction(); // dry-run 不改库，用普通事务即可
    } else {
      if (options.backup) {
        backupPath = createBackup(db, dbPath);
        console.log(`已备份到：${backupPath}\n`);
      } else {
        console.log('已按 --no-backup 跳过备份。\n');
      }
      transaction.immediate(); // IMMEDIATE：一开始就拿写锁，避免与并发写入交错
    }

    console.log(`\n完成：${changedChannels} 个通道被改写，共 ${changedKeys} 把密钥加密。`);
    if (options.dryRun) {
      console.log('dry-run 模式：数据库未做任何修改。去掉 --dry-run 再执行一次即可真正写入。');
      return 0;
    }
    if (changedChannels === 0) {
      console.log('（幂等检查：再跑一次也只会是这个结果）');
    }

    // 提交后校验：每条密文都要能解开，且把旧主密钥解密的情况报出来（轮换过渡期很有用）
    // 配了 GATEWAY_SECRET_PREVIOUS 时顺带体检**所有**通道的密文，而不只是本次改写的那些。
    const hasPreviousKey = Boolean(process.env[MASTER_KEY_PREVIOUS_ENV]);
    const verifyIds = hasPreviousKey ? rows.map((row) => row.id) : changedIds;
    const verifyProblems = [];
    let previousKeyUsed = 0;
    for (const id of verifyIds) {
      const row = db.prepare('SELECT config_json FROM channels WHERE id = ?').get(id);
      let config;
      try {
        config = JSON.parse(row.config_json || '{}');
      } catch (_error) {
        verifyProblems.push(`${id}：写回后不是合法 JSON`);
        continue;
      }
      const encrypted = Array.isArray(config.apiKeysEnc) ? config.apiKeysEnc : [];
      if (expectedCounts.has(id) && encrypted.length !== expectedCounts.get(id)) {
        verifyProblems.push(`${id}：密文条数不符（期望 ${expectedCounts.get(id)}，实际 ${encrypted.length}）`);
      }
      for (const item of encrypted) {
        if (!isEncrypted(item)) {
          verifyProblems.push(`${id}：写回后出现非密文内容`);
          continue;
        }
        try {
          const info = decryptSecretWithInfo(item);
          if (info.usedPreviousKey) previousKeyUsed += 1;
        } catch (error) {
          verifyProblems.push(`${id}：新密文解密失败（${error.message}）`);
        }
      }
    }

    if (verifyProblems.length > 0) {
      console.error('\n[校验失败] 迁移后的数据不可用：');
      for (const problem of verifyProblems) console.error(`  - ${problem}`);
      if (backupPath) {
        closeDb();
        fs.copyFileSync(backupPath, dbPath);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = dbPath + suffix;
          if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        }
        console.error(`已自动从备份还原：${backupPath}`);
      } else {
        console.error('本次使用了 --no-backup，没有自动备份可还原，请手工从自己的备份恢复。');
      }
      return 1;
    }

    console.log(`校验通过：${changedKeys} 条密文均可正常解密。`);
    if (previousKeyUsed > 0) {
      console.log(
        `提示：其中 ${previousKeyUsed} 条是用 ${MASTER_KEY_PREVIOUS_ENV} 解开的，`
        + '说明主密钥换过、还没全量重加密（下一阶段 rotate-secret.mjs 负责重加密）。'
      );
    }
    if (backupPath) {
      console.log(`备份保留在：${backupPath}（确认无误后可自行删除；需要回滚时用 --restore 加 --yes）`);
    }
    return 0;
  } catch (error) {
    console.error(`\n迁移失败：${error.message}`);
    console.error('事务已回滚，数据库保持迁移前的状态。');
    return 1;
  } finally {
    closeDb();
  }
}

process.exitCode = main();
