# 轻量化模型调度网关 · 本地部署手册

> 对应契约版本：`CONTRACT.md`（状态：已冻结，阶段 2）
> 适用对象：需要在本机从零跑起网关的组员、以及阶段 3 联调的同学
> 编写：组员 4 ｜ 最后更新：2026-11-23

**本手册的用法**：手册即测试。请逐条照着做，任何一步走不通就是文档缺陷，直接提 issue。
表格里的「验证状态」列说明该步骤在本机是否已实际跑通：

- ✅ **实测通过** — 2026-11-23 在本机（Windows 11 / 用户 ozo）实际执行并记录输出
- ⚠️ **待验证** — 步骤来自官方文档或契约，但本机受条件限制未完整执行，需你复核

---

## 0. 前置条件

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11、macOS 12+、Linux | 本手册以 Windows 为主，Linux/macOS 差异处单独标注 |
| Node.js | **20.x**（`package.json` 硬约束 `>=20 <21`） | 用 21/22 会被 `engines` 拒绝，且 `better-sqlite3` 二进制不匹配 |
| npm | 随 Node 20 附带（10.x） | 本机为 10.8.2 |
| Git | 2.30+ | 本机为 2.55.0 |
| 磁盘 | ≥ 500 MB 可用 | 网关依赖约 20 MB，OFM 源码仓更大 |
| 网络 | 能访问 GitHub 与 npm registry | 国内网络见 §8，有已知拦截 |

**端口占用约定**（契约 §0，不可自行改动）：

| 角色 | 网关端口 | 数据库文件 |
|---|---|---|
| 组长 | 3000 | `./data/gateway.db` |
| 组员 1 | 3001 | 建议 `./data/gateway-member1-3001.db` |
| 组员 2 | 3002 | 建议 `./data/gateway-member2-3002.db` |
| 组员 3 | 3003 | 建议 `./data/gateway-member3-3003.db` |
| 组员 4 | 3004 | `./data/gateway-member4-3004.db` |
| OFM 独立服务 | 18900 | `~/.our-free-model`（由 OFM 自管） |
| mock channel | 18901 | 无（进程内假上游） |

> 端口与 `DB_PATH` 必须成对隔离。两人共用一个 db 文件会互相覆盖 `call_logs` 与配额，且 SQLite 写锁冲突会导致 500。

---

## 1. 安装 Node.js 20

### 1.1 推荐路径：nvm-windows（需要管理员权限）

```powershell
winget install CoreyButler.NVMforWindows
# 重开一个终端后
nvm install 20.20.2
nvm use 20.20.2
node -v   # 应输出 v20.20.2
```

⚠️ **待验证**：nvm-windows 的 MSI 安装会请求 UAC 提权，并在 `node` 命令位置创建软链，**非管理员账户装不上**（本机即属此情况，报错后转 1.2）。装完后如果发现 `node -v` 仍是旧版本，多半是旧 Node 的目录优先级更高，需在「环境变量」里把 `%APPDATA%\nvm` 提到 PATH 最前。

### 1.2 兜底路径：便携版（无需管理员，删目录即回滚）

```bash
# 下载（国内用 npmmirror 镜像，GitHub Release 常被墙）
curl -L -o node20.zip \
  https://registry.npmmirror.com/-/binary/node/v20.20.2/node-v20.20.2-win-x64.zip

# 解压到项目外的工具目录（不要放进仓库，否则会误提交）
mkdir -p /e/启航社/免费算力平台项目/.tools
unzip node20.zip -d /e/启航社/免费算力平台项目/.tools

# 每个新终端先挂到 PATH 最前面
export PATH="/e/启航社/免费算力平台项目/.tools/node-v20.20.2-win-x64:$PATH"
node -v   # v20.20.2
npm -v    # 10.8.2
```

✅ **实测通过**：`v20.20.2` / npm `10.8.2`，`process.versions.modules = 115`。

**回滚**：`rm -rf .tools/node-v20.20.2-win-x64`，系统环境零残留（没写注册表、没改全局 PATH）。

> 便携版有个副作用：**每开一个新终端都要重新 export PATH**，忘了就会用到系统里的旧 Node，表现为 `npm install` 报 `Unsupported engine`。建议在 `~/.bashrc` 里加一行 alias，或干脆记牢先 export。

---

## 2. 获取代码

### 2.1 标准流程（fork → clone，SSH 走 443）

**优先用 SSH，不要用 HTTPS。** 本机实测 HTTPS 克隆会被代理掐断（详见 §8），SSH 稳定可用。

先配好 SSH 走 443（一次性，只需做一遍）：

