# We Cites

一个邀请制研究者引用发现站。

用户先完善自己的研究工作与简介，再上传自己的论文条目（只需要 `title`、`bibtex`、`介绍`、`摘要`、`TLDR` 等元数据，不传全文），系统会先分析研究方面，再从站内其他用户论文中给出推荐引用候选，支持直接复制 `BibTeX`。

## 已实现

- 邀请制邮箱注册 / 登录
- 首个管理员邮箱可直接注册，其他新用户仍然必须通过邀请码进入
- GitHub / Google OAuth 可选接入
- 首个管理员通过 `BOOTSTRAP_ADMIN_EMAILS` 放行，默认应配置 `sci.m.wang@gmail.com`
- 论文手动上传和编辑
- 作者、年份、venue、链接等元数据从 BibTeX 规则提取
- 推荐引用：先抽取研究方面，再做相似度排序，返回前 20 条候选并标注命中的方面
- 一键复制 BibTeX

## 技术栈

- 前端：`Vite + React + TypeScript`
- 后端：`Cloudflare Pages Functions + Hono`
- 数据库：`Cloudflare D1`
- LLM / Embedding：可选 `Workers AI`

说明：

- 如果没有配置 `Workers AI`，推荐模块会自动降级为关键词/哈希向量模式，仍可用，但效果不如 AI 模式。
- 当前默认把 embedding 存在 D1 里，适合邀请制早期小规模站点。
- 代码里已经为未来接 `Vectorize` 预留了兼容路径；如果你后面想上更大规模检索，可以继续扩展。

## 本地开发

```bash
npm install
npm run build
```

前端本地开发：

```bash
npm run dev
```

如果要本地联调 Pages Functions，建议用 `wrangler pages dev dist`，并通过 Cloudflare 本地绑定把 `D1` / `AI` 等资源接进来。

## Cloudflare Pages 部署

这份仓库已经按 Cloudflare Pages 目录结构组织好了：

- 静态构建产物目录：`dist`
- Functions 目录：`functions/`
- 示例配置：`wrangler.example.toml`
- 本地变量示例：`.dev.vars.example`

### 1. 在 Cloudflare 上创建 Pages 项目

- 连接这个 GitHub 仓库
- Framework preset 可选 `Vite`
- Build command: `npm run build`
- Build output directory: `dist`

### 2. 创建 D1 数据库

先在 Cloudflare 创建一个 D1 数据库，然后执行 `database/schema.sql`。

可选方式：

- 用 Cloudflare Dashboard 的 D1 SQL 控制台粘贴执行
- 或者用 CLI：

```bash
npx wrangler d1 execute <YOUR_DB_NAME> --file=database/schema.sql
```

### 3. 给 Pages 项目配置绑定

在 Pages 项目的 `Settings -> Bindings` 中添加：

- D1 binding
  - Variable name: `DB`
- Workers AI binding（可选，但强烈建议）
  - Variable name: `AI`
- Vectorize binding（当前不是必须）
  - Variable name: `VECTOR_INDEX`

如果你后面想改成 Wrangler 作为 Pages 配置 source of truth，可以参考仓库里的 `wrangler.example.toml`；
如果你只打算走 Dashboard Git 部署，就不要直接把它重命名成 `wrangler.toml`。

### 4. 配置 Variables / Secrets

在 `Settings -> Variables and Secrets` 里配置：

必填：

- `APP_SECRET`
  - 一段足够长的随机字符串，用于签名 OAuth 状态和安全 Cookie
- `BOOTSTRAP_ADMIN_EMAILS`
  - 至少包含：`sci.m.wang@gmail.com`

可选 OAuth：

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

Google OAuth：

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Semantic Scholar：

- `SEMANTIC_SCHOLAR_API_KEY`
  - 可选。不填也能跑，但会受更严格的公共频率限制。

### 5. OAuth 回调地址（仅在启用 OAuth 时需要）

假设你的站点域名是 `https://we-cites.pages.dev`，则：

- GitHub callback URL:
  - `https://we-cites.pages.dev/api/auth/callback/github`
- Google callback URL:
  - `https://we-cites.pages.dev/api/auth/callback/google`

如果你后续绑了自定义域名，也要把对应域名的 callback 一起加入 OAuth 配置。

## 推荐逻辑

推荐接口位于 `/api/recommendations`，当前逻辑：

1. 读取用户保存的 `研究工作 + 个人简介`，再拼上临时补充说明
2. 用 LLM 抽取 3 到 6 个研究方面及关键词
3. 对查询文本和站内论文元数据做向量化
4. 计算整体语义相似度，并叠加方面关键词命中分
5. 返回前 20 个候选引用，并标注命中的研究方面和关键词

## 当前边界

- 没有做邮件发送，邀请码是由老用户生成后手动发给新用户
- 暂未启用 DBLP / Semantic Scholar / Google Scholar / Zotero 导入
- 暂时没有全文上传与全文索引，只做元数据级别推荐

## 建议的下一步

1. 接 `Vectorize`，把候选召回从 D1 全量扫描升级为原生向量索引
2. 增加 Zotero 导入
3. 增加站内公开个人页 / 论文页
4. 增加引用列表收藏与导出
