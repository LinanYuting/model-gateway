# 任务 1.3 密钥存储安全化 · 设计说明

> 提交评审用。评审通过后按本方案实施（代码已在同一 PR 内，若方案被否决可只回退实现部分）。

## 一、现状问题

`channels.config_json` 里明文存着 `apiKey` / `apiKeys`。风险有两个，都不是"理论风险"：

1. **数据文件带密钥**：`data/gateway.db` 一旦被拷走、被备份服务收走、或在排障时误发，密钥就泄露了。
2. **接口把密钥再吐一遍**：`GET /api/admin/channels`、`GET /api/dashboard/channels` 都直接返回
   `channel.toJSON()`，其中 `config` 就是原始配置对象 → 后台接口会**原样返回明文密钥**。
   `ADMIN_TOKEN` 默认是空的（开放），这一条比数据库泄露更容易被碰到。

## 二、方案：密文落库为主，环境变量引用为辅

`config_json` 里的密钥字段改为下面两种形态之一，**不再写明文**：

| 形态 | 字段 | 说明 |
|---|---|---|
| 加密落库 | `apiKeysEnc: string[]` | 每把 key 单独加密：`enc:v1:<iv>:<tag>:<密文>`，算法 AES-256-GCM |
| 环境变量引用 | `apiKeyRefs: string[]` | 只存环境变量**名**（如 `SPONSORED_KEY_1`），运行时从 `process.env` 取值，值根本不落库 |

- **主密钥**：环境变量 `GATEWAY_SECRET`。用 `scrypt(secret, 'model-gateway:secrets:v1', 32)` 派生 32 字节。
  每次加密随机 12 字节 IV，所以同一把 key 每次写入的密文都不同。
- **fail-closed**：没配 `GATEWAY_SECRET` 时，**拒绝把明文密钥写库**，直接返回 400 并提示改用
  `apiKeyRefs` 或先配主密钥 —— 绝不"配不上就退回明文"，那样等于没做。
- **两种来源互斥**：同一通道只用一种。同时提交时以 `apiKeyRefs` 为准（运维显式指定优先）。

## 三、读取与输出

- **读取**：`channelRegistry.loadChannels()` 加载时统一 `hydrateConfig()` —— 解密 / 读环境变量 /
  兼容旧明文，合并成运行时明文数组，只存在于**进程内存**里。通道插件（Free/Sponsored/Aiping）
  的 `getApiKeys()` 无需改动。
- **输出**：`ChannelPlugin.toJSON()` 统一走 `sanitizeConfigForOutput()` —— 密钥脱敏成
  `sk-1…cdef`（≤8 位一律 `****`），密文与内部来源信息不出现在响应里，只多给一个 `keyCount`。
  这样后台接口即使被访问也拿不到密钥。
- **写入**：`updateChannelConfig()` 先把调用方提交的明文 `apiKeys` 加密成 `apiKeysEnc` 再落库；
  内存里存解析后的明文。落库对象由 `toPersistableConfig()` 生成，**物理上不可能**带明文 key 字段。

## 四、存量数据兼容与迁移

- 旧明文 `apiKey` / `apiKeys` **仍然可读**（`resolveApiKeyEntries()` 第三优先级，读时打一条
  `[Secrets] 检测到明文密钥，建议执行迁移` 警告），所以升级后老库能直接跑，不会一升级就全挂。
- 迁移脚本：`node scripts/migrate-secrets.mjs [--dry-run] [--db <path>]`
  - 逐通道把明文加密改写为 `apiKeysEnc`，打印每个通道"改了/跳过"及耗时
  - **幂等**：已是密文/引用的通道直接跳过，重复执行第二次报告 0 改动
  - 没有主密钥时以退出码 1 结束并提示先配 `GATEWAY_SECRET`，不写入任何东西
  - `--dry-run` 只报告不改库，便于先看影响面
- 存量明文在**被管理员改配置时**也会自动加密一次（`sealPersistedConfig()`），避免"改了个 model
  结果密钥丢了"或"又把明文写回去"。
- `data/` 仍在 `.gitignore` 中（第 2 行），迁移只改库内容、不改入库策略，`git ls-files data` 依然为空。

## 五、验收对应

| 验收条款 | 对应实现 | 覆盖测试 |
|---|---|---|
| 新写入的配置不含明文密钥 | `sealIncomingConfig()` + `toPersistableConfig()` | `channelRegistry.secrets.test.js`、`admin.secrets.test.js` |
| 迁移方案可复现 | `scripts/migrate-secrets.mjs`（幂等 + dry-run） | `migrateSecrets.test.js`（用子进程真跑脚本） |
| `data/` 保持不入库 | `.gitignore` 第 2 行 | `secrets.test.js` 末尾断言 |

测试总量：本任务新增 57 条用例（`secrets.test.js` 37、`channelRegistry.secrets.test.js` 8、
`migrateSecrets.test.js` 6、`admin.secrets.test.js` 6），全量 `node --test src` 由 113 增至 170，
在 `USE_JEV` 开 / 关两种状态下各 170/170 通过。

