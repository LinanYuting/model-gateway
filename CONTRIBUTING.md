# 协作规范

## 分支模型
- `main`：始终可运行，只有组长能合入
- 每人从 main 拉 `feature/<名字>-<主题>`，如 `feature/member1-sse`
- PR 由组长合并；冲突自己 rebase 解决后再提

## 提交规范（Conventional Commits）
`<type>: <一句话为什么这么改>`，type ∈ `feat | fix | test | docs | refactor | chore`
示例：`fix: healthCheck 带上 Authorization，否则 OFM 独立服务探测 401`

## 硬性约定
- **改行为先改契约**：任何接口/表结构/插件行为变化，必须在同一个 PR 里更新 `CONTRACT.md`
- `.env`、`data/*.db`、真实密钥**禁止提交**（已在 .gitignore）
- 每人固定端口与独立 DB（见 CONTRACT §0），不要连组长的库
- 测试不许为变绿而删用例；写不了就先 `test.skip` 并在 PR 描述里挂 TODO

## 环境
- Node 20.x（`engines: >=20 <21`），包管理 npm
- OFM 独立服务：本地克隆仓库 `node packages/standalone/cli.mjs --port 18900`（npm 上的 2.1.0 过旧，勿装）
- 启动网关：复制 `.env.example` 为 `.env`，`npm start`