```bash
# 写入 ~/.ssh/config（Windows 下即 C:\Users\<你>\.ssh\config）
cat > ~/.ssh/config <<'EOF'
Host github.com
    HostName ssh.github.com
    Port 443
    User git
EOF

# 验证（应输出 Hi <你的用户名>! You've successfully authenticated...）
ssh -T git@github.com
```

> 如果提示 `Permission denied (publickey)`，说明本机还没有 SSH key：`ssh-keygen -t ed25519 -C "<你的邮箱>"`，然后把 `~/.ssh/id_ed25519.pub` 内容贴到 GitHub → Settings → SSH and GPG keys。
> 配置了这条之后，`git@github.com:xxx` 会自动走 `ssh.github.com:443`，命令行里不用再写端口。

然后：

```bash
# 先在自己 GitHub 账号下 fork：打开 github.com/LinanYuting/model-gateway 点 Fork
git clone git@github.com:<你的用户名>/model-gateway.git
cd model-gateway

# 把上游加为第二远程，方便日后同步
git remote add upstream git@github.com:LinanYuting/model-gateway.git

# 建工作分支（命名见 CONTRIBUTING.md：feature/<名字>-<主题>）
git checkout -b feature/<名字>-<主题>
```

✅ **实测通过**：`ssh -T git@github.com` 认证成功；`git ls-remote` 与 `git clone` 均正常，拿到完整历史（`41ece42` → `d6d69e5`）。

**顺带好处**：SSH 免去了 HTTPS 首次 push 要配 Personal Access Token 的麻烦，也不用担心 token 过期。

### 2.2 兜底流程（SSH 也不通时）

如果连 SSH 443 都连不上，说明网络限制更严。降级方案是拉 zip 快照：

```bash
curl -L -o repo.zip https://codeload.github.com/LinanYuting/model-gateway/zip/refs/heads/main
unzip repo.zip && mv model-gateway-main model-gateway && cd model-gateway
git init -b main
git remote add origin git@github.com:<你的用户名>/model-gateway.git
git add -A && git commit -m "chore: 导入上游 main 快照"
git checkout -b feature/<名字>-<主题>
```

⚠️ **代价（务必知情）**：本地**没有上游 git 历史**，`git log` 只有一条导入提交，PR 的 diff 基准是错的，评审时会看到"整个仓库都是新增"。只适合临时读代码，**不要用它提 PR**。拿到可用网络后必须重新 clone 真仓库，再把改动搬过去。

---

## 3. 安装依赖

```bash
npm install
```

✅ **实测通过**，126 个包，约 20 MB。

### 3.1 `better-sqlite3` 编译失败怎么办

`better-sqlite3@9.6.0` 装不上预编译包时会回落到 `node-gyp` 源码编译，Windows 上没装 Visual Studio C++ 工作负载就必然失败：

```
gyp ERR! find VS Could not find any Visual Studio installation to use
```

**原因**：预编译包默认从 GitHub Releases 下载，国内常超时，`prebuild-install` 静默失败后转源码编译。

**解法**（已验证）：

```bash
# 1) 先装依赖但跳过 install 脚本
npm install --registry=https://registry.npmmirror.com --ignore-scripts

# 2) 从镜像拉对应 ABI 的预编译包（Node 20 = ABI 115）
curl -L -o bs3.tar.gz \
  https://registry.npmmirror.com/-/binary/better-sqlite3/v9.6.0/better-sqlite3-v9.6.0-node-v115-win32-x64.tar.gz

# 3) 解压进模块目录（包内路径就是 build/Release/better_sqlite3.node）
tar -xzf bs3.tar.gz -C node_modules/better-sqlite3

# 4) 验证
node -e "const D=require('better-sqlite3');new D(':memory:').exec('create table t(a)');console.log('OK',process.versions.modules)"
```

✅ **实测通过**，输出 `OK 115`。

> 其他 Node 20 小版本的 ABI 都是 115，同一个包通用。若换成 Node 22（ABI 127）必须重新取包，否则报 `NODE_MODULE_VERSION mismatch`。

---

## 4. 配置 `.env`

```bash
cp .env.example .env
```

然后**至少改这两行**（以组员 4 为例）：

```ini
PORT=3004
DB_PATH=./data/gateway-member4-3004.db
```

### 4.1 逐变量说明（契约 §0）