## 六、需要评审确认的点

1. 主密钥变量名用 `GATEWAY_SECRET` 是否可以（还是统一叫 `CONFIG_SECRET`）？
2. 生产环境主密钥放哪儿：`.env`（已被 gitignore）够不够，还是要接 KMS / 系统密钥环？
   本期按 `.env` + `apiKeyRefs` 实现。
3. 是否需要"密钥轮换"（换主密钥后重新加密全部密文）？本期未做，需要的话下一阶段补
   `scripts/rotate-secret.mjs`。

---

# 第二轮安全审查补充（2026-11-28）

## 七、密钥轮换设计（本期只做"准备"，不做脚本）

### 7.1 当前密文和主密钥怎么关联

- 密文格式 `enc:v1:<iv>:<tag>:<密文>`：带的是**算法版本**（v1），**不带**是哪个主密钥做的。
  格式里没有 keyId，所以解密时只能"拿主密钥试"——这正是本轮安全审查要明确的第一件事。
- 一个进程里"当前主密钥"全局唯一（`GATEWAY_SECRET`），`config_json` 里所有 `apiKeysEnc`
  共享它。于是：**换主密钥 = 所有密文同时失效**，没有"按 key 选择性解密"的可能。
  这既是约束，也说明轮换必须**全量重加密**，不能半途。
- 为了方便运维核对（不改格式、不影响兼容），新增了两个只读能力：
  - `getMasterKeyId()`：`sha256(派生后的 32 字节)` 的前 8 位十六进制，例如 `3f9a1c02`。
    **由密钥单向算出、不能反推密钥**，只用于在日志、备份说明、轮换报告里标注"这批密文是哪把密钥做的"。
  - 启动时会打印一行 `[Security] 主密钥指纹 xxxxxxxx（不含密钥本身，可用于核对备份）`。
- 轮换过渡期支持：`GATEWAY_SECRET_PREVIOUS`（**只用于解密**）。
  设置后 `decryptSecret()` 先用当前密钥，失败再用上一版密钥；成功时会标记 `usedPreviousKey`，
  让调用方知道"这条还没重加密"。这样换密钥时可以先把两个变量都配上，重启后服务不中断。

### 7.2 给下一阶段 `scripts/rotate-secret.mjs` 的步骤设计

1. **前置**：`GATEWAY_SECRET` = 新主密钥，`GATEWAY_SECRET_PREVIOUS` = 旧主密钥；
   `node scripts/migrate-secrets.mjs --dry-run` 会提示"有几条是用上一版主密钥解开的"（体检）。
2. **备份**：复用 `createBackup()` 的逻辑，先把库整份拷成 `<db>.bak-<时间戳>`，并打印 `getMasterKeyId()`
   的旧/新指纹到迁移报告里。
3. **事务**：`db.transaction(...).immediate()` + `busy_timeout`，把"逐通道解密 → 重新加密 → 写回"
   全部放进一个事务；任何一条失败就整体回滚。
4. **重加密规则**：对每个通道的 `apiKeysEnc`：
   `明文 = decryptSecretWithInfo(item).plain` → `新密文 = encryptSecret(明文)` → 原地替换。
   引用型（`apiKeyRefs`）和明文残留按现有 `migrateConfig()` 规则处理，不碰环境变量值。
5. **校验**：提交后逐条用新密钥解密验证条数一致、内容一致（本轮 `migrate-secrets.mjs` 已有同样逻辑，
   直接复用）；校验失败自动用第 2 步的备份还原。
6. **收尾**：确认全部 `usedPreviousKey === false` 后，提示运维把 `GATEWAY_SECRET_PREVIOUS`
   从 `.env` 删掉并重启——旧密钥一旦留着，泄露它就等于泄露过去的全部密文。
7. 轮换期间网关可以不停机（`GATEWAY_SECRET_PREVIOUS` 保证旧密文还能解），但**不要在有写请求时**
   做全量重加密，建议低峰执行。

> 本期落地的部分：`getMasterKeyId()`、`GATEWAY_SECRET_PREVIOUS` 解密回退、
> `decryptSecretWithInfo().usedPreviousKey`、迁移脚本的"轮换体检 + 旧密钥条数提示"。
> 真正执行重加密的 `rotate-secret.mjs` 不在本期范围（安全审查第 5 条：本期不强制实现）。

## 八、部署安全清单（第二轮审查 1、2 条）

