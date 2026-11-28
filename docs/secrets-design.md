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