| 变量 | 默认 | 必填 | 说明 |
|---|---|---|---|
| `PORT` | 3000 | ✅ | 网关监听端口。**按 §0 固定分配**，组员 4 = 3004。改错会和别人抢端口，表现为 `EADDRINUSE` |
| `DB_PATH` | `./data/gateway.db` | ✅ | SQLite 文件路径。**每人独立**，禁止共享、禁止提交（`data/` 已在 `.gitignore`）。目录不存在时启动会自动创建 |
| `OFM_ENDPOINT` | `http://localhost:18900/v1/chat/completions` | ✅ | 免费通道的上游地址。单机自测保持默认；换机联调时改成对方 IP |
| `MOCK_PORT` | 18901 | ⬜ | mock channel 端口，仅测试用。`npm test` 不依赖它常驻 |
| `USE_JEV` | `false` | ⬜ | Jev 语义路由总开关。**组员 1 的 1.4 合入前必须保持 `false`**，否则路由行为会偏离契约 §5 |
| `ADMIN_TOKEN` | 空 | ⬜ | 非空时，所有 `/api/admin/*` 与 `/api/dashboard/jev` 必须带 `x-admin-token` 头（契约 §6）。**留空 = 完全开放**，只能在本机开发用，联调/演示前必须设置 |
| `FREE_CHANNEL_RPM` | 30 | ⬜ | 免费通道每分钟请求上限（进程内滑动 60s 窗口）。`<=0` 表示不限。超限返回 429 `rate_limit_error` 并带 `Retry-After` |
| `QUOTA_WARN_PERCENT` | 80 | ⬜ | 配额使用率告警阈值。仅在**跨越**阈值那次请求写一条 `warning` 告警，不重复刷 |

**安全检查**：`.env` 已被 `.gitignore` 排除。提交前务必确认 `git status` 里没有它；本仓库的 `git add` 要求按文件名逐个执行。

---

## 5. 启动顺序：先 OFM（18900），后网关

顺序不能颠倒。网关启动时会做通道健康探测，OFM 没起来的话免费通道一路 `unconfigured`，主链路直接走不通。

### 5.1 启动 OFM 独立服务