| 项 | 做法 | 代码里的保障 |
|---|---|---|
| 后台接口鉴权 | 生产必须配 `ADMIN_TOKEN`；开发环境不配时只允许**本机回环**访问 | `src/middleware/adminAuth.js`：`NODE_ENV=production` 或 `REQUIRE_ADMIN_TOKEN=true` 且未配 token → **503 `ADMIN_TOKEN_REQUIRED`**；非回环 → **403**；token 比较用 `timingSafeEqual` |
| 主密钥存放 | 只放 `.env`（已被 `.gitignore` 排除）或平台注入的环境变量；不写死在代码/配置里 | `.env.example` 给生成命令；`deployChecks.js` 启动时检查 `.gitignore` 覆盖 |
| 文件权限 | POSIX：`chmod 600 .env`；Windows：`icacls .env /inheritance:r /grant:r "%USERNAME%":F` | 启动检查 POSIX 下 `mode & 0o077`，过宽则告警；Windows 只提示自查，不误报 |
| 不进日志 | 日志只打**主密钥指纹**（8 位），密文/明文都不打 | `deployChecks.js` 只输出 `getMasterKeyId()`；`secrets.js` 错误信息不含密钥（有测试断言） |
| 不进备份 | 定时备份只拷 `data/*.db`，**不碰 `.env`**，所以备份里只有密文 | `src/services/backup.js` 只备份数据库；主密钥放 `.env` 天然不进备份 |
| 环境变量引用范围 | 只允许形如 `SPONSORED_KEY_1` 的变量名；**禁止**引用 `GATEWAY_SECRET`/`ADMIN_TOKEN`/`DATABASE_PASSWORD` 等内部敏感变量 | `assertEnvRefName()`：格式错 → `INVALID_REF_NAME`；命中保留名单或含 `SECRET`/`PASSWORD`/`CREDENTIAL`/`PRIVATE_KEY`/`GATEWAY_` 前缀 → `RESERVED_REF_NAME` |
| 引用的变量必须存在 | 写配置时校验变量当前有值，否则 400 `ENV_REF_NOT_FOUND`（点名缺哪个变量） | `sealIncomingConfig()`；确需"先写配置后注入密钥"时设 `ALLOW_MISSING_ENV_REFS=true`（会在接口里显示 `missingApiKeyRefs`） |
| 迁移可回滚 | 迁移前自动备份、事务化、提交后校验、失败自动还原 | `scripts/migrate-secrets.mjs`（`--no-backup` 可跳过备份；`--restore <bak> --yes` 手工回滚） |

### 8.1 第二轮新增 / 调整的验收对应

| 审查条款 | 对应实现 | 覆盖测试 |
|---|---|---|
| ① 后台接口安全 | `adminAuth.js` 重写（回环限制、生产 503、timing-safe 比较） | `adminAuth.test.js` 7 条、`admin.secrets.test.js` 末尾 401 条 |
| ② 主密钥保护 | `deployChecks.js`（权限、gitignore、指纹日志）、备份不含 `.env` | `deployChecks.test.js`、`secrets.test.js` 错误信息不含密钥 |
| ③ 引用限制 | `assertEnvRefName()`、`RESERVED_ENV_REF_NAMES`、`ENV_REF_NOT_FOUND` | `secrets.test.js`「环境变量引用限制」9 条、`admin.secrets.test.js` 两个 400 |
| ④ 迁移可靠性 | 备份 + IMMEDIATE 事务 + busy_timeout + 校验 + 自动还原 + `--restore` | `migrateSecrets.test.js` 12 条（含备份内容为明文、`--no-backup`、restore 需 `--yes`） |
| ⑤ 轮换准备 | `getMasterKeyId()`、`GATEWAY_SECRET_PREVIOUS` 解密回退、`usedPreviousKey` | `secrets.test.js`「主密钥指纹与轮换过渡」7 条、迁移脚本轮换体检 1 条 |

测试总量：本轮新增 41 条（`secrets.test.js` +16、`deployChecks.test.js` 19（2 条仅 POSIX 生效）、
`migrateSecrets.test.js` +6、`admin.secrets.test.js` +3、`adminAuth.test.js` +4），
全量 `node --test src` 由 170 增至 **211**，`USE_JEV` 开 / 关各 **209 通过 + 2 跳过（Windows 跳过 POSIX 权限用例）**。

## 九、本轮遗留风险（需组长知悉）

1. **`ADMIN_TOKEN` 的开发态放宽**：不配 token 时允许本机回环访问，这是为了保住"本机 Demo 直接能用"。
   若部署在反向代理后面（`req.socket.remoteAddress` 是代理地址），即使同一台机器也会被判定为非回环 →
   403。生产部署请务必配 `ADMIN_TOKEN`（配了就不受回环限制）。
2. **`timingSafeEqual` 只能比较等长字符串**：长度不同会直接判失败（不抛错、也不泄露长度以外的信息）。
3. **`ALLOW_MISSING_ENV_REFS` 是逃生开关**：打开后可能写出"引用存在但没值"的配置，服务表现为该通道未配置
   （`missingApiKeyRefs` 会显示在接口里）。默认关闭。
4. **Windows 上无法自动判定 `.env` 的 ACL**：只提示用 `icacls` 自查；POSIX 才有 `chmod 600` 的自动判定。
5. **轮换脚本未实现**：本期只准备了解密回退与指纹；真正重加密留给 `rotate-secret.mjs`（见第七节步骤）。
6. **迁移期间并发写入**：脚本用 `IMMEDIATE` 事务 + `busy_timeout=5000` 尽量避开，并会检测 `-wal` 非空给出警告，
   但仍建议**先停网关再迁移**。