OFM = Our Free Model，仓库 [`LinanYuting/dsh-our-free-model`](https://github.com/LinanYuting/dsh-our-free-model)。它是免费通道的上游，自带一套模型与账号渠道。

```bash
git clone https://github.com/LinanYuting/dsh-our-free-model.git
cd dsh-our-free-model
npm install

# 默认端口 18900、数据目录 ~/.our-free-model
npm run start:standalone

# 需要显式指定时：
npm run start:standalone -- --port 18900 --data-dir F:\ofm-data
```

⚠️ **待验证**：本机未安装 OFM，以下内容依据其仓库 `packages/standalone/README.md`，联调周需复核。

启动后终端会打印：管理页面的一次性登录链接（10 分钟有效、仅可兑换一次）、实际 API 地址、密钥文件位置。**不打印 API Key**。

验证：

```bash
curl http://localhost:18900/health     # 返回不含凭据的产品状态
```

**关键一步——取 API Key**：OFM 的推理接口要鉴权。Key 单独为本产品生成，存在数据目录（默认 `~/.our-free-model`）的 `settings.json` 中，字段名 `forwardKey`：

```bash
# 读取 forwardKey（Windows 下 ~ 即 C:\Users\<你>\）
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.our-free-model/settings.json','utf8')).forwardKey)"
```

拿到后带 Key 调用才算通：

```bash
curl http://localhost:18900/v1/models -H "Authorization: Bearer <forwardKey>"
```

> 这个 Key 是**明文敏感信息**，只写进本机配置，不入库、不截图、不发群。阶段 2 结束前密钥仍是明文存储（见风险说明）。

### 5.2 把 OFM 的 Key 接到网关的免费通道

网关的免费通道配置在数据库 `channels` 表的 `config_json` 里，结构 `{ endpoint, model, apiKey, apiKeys }`（契约 §1）。默认 `apiKey` 为空，需要填入上一步的 `forwardKey`：

```bash
# 在网关仓库目录执行；把 <forwardKey> 换成实际值
node -e "
const D=require('better-sqlite3');
const db=new D('./data/gateway-member4-3004.db');
const row=db.prepare(\"select config_json from channels where id='free'\").get();
const c=JSON.parse(row.config_json); c.apiKey='<forwardKey>';
db.prepare(\"update channels set config_json=? where id='free'\").run(JSON.stringify(c));
console.log('updated');
"
```

也可以走管理接口（需 `ADMIN_TOKEN` 为空或带上正确头）：

```bash
curl -X PUT http://localhost:3004/api/admin/channels/free \
  -H "Content-Type: application/json" \
  -d '{"config":{"endpoint":"http://localhost:18900/v1/chat/completions","model":"gpt-3.5-turbo","apiKey":"<forwardKey>"}}'
```

⚠️ **待验证**：`model` 字段需与 OFM `/v1/models` 返回的 id 一致，联调时按实际清单填。

> **阶段 2 提示**：以上是真实联调路径。跑 `npm test` **不需要** OFM 在跑——基线测试全部走 `test/mocks/mock-channel.mjs`（契约 §7），不依赖真实上游。

### 5.3 启动网关

```bash
cd model-gateway
npm start          # 等价于 node src/server.js
```

✅ **实测通过**，输出：

```
[DB] Seeded default channels
[DB] Database initialized at: ...\data\gateway-member4-3004.db
[ChannelRegistry] Loaded channels: [ 'free', 'sponsored', 'aiping' ]
[HealthProbe] Started, interval: 60000ms
[Backup] Scheduled with cron: 0 0 * * *
[Gateway] Server running on http://localhost:3004
```

开发时可用 `npm run dev`（`node --watch`，改代码自动重启）。

### 5.4 启动后自检

```bash
curl http://localhost:3004/health
# {"status":"ok","timestamp":"2026-11-23T05:49:06.221Z"}

curl http://localhost:3004/api/dashboard/summary
# {"totalRequests":0,"activeChannels":1,"totalChannels":3,"unresolvedAlerts":1,"timestamp":"..."}
```

✅ **实测通过**。浏览器打开 `http://localhost:3004/` 应看到看板。

几个数值怎么读：`activeChannels:1` 表示当前只有 free 通道健康（sponsored/aiping 默认 `enabled:false`，属正常）；`unresolvedAlerts:1` 是首次启动时 OFM 未就绪留下的健康告警，OFM 起来后通道恢复即不再新增。

---

## 6. 验收自检清单

| # | 检查项 | 期望 | 命令 |
|---|---|---|---|
| 1 | Node 版本 | `v20.x.x` | `node -v` |
| 2 | 依赖完整 | 无报错、`node_modules` 存在 | `npm ls --depth=0` |
| 3 | 基线测试 | **37 passed / 0 failed / 0 skipped** | 见 §6.1 |
| 4 | 端口正确 | 3004 | `grep '^PORT' .env` |
| 5 | DB 独立 | 文件名含 `member4` | `grep '^DB_PATH' .env` |
| 6 | 服务存活 | `{"status":"ok"}` | `curl localhost:3004/health` |
| 7 | 敏感文件未入库 | 输出为空 | `git status --porcelain \| grep -E "\.env$\|data/"` |

### 6.1 跑基线测试（Windows 有坑）

```bash
npm test
```

✅ **实测通过**：`# tests 37 / # pass 37 / # fail 0 / # skipped 0`

⚠️ **Windows 上 `npm test` 会假失败**。`package.json` 里是 `node --test src/**/*.test.js`，靠 shell 展开通配符；Linux/macOS 的 bash 能展开，Windows 的 `cmd.exe` 不会，于是 node 收到字面路径：

```
Could not find '...\model-gateway\src\**\*.test.js'
```

**危险点：此时退出码为 0，看起来像通过，实际一个测试都没跑。** 务必核对输出里的 `# tests 37`，而不是只看有没有红色。

绕过方式（二选一，均已实测）：

```bash
# 方式一：在 Git Bash 里直接执行
node --test src/**/*.test.js

# 方式二：让 npm 用 bash 执行脚本（路径按本机 Git 安装位置调整）
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
npm test
```

> 这是仓库级缺陷，已建议组长修复（改成显式列目录，或加 `test:win` 脚本）。修好之前，Windows 组员一律用上面两种方式。

---

## 7. 停服与清理

```bash
# 正常停服：前台 Ctrl+C
# 后台残留时（Windows）
taskkill //F //IM node.exe

# 清空本地数据，回到初始状态（.env 保留）
rm -rf data/
```

> `taskkill /IM node.exe` 会杀掉**所有** node 进程，包括其他项目的 dev server。更精确的写法是先 `netstat -ano | findstr :3004` 查 PID，再 `taskkill /F /PID <pid>`。

**误提交回滚**：

```bash
git restore --staged .env      # 已 add 未 commit
git rm --cached .env           # 已 commit，从跟踪中移除（本地文件保留）
```

---

## 8. 国内网络已知问题

按踩坑概率排序：

| 现象 | 原因 | 处理 |
|---|---|---|
| `git clone` 卡住约 21 秒后报 `curl 28 Failed to connect to github.com:443` 或 `CONNECT tunnel failed, response 502`；但 `git ls-remote` 偶尔能通 | **代理只放行读、拦截写**：`GET /info/refs` 返回 200，`POST /git-upload-pack`（真正传输 commit 数据）被重置（`schannel: recv returned error 56`）。ls-remote 只走 GET，所以"偶尔正常"，clone 必挂 | **改用 SSH 443**，见 §2.1。不要浪费时间调 `http.proxy`、`postBuffer`、`--depth`，这些都绕不开那条被掐的 POST |
| `curl` 报 `schannel: CRYPT_E_REVOCATION_OFFLINE` | Windows 证书吊销列表（CRL）服务器连不上，本地缓存过期 | 临时加 `--ssl-no-revoke`；根治需能访问 CRL 分发点 |
| `npm install` 卡在 `better-sqlite3` 后报 `find VS ... Could not find any Visual Studio` | 预编译包从 GitHub Releases 拉取失败，回落源码编译 | 见 §3.1，用 npmmirror 的预编译包 |
| `npm install` 整体极慢/超时 | 默认 registry 在境外 | `npm install --registry=https://registry.npmmirror.com`，或写进项目外全局 `.npmrc` |
| `npm test` 报 `Could not find ... src\**\*.test.js` | Windows cmd 不展开 globstar | 见 §6.1 |
| OFM `git clone` 或 `npm install` 失败 | 仓库体积大，依赖多 | 同上；OFM 启动失败不影响阶段 2 基线测试 |

**建议的镜像配置**（写用户级 `~/.npmrc`，不要写进仓库）：

```ini
registry=https://registry.npmmirror.com
```

`package-lock.json` 里记录的是 `registry.npmjs.org` 的地址，用镜像安装**不会**修改它，属正常现象，不要提交 lock 文件变更。

---

## 9. 故障速查

| 报错 | 定位 | 处理 |
|---|---|---|
| `EADDRINUSE :::3004` | 端口被占（多半是自己上次没退干净） | `netstat -ano \| findstr :3004` 查 PID 后杀掉，或改 `.env` 端口（须符合 §0 分配） |
| `Unsupported engine ... Required: {"node":">=20 <21"}` | 用错 Node 版本（常见于忘了 export PATH） | `node -v` 确认；重挂便携版 PATH |
| `NODE_MODULE_VERSION 127 vs 115` | `better-sqlite3` 二进制与当前 Node 不匹配 | 按 §3.1 重取对应 ABI 的预编译包 |
| 启动即退出，日志 `Failed to start: SQLITE_CANTOPEN` | `DB_PATH` 目录不存在或无写权限 | 手动 `mkdir -p data`；确认路径没写错盘符 |
| 免费通道 `healthStatus: unconfigured` | OFM 没起，或 `apiKey` 为空/错 | 先验 `curl localhost:18900/health`，再核 `forwardKey` |
| 请求返回 500 且 message 提到 `ECONNREFUSED 18900` | 网关起了但 OFM 没起（启动顺序颠倒） | 按 §5 顺序重启 |
| 管理接口 401 | 设了 `ADMIN_TOKEN` 但没带 `x-admin-token` 头 | 补请求头，或本机开发时清空该变量 |
| 看板空白 | 浏览器缓存或接口 401 | 强制刷新；F12 看 `/api/dashboard/summary` 返回 |

---

## 10. 附：本机验证记录

| 项 | 实际值 |
|---|---|
| 执行日期 | 2026-11-23 |
| 系统 | Windows 11（10.0.26300），非管理员账户 |
| Node / npm | v20.20.2 / 10.8.2（便携版，路径 `E:\启航社\免费算力平台项目\.tools\node-v20.20.2-win-x64`） |
| 取码 | HTTPS 克隆被代理掐断 POST；改用 SSH 443 成功，历史 `41ece42` → `d6d69e5` |
| 依赖安装 | `npm install --ignore-scripts` + 镜像预编译 `better-sqlite3`，126 包 |
| 基线测试 | 37 / 37 通过（Git Bash 执行 `node --test`） |
| 网关启动 | 3004 端口正常，`/health` 与 `/api/dashboard/summary` 均返回 200 |
| DB | `data/gateway-member4-3004.db`，自动建表并 seed 三条默认通道 |
| 未验证项 | OFM 独立服务（18900）未安装；真实上游转发未跑通，留待阶段 3 联调 |

---

## 相关文档

- 契约（唯一事实源）：[`CONTRACT.md`](../CONTRACT.md)
- 协作与提交规范：[`CONTRIBUTING.md`](../CONTRIBUTING.md)
- 接口使用说明：`docs/api.md`（4.2，编写中）
- 风险说明：`docs/risks.md`（4.3，编写中）
- 对接示例：`docs/examples/`（4.4，编写中）
