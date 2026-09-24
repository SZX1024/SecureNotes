# 会话交接文档（HANDOFF）

> 用途：把当前会话已完成的工作、已确认的决策、环境事实、踩坑结论与后续精确步骤完整移交给下一个会话。
> 生成时间：2026-09-24 · 仓库：`/home/SZX10246/Projects/software/SecureNotes`
> **新会话请先完整读完本文件，再动手。**

---

## 1. 任务与来源

- 目标：按 `requirements.md`（1067 行，需求已冻结）实现 SecureNotes——个人单用户、客户端加密、local-first 的备忘录 PWA。
- 部署形态：Cloudflare Workers + D1 + R2；认证为自建 用户名 + TOTP；加密全部在浏览器完成。
- 用户的工作方式要求：**先给方案，得到同意后再执行**；本次已同意，并选择 **逐阶段交付**（每阶段结束暂停等确认）。

## 2. 已确认的决策（用户已逐条批准，全部采纳推荐项）

| 编号    | 决策                                                                                                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | 技术栈：pnpm workspace 单仓；Hono + TS（Worker）、React 19 + Vite（前端）、Dexie（IndexedDB）、**Milkdown v7**（WYSIWYG）+ CodeMirror 6（Markdown 源码模式）、MiniSearch、DOMPurify、KaTeX、Mermaid、Shiki、fflate、Zod、Vitest（含 Workers pool）+ Playwright。 |
| ADR-002 | **认证通过后经 HTTPS 一次性下发 TOTP Secret** 给客户端用于派生 KEK；仅存内存，不落盘、不进日志、UI 不可导出。（这是冻结密钥层级的必然结果，风险已被需求 §25 接受。）                                                                                             |
| ADR-003 | 离线/App Lock 解锁：IndexedDB 存 **不可导出 CryptoKey（设备密钥）包裹的 DEK**；解锁只依赖设备；TOTP 仍是登录与同步的强因子。                                                                                                                                     |
| ADR-004 | TOTP 换绑迁移：**最小化迁移**——只重包裹 DEK + 重包裹 10 个恢复码并升 `key_version`，不做全量重加密。                                                                                                                                                             |
| ADR-005 | 第 6 个会话：**淘汰最久未活动的会话**并写审计日志（不拒绝新登录）。                                                                                                                                                                                              |
| ADR-006 | 交付节奏：P0→P9 逐阶段；每阶段交付「变更摘要 + 测试结果 + 验收对照 + 一个 commit」，然后暂停等确认。                                                                                                                                                             |

以上已写入 `docs/decisions.md`（含被否决的备选方案与理由）。

## 3. 环境事实（重要，务必遵守）

- 运行时：node **v22.23.1**、pnpm **10.33.0**、git 2.55.0；系统日期 2026-09-24。
- **沙箱限制（下一会话同样会遇到）**：
  - pnpm 默认全局 store 在 `/home/SZX10246/.local/share/pnpm/store`，位于工作区之外 → 写入被拒（EROFS）。**所有 pnpm 命令都必须加 `--store-dir .pnpm-store`**，例如：
    ```bash
    pnpm --store-dir .pnpm-store install
    pnpm --store-dir .pnpm-store --filter @securenotes/web add -D <pkg>
    ```
    `.pnpm-store/` 已加入 `.gitignore` 与 `.prettierignore`。
  - `npm` 的缓存目录 `~/.npm` 不可写，因此 `npm view` / `npm ping` 之类会失败——查版本请改用 pnpm 或直接读 `node_modules/<pkg>/package.json`。
  - `wrangler types` 会往 `/home/SZX10246/.config/.wrangler/logs` 写日志，这条路径当前是可写的。
  - 未登录 Cloudflare、无 `~/.wrangler`：**全部开发与测试走本地模式**（Miniflare 本地 D1/R2，状态在 `.wrangler/state`），不需要真实账号。
- 网络较慢（首次下载 typescript 平台二进制耗时约 5 分钟），安装类命令请用后台任务或 10 分钟以上超时。

## 4. 锁定依赖版本（已在 package.json / pnpm-lock.yaml 固定）

根 devDeps：typescript **6.0.3**、prettier 3.9.9、eslint 10.11.0、@eslint/js 10.0.1、typescript-eslint 8.70.1、globals 17.12.0、eslint-plugin-react-hooks 7.1.1、eslint-plugin-react-refresh 0.5.7、@types/node 26.6.2。

| 包              | 版本                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/worker     | hono 4.13.9；dev: wrangler 4.138.0、@cloudflare/vitest-pool-workers 0.22.0、vitest 4.1.11                                                                                                                                  |
| apps/web        | react / react-dom 19.3.0；dev: vite 8.3.1、@vitejs/plugin-react 6.1.1、vitest 4.1.11、jsdom 30.1.1、@testing-library/react 16.3.3、@testing-library/dom 10.4.2、@testing-library/jest-dom 7.0.1、@types/react(-dom) 19.3.0 |
| packages/shared | dev: vitest 4.1.11                                                                                                                                                                                                         |

**两处必须保持的版本约束（不要随意升级）：**

1. `typescript` 必须是 `>=5 <6.1`（typescript-eslint 8.70.1 的 peer 上限是 `<6.1.0`）。默认安装会拿到 **TS 7.0.2**，会与 typescript-eslint 冲突。
2. `vitest` 必须是 `^4.1.0`（`@cloudflare/vitest-pool-workers@0.22.0` 的 peer）。默认安装会拿到 vitest 5，冲突。

## 5. 已完成的工作（P0 脚手架）

### 5.1 Git

- 已执行 `git init -b main`，**尚无任何 commit**，所有文件均为 untracked。

### 5.2 根配置

| 文件                                                                    | 作用                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                          | 版本 0.1.0（**版本号唯一真源**）；脚本：`dev:worker`、`dev:web`、`build`、`typecheck`、`test`、`lint`、`format`、`format:check`、`check:version`、`check`              |
| `pnpm-workspace.yaml`                                                   | 工作区 `apps/*`、`packages/*`；`onlyBuiltDependencies: esbuild, workerd, sharp`（pnpm 10 默认禁用生命周期脚本）                                                        |
| `tsconfig.base.json`                                                    | strict + `noUncheckedIndexedAccess` 等；`moduleResolution: bundler`、`verbatimModuleSyntax`、`noEmit`                                                                  |
| `eslint.config.js`                                                      | flat config：js.recommended + typescript-eslint recommended + react-hooks(recommended-latest/flat) + react-refresh；忽略 `.pnpm-store`、`worker-configuration.d.ts` 等 |
| `.prettierrc.json` / `.prettierignore` / `.editorconfig` / `.gitignore` | printWidth 100、双引号、LF；忽略 `pnpm-lock.yaml`、`.pnpm-store`、生成的 `worker-configuration.d.ts`                                                                   |
| `.github/workflows/ci.yml`                                              | push/PR 上跑 `pnpm install --frozen-lockfile` + `pnpm check`（**注意：CI 里不能再带 `--store-dir`，也不该带**）                                                        |
| `scripts/check-version.mjs`                                             | 校验 `apps/worker/src/version.ts`、`apps/worker/package.json`、`apps/web/package.json` 的版本与根 `package.json` 一致                                                  |

### 5.3 packages/shared（前后端共享）

| 文件                                         | 内容                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/errors.ts`                              | 封闭错误码集合（17 个）、每个码的**通用公开文案**（不含请求数据）、`ApiResult<T>` 信封、`isErrorCode`；`PUBLIC_MESSAGES` 被 `Object.freeze`                                                                                  |
| `src/crypto/format.ts`                       | 冻结的加密格式常量：`CRYPTO_VERSION=1`、`ENVELOPE_ALG=ES256-GCM(AES-256-GCM)`、IV 12B、tag 128b、HKDF-SHA-256、上下文常量、`OBJECT_TYPES`、`CryptoEnvelope` 类型；**`canonicalAad()` / `buildAad()`**（AAD = `SecureNotes/v1 | object_type | object_id | revision | key_version | crypto_version`，object_id 强制 `[A-Za-z0-9_-]{1,64}` 以防分隔符注入） |
| `src/api.ts`                                 | `API_PREFIX=/api/v1`、cookie 名 `session`/`csrf`、`x-csrf-token`、`x-request-id`、`HealthPayload`                                                                                                                            |
| `src/index.ts`                               | barrel 导出                                                                                                                                                                                                                  |
| `test/format.test.ts`、`test/errors.test.ts` | 11 个测试全绿（AAD 确定性、字段绑定、分隔符注入拒绝、非法整数拒绝、文案不泄露技术关键词）                                                                                                                                    |

### 5.4 apps/worker（Worker 骨架）

| 文件                                 | 内容                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.toml`                      | name/main/`compatibility_date="2026-08-22"`（**已从 2026-09-01 下调，原因见 §11.1**）；`[dev] port=8787`；`[vars] ENVIRONMENT="development"`；D1 绑定 `DB`（`database_id` 为占位符，部署前需替换为真实 id）+ `migrations_dir="migrations"`；R2 绑定 `ATTACHMENTS`；Cron `17 * * * *`（P2 用于审计日志 30 天清理）；observability |
| `.dev.vars.example`                  | 本地 secrets 约定（`.dev.vars` 已 gitignore）                                                                                                                                                                                                                                                                                    |
| `src/env.ts`                         | `export type Env = Omit<Cloudflare.Env, "ENVIRONMENT"> & { ENVIRONMENT: "development" \| "production" }`；`AppBindings`（Bindings + `requestId` 变量）                                                                                                                                                                           |
| `src/version.ts`                     | `APP_VERSION = "0.1.0"`（由 check-version 校验）                                                                                                                                                                                                                                                                                 |
| `src/lib/http.ts`                    | `jsonOk`、`jsonFail`（错误码→HTTP 状态表；**diagnostic 仅在 development 出现**）、显式 `content-type: application/json; charset=utf-8`                                                                                                                                                                                           |
| `src/middleware/request-id.ts`       | 生成并回写 `x-request-id`                                                                                                                                                                                                                                                                                                        |
| `src/middleware/security-headers.ts` | 通用头（nosniff、no-referrer、DENY、COOP/CORP、Permissions-Policy）；`/api/*` 追加 `CSP: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox` 与 `Cache-Control: no-store`；仅 production 加 HSTS                                                                                           |
| `src/app.ts`                         | `createApp()` 工厂（便于测试注入 env）：`GET /api/v1/health`、`api.all("/health")` → 405、`api.all("*")` → 404 JSON、`notFound`、`onError`（dev 打印堆栈、prod 只打印 error.name，响应绝不外泄 diagnostic）                                                                                                                      |
| `src/index.ts`                       | `export default { fetch, scheduled }`（scheduled 为 P2 预备的空实现）                                                                                                                                                                                                                                                            |
| `test/health.test.ts`                | health 成功信封、不泄露绑定信息、POST→405、未知 API 路径→404、非 API 路径→404 JSON                                                                                                                                                                                                                                               |
| `test/security-headers.test.ts`      | 基线安全头、API CSP 严格性、no-store、request id 格式、HSTS 仅 production、**prod 不泄露 diagnostic/堆栈**、dev 才暴露 diagnostic                                                                                                                                                                                                |
| `vitest.config.ts`                   | `cloudflareTest()` Vite 插件（v0.22 新 API）+ `wrangler.configPath`                                                                                                                                                                                                                                                              |
| `worker-configuration.d.ts`          | `wrangler types` 生成（604 KB，运行时类型 + `Cloudflare.Env`），**已决定提交进仓库**；改 `wrangler.toml` 后需重跑 `pnpm --filter @securenotes/worker cf-typegen`                                                                                                                                                                 |

### 5.5 apps/web（客户端骨架）

| 文件                                             | 内容                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`                                 | react 插件；`define: __APP_VERSION__`（从根 package.json 读版本）；dev server 5173 + `/api` 代理到 `http://127.0.0.1:8787`（`changeOrigin: false`，保持同源语义）；vitest jsdom + setupFiles                                                   |
| `index.html`                                     | `referrer: no-referrer`、`color-scheme`、manifest、icon                                                                                                                                                                                        |
| `src/api/client.ts`                              | `apiRequest`：同源、`credentials: "same-origin"`、非安全方法自动附 `x-csrf-token`（从 cookie 读）、失败统一抛 `ApiError`（**message 一律取本地文案表，绝不使用服务端返回的 message**）、非 JSON 响应按 HTTP 状态映射、未知错误码回退到状态映射 |
| `src/App.tsx` / `main.tsx` / `styles.css`        | P0 外壳：请求 `/api/v1/health` 展示连通性 + 版本；跟随系统的明/暗主题变量                                                                                                                                                                      |
| `src/api/client.test.ts`、`src/App.test.tsx`     | 10 个测试全绿（信封解包、文案不泄露、非 JSON 回退、未知码回退、网络错误、CSRF 只加在写请求、health 成功/失败渲染、版本展示）                                                                                                                   |
| `public/manifest.webmanifest`、`public/icon.svg` | PWA 占位（PNG 图标、SW 在 P4 补）                                                                                                                                                                                                              |

### 5.6 docs

`README.md`（含阶段表与快速开始）、`SECURITY.md`（报告流程 + 12 条不可违背的安全不变量 + 已接受风险）、`docs/architecture.md`（信任边界、请求流、模块边界、本地拓扑、部署）、`docs/crypto-format.md`（信封、AAD、密钥层级、恢复路径、离线解锁、换绑迁移、版本策略）、`docs/api-contract.md`（信封、状态码表、请求/响应头、端点清单与阶段状态、请求限制）、`docs/threat-model.md`（资产、在范围内/范围外、威胁→缓解对照、隐私边界）、`docs/decisions.md`（ADR-001..006 + 6 个待决问题）。

### 5.7 关键踩坑与解决办法（下一会话务必知道）

1. **pnpm store 在工作区外** → 所有 pnpm 命令加 `--store-dir .pnpm-store`（见 §3）。
2. **TS 7 / vitest 5 默认版本与 peer 冲突** → 已钉到 typescript 6.0.3、vitest 4.1.11（见 §4）。
3. **`@cloudflare/vitest-pool-workers@0.22` 没有 `./config` 导出**，`defineWorkersConfig` 已不存在 → 改为 `import { cloudflareTest } from "@cloudflare/vitest-pool-workers"` 并在 `defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } }) ] })` 中使用。
4. **类型来源改为 `wrangler types` 生成**：官方提示弃用 `@cloudflare/workers-types`（已从 devDeps 移除）。生成的 `Cloudflare.Env` 中 `ENVIRONMENT` 是字面量 `"development"`，会导致 `=== "production"` 报 TS2367，因此 `src/env.ts` 用 `Omit<Cloudflare.Env,"ENVIRONMENT"> & {ENVIRONMENT: "development"|"production"}` 拓宽。
5. **`cloudflare:test` 不再有 `ProvidedEnv`**（0.22 中 `env` 直接是 `Cloudflare.Env`）→ 已删除 `apps/worker/test/env.d.ts`。注意 `env`/`SELF` 在该版本已标记 deprecated（建议改为 `cloudflare:workers` 的 `env`/`exports`），P1 可顺手迁移。
6. **`packages/shared` 的 lib 用 `["ES2023","WebWorker"]`**：既能用 TextEncoder/TextDecoder/crypto，又不会误用 `window`/`document`（用 DOM lib 会放行浏览器专有 API）。
7. **vitest 里 `mockResolvedValue(Response)` 只能消费一次 body** → 需要每次调用新建 Response 时用 `mockImplementation(async () => jsonResponse(...))`（本次已修掉两个因此失败的测试）。

## 6. 当前验证状态（务必以实际重跑为准）

| 检查                                     | 状态                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm check:version`                     | ✅ 通过（0.1.0）                                                                            |
| `pnpm format`                            | ✅ 已执行过一次（之后又改了少量文件，提交前建议再跑）                                       |
| `pnpm typecheck`                         | ✅ 三个包全部通过（修完 §5.7 第 4/5 条之后）                                                |
| `packages/shared` 测试                   | ✅ 2 文件 / 11 测试通过                                                                     |
| `apps/web` 测试                          | ✅ 2 文件 / 10 测试通过（修掉 2 个测试自身 bug 后）                                         |
| `apps/worker` 测试                       | ✅ 2 文件 / 12 测试通过（本次跑通；此前卡在 §11.1 的兼容性日期问题上）                      |
| `pnpm lint`                              | ✅ 已通过（本次首次执行）                                                                   |
| `pnpm build`（web 生产构建）             | ✅ 已通过（本次首次执行）                                                                   |
| `pnpm dev:worker` + `dev:web` 端到端连通 | ✅ 已验证（8787 直连 + 5173 经 Vite 代理均返回 200 JSON；无 CORS 响应头；安全头经代理保留） |
| 首个 git commit                          | ✅ 已创建（`chore: scaffold SecureNotes monorepo (P0)`，见 §11.5）                          |

## 7. P0 收尾步骤（**本次已全部执行完毕**，保留作为复核清单）

> 注意：本次实际执行时的两处修正——`wrangler dev` 需要可写的 `$HOME`（用 `HOME="$PWD/.sandbox-home"`，
> 见 §11.2），Vite 只绑定 `localhost`（IPv6 `::1`），**不要用 `127.0.0.1:5173`**（见 §11.3）。

按顺序执行，每步都要看 exit code：

```bash
cd /home/SZX10246/Projects/software/SecureNotes

# 1) 跑通 worker 测试（若 cloudflare:test 的 deprecated env/SELF 报错，改用
#    import { env } from "cloudflare:workers" / exports 的方式迁移测试）
pnpm --filter @securenotes/worker test

# 2) 全量质量门禁
pnpm format && pnpm check        # check = check:version + format:check + lint + typecheck + test

# 3) 生产构建
pnpm build

# 4) 端到端连通性验证（两个后台任务）
HOME="$PWD/.sandbox-home" pnpm dev:worker   # 终端 A：http://127.0.0.1:8787
HOME="$PWD/.sandbox-home" pnpm dev:web      # 终端 B：http://localhost:5173
curl -s http://127.0.0.1:8787/api/v1/health          # 期望 {"ok":true,"data":{...}}
curl -s http://localhost:5173/api/v1/health          # 期望同上（经 Vite 代理）

# 5) 首个 commit
git add -A
git commit -m "chore: scaffold SecureNotes monorepo (P0)"
```

P0 完成判据：`pnpm check` 全绿 + 构建成功 + 两处 `/api/v1/health` 均返回 200 JSON + 首个 commit 存在。然后**向用户汇报 P0 结果并暂停**（ADR-006）。

若 worker 测试因 workerd 在本沙箱无法启动而失败：如实记录为环境限制，不要伪造通过；改用最小替代验证（`wrangler dev` + curl）并在汇报中说明。

## 8. 后续阶段计划（需求 §30，每阶段结束暂停汇报）

| 阶段 | 范围             | 关键交付                                                                                                                                                                                                                                                         |
| ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | D1 schema 与迁移 | ✅ **已完成**（见 §12）：14 张表 / 37 条语句；外键 + 索引 + CHECK；`wrangler d1 migrations` 本地跑通；测试改为读同一批迁移文件（`readD1Migrations`）                                                                                                             |
| P2   | 认证域           | 首运行初始化（用户名+TOTP+10 恢复码）、登录/恢复登录、会话（UUIDv7 + 256bit token 只存 SHA-256、40 分钟滑动过期、5 会话上限+淘汰、设备列表、撤销）、限流与指数退避、审计日志（30 天 Cron 清理、敏感字段加密、IP 截断）、CSRF/Origin 强校验、统一错误与请求体限制 |
| P3   | 加密域           | 客户端信封加密/AAD/HKDF/KEK-DEK、恢复码包裹、TOTP 换绑迁移状态机（可中断续跑/可回滚）、一次性 operation id/nonce                                                                                                                                                 |
| P4   | 本地层           | Dexie schema 与版本化迁移（保留旧库直到成功）、设备密钥 + 包裹 DEK、App Lock 40 分钟、PWA/SW 骨架 + 静态资源绑定接入 Worker（`[assets]`）                                                                                                                        |
| P5   | 数据域           | notes/folders/tags/revisions/recycle bin/attachments（引用计数 + 异步 R2 删除）/搜索（MiniSearch 内存索引）                                                                                                                                                      |
| P6   | 编辑器           | Milkdown WYSIWYG + CodeMirror 源码、DOMPurify HTML/SVG/CSS 策略、CSP（`frame-src https:`、`img-src https:`）、Mermaid→SVG 二次净化、KaTeX trust:false、iframe sandbox（**绝不允许 allow-same-origin**）、粘贴/拖放                                               |
| P7   | 同步             | cursor 增量、`base_revision` 乐观锁、三方冲突 Base/Local/Remote、Markdown 三方合并、重试退避、tombstone 30 天、同笔记串行/异笔记并行                                                                                                                             |
| P8   | 导入导出         | 全量明文 ZIP 导出（fflate）、独立恢复包（版本化）、事务性导入（校验后提交、失败整体回滚）、SW 在有未同步数据时推迟更新                                                                                                                                           |
| P9   | 安全加固         | 需求 §31 全部必测 + 需求 §32 验收清单逐项勾选与报告                                                                                                                                                                                                              |

## 9. 待决问题（见 `docs/decisions.md`，不阻塞 P0）

1. **UI 语言**：当前代码与文档均为英文。是否需要中文 UI / 双语 i18n？
2. **许可证**：仓库尚未声明 license（需求要求可开源发布）——MIT？AGPL-3.0？
3. **note/folder/tag 的 ID 格式**：建议统一 UUIDv7（满足 AAD 字符集限制）。
4. **历史版本保存间隔**：建议「活跃编辑每 5 分钟最多一个历史版本 + 显式保存时一个」，上限 10。
5. **限流阈值**：建议账号维度 1s→2s→4s…上限 60s，10 次/小时/账号、30 次/小时/IP + 全局上限，P2 前需确认。
6. **回收站中文件夹名**：保持全程加密（确认是否为预期）。

## 10. 工作约定（沿用）

- 不静默修改冻结需求；若实现与需求冲突，**先停下来说明**（需求 §33.2）。
- 不记录任何秘密/明文；不引入第三方统计；不用 last-write-wins；不自动丢弃未同步改动。
- 每个安全边界都要有测试；安全敏感代码隔离且可测。
- 提交信息用 Conventional Commits；每阶段一个 commit。
- 每阶段结束的汇报格式：变更摘要 + 测试结果 + 验收对照 + commit 号，然后暂停等用户确认。

## 11. P0 收尾会话补充（本次新增，务必读）

### 11.1 `compatibility_date` 必须 ≤ 2026-08-22（本次实际踩坑）

原 `2026-09-01` 会让 **worker 测试完全无法启动**：

```
This Worker requires compatibility date "2026-09-01", but the newest date
supported by this server binary is "2026-08-22".
```

原因是工具链里存在两个 workerd：

- `wrangler@4.138.0` → `miniflare@5.20260921.1-alpha` → `workerd@1.20260921.1`（支持 2026-09-01，所以 `wrangler types` 当时能成功，掩盖了问题）；
- `@cloudflare/vitest-pool-workers@0.22.0` **精确锁定** `miniflare@5.20260815.0-alpha` → `workerd@1.20260815.1`（上限 2026-08-22）。

因此规则是：**兼容性日期必须 ≤ 工具链中「最旧」运行时的上限**。已改为 `2026-08-22` 并重新生成
`worker-configuration.d.ts`。以后要提升该日期，必须同时升级 `@cloudflare/vitest-pool-workers`。

### 11.2 `wrangler dev` 需要可写的 `$HOME`（沙箱内必踩）

`wrangler dev` 会写 `$HOME/.config/.wrangler/registry/<name>`，`$HOME` 只读时**直接退出码 1**（测试时只是警告，dev 是致命错误）。解决：

```bash
mkdir -p .sandbox-home
HOME="$PWD/.sandbox-home" pnpm dev:worker
```

`.sandbox-home/` 已加入 `.gitignore`；README 也已记录。（无需放宽沙箱权限。）

### 11.3 Vite 只绑定 `localhost`（IPv6 `::1`）

`curl http://127.0.0.1:5173/...` 会连接失败（exit 7）。请用 `http://localhost:5173` 或 `http://[::1]:5173`。
Worker 侧仍然是 `127.0.0.1:8787`（不受影响）。

### 11.4 `api.all("*")` 通配路由会遮蔽后注册的路由（已修）

Hono 的 `app.route()` 会把子应用路由**摊平**进父路由表，匹配按注册顺序。原先子应用里的
`api.all("*", → 404)` 注册在 `app.route()` 之前，导致：

- 测试中 `createApp()` 之后追加的 `app.get("/api/v1/__boom")` 永远匹配不到 → 期望 500 实际 404；
- 未来任何「后置注册」的路由都会被静默吞掉。

已删除该通配路由，改为依赖 `app.notFound()`（只在无路由匹配时触发，语义更准确）。**P4 接入 SPA 静态资源时**
需在 `notFound` 中区分：`/api/*` → JSON 404，其余 → 返回应用外壳。

### 11.5 本次会话实际改动清单（除 §5 已有内容外）

| 文件                                    | 改动                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/worker/wrangler.toml`             | `compatibility_date` 2026-09-01 → **2026-08-22**（+ 注释说明原因）               |
| `apps/worker/worker-configuration.d.ts` | 随新日期重新生成（`wrangler types`）                                             |
| `apps/worker/package.json`              | 新增脚本 `cf-typegen: wrangler types`（原文档提到该脚本，但此前并不存在）        |
| `apps/worker/src/app.ts`                | 删除会遮蔽路由的 `api.all("*")`，改由 `notFound` 统一处理                        |
| `.gitignore`                            | 新增 `.sandbox-home/`                                                            |
| `README.md`                             | Quick start 增补「Restricted environments」小节（HOME / pnpm store / localhost） |
| `HANDOFF.md`                            | 修正过时事实（日期、脚本、curl 地址）并新增本节                                  |

首个 commit 为 P0 全部内容（含 `requirements.md`、`HANDOFF.md`、`PLAN.md`）。

### 11.6 尚未处理、留给后续的观察项（非阻塞）

- `apps/web/vite.config.ts` 里 `build.sourcemap: true`：会把前端源码映射发布到生产。前端代码本身是
  开源的、不含秘密，故不构成密钥泄露；但如需收紧，P4/P9 可改为 `false` 或只上传到错误追踪系统。
- `pnpm check` 运行期间偶发 `EROFS` 写 wrangler 日志的警告（不影响退出码 0）；配合 §11.2 的 `HOME` 方案可消除。

## 12. P1 完成记录（D1 schema 与迁移，本次）

### 12.1 交付物

| 文件                                   | 内容                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/migrations/0001_init.sql` | 14 张表、21 个索引、37 条语句（§9 的 13 张表 + `rate_limits`）                                                                           |
| `apps/worker/vitest.config.ts`         | 用 `readD1Migrations("./migrations")` 把**同一批** SQL 文件注入 `TEST_MIGRATIONS` 绑定；`setupFiles` 指向下面的应用脚本                  |
| `apps/worker/test/apply-migrations.ts` | 每个测试文件用 `applyD1Migrations(env.DB, TEST_MIGRATIONS)` 建库（`TEST_MIGRATIONS` 只在测试期存在，故在本地收窄类型，不污染生产 `Env`） |
| `apps/worker/test/schema.test.ts`      | 23 个 schema 测试                                                                                                                        |
| `docs/schema.md`                       | 约定、逐表说明、**7 条解释性决策**、迁移流程、部署前置（`database_id` 替换）、后续阶段延迟项                                             |

### 12.2 关键约定（P2 起写 SQL 必须遵守）

- id：`TEXT` UUIDv7（满足 AAD 字符集 `[A-Za-z0-9_-]{1,64}`）。
- 时间戳：`INTEGER` epoch 毫秒，**由应用提供**，无 `DEFAULT`。
- 加密对象：显式 `crypto_version` / `key_version` / `iv` / `ciphertext` 列（base64，`ciphertext` 含 16 字节 GCM tag），不用 JSON blob。
- 校验摘要（session token、恢复码）：小写 hex `TEXT(64)` + `CHECK(length=64)`。它们是高熵随机值的摘要，**不是**用户口令，故不需要慢 KDF。
- **未使用 `STRICT` 表**：沙箱无 Cloudflare 账号，无法对真实 D1 验证运行期专有 DDL；改用可移植的 `CHECK`（本地已验证）。
- **未使用触发器**：迁移 SQL 分割器是语句级的，跨表不变量由应用事务 + 测试保证。

### 12.3 本次遇到并已修正的问题

1. **漏建 `note_tags` 表**：首版只写了 13 张表（把 `note_tags` 与 `note_attachments` 混为一谈），`sqlite_master` 清点后发现只有 13 张 → 已补 `note_tags`（`note_id`/`tag_id` 双 `CASCADE`，删除标签只删关系）。
2. **测试辅助函数返回 `D1PreparedStatement` 而未 `.run()`**：`await helper()` 对非 Promise 是空操作，导致 15 个测试因「外键失败」而挂（用户不存在）。已改为 `create*` 辅助函数**直接执行**，另设 `*Statement` 仅用于需要进 `DB.batch()` 事务的少数场景。
3. **本地 D1 状态目录**：在 `apps/worker/.wrangler/state`（**不是**仓库根 `.wrangler`）。清理后重跑迁移要用这个路径。

### 12.4 已确认的数据库行为（实测，非推测）

- 外键**确实被强制**：插入孤儿行报 `FOREIGN KEY constraint failed`。
- `CHECK` **确实被强制**：如 `depth=11` 报 `CHECK constraint failed: depth >= 1 AND depth <= 10`。
- 删除 `users` 行会**完整级联**（含 folders + notes + revisions + tags + links + attachments + totp_config + sync_changes），即使 `notes.folder_id` 是 `RESTRICT` 也不会互相卡死（已实测）。
- 单行 `DELETE FROM folders` 在仍有子文件夹或子笔记时**被 RESTRICT 拒绝**（符合设计：迫使清理路径显式、有序）。
- 乐观锁：`WHERE id=? AND revision=?` 命中时 `meta.changes = 1`，基数过期时 `= 0`（§27 的判据就是 `changes === 0` → 冲突）。

### 12.5 未决/需用户确认的解释性决策

`docs/schema.md`「Recorded interpretations」共 7 条，其中会影响用户体验、值得用户点头的是：

- **`notes.folder_id` 可为 NULL**，表示「根/未归档」，而不是强制「笔记必须永远属于某个文件夹」。理由：避免首次运行的先有文件夹还是先有笔记的循环，且回收站里原文件夹被永久删除后笔记需要落点。
- **当前修订在 `notes` 与 `note_revisions` 各存一份**（§9 同时要求「notes 存加密 Markdown」与「保留当前修订 + 最多 10 个历史版本」）；两处必须同事务写入，已用测试锁住不变量。
- **未新增 `notes(id, revision)` 索引**（PLAN 原文提到过）：`id` 已是主键，§27 的条件本身就是单行主键查找，额外索引只增加写开销。
- **`totp_config.last_used_step`**：拒绝同一时间步内重复使用的 TOTP 码（RFC 6238 §5.2）。代价是 30 秒窗口内第二次登录会失败（例如刚登录第二个设备）。如需放宽请告知。

### 12.6 下一步（P2 认证域）

- `docs/schema.md` 的「Deferred to later phases」列出 P3/P7 需要的新迁移；**不得修改已应用的 `0001_init.sql`**。
- P2 开工即会用到的表：`users`（`failed_auth_count` / `auth_backoff_until`）、`totp_config`（`last_used_step`）、`sessions`、`recovery_codes`、`audit_logs`、`rate_limits`。
- 注意 §11.2：跑任何 `wrangler dev` / `d1 execute` 前先设 `HOME="$PWD/.sandbox-home"`。

## 13. P2 完成记录（认证域，本次）

### 13.1 交付物

| 文件                                                                | 内容                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/policy.ts`                                     | 所有政策常量唯一真源：40 分钟滑动/30 天记住设备、会话上限 5、10 个 32 字符恢复码、TOTP 参数、审计 30 天、限流阈值与退避基数    |
| `apps/worker/src/lib/base32.ts`、`lib/totp.ts`                      | RFC 4648 base32（严格，含非零尾位拒绝）+ RFC 6238 TOTP（动态截断、±1 步漂移、**已用步号拒绝重放**）                            |
| `apps/worker/src/lib/crypto.ts`、`lib/secret-box.ts`                | WebCrypto 助手；`deriveWorkerKey` 从单一根密钥按用途 HKDF 派生（`totp-secret` / `audit-detail`），AES-256-GCM 封装，失败即关闭 |
| `apps/worker/src/lib/client-meta.ts`                                | IP 截断（IPv4 /24、IPv6 /48）与浏览器/OS 类别（绝不保存完整 UA）                                                               |
| `apps/worker/src/lib/api-error.ts`、`lib/http.ts`、`lib/cookies.ts` | `ApiError`（diagnostic 与 message 分离）；`readSetCookieHeaders`；显式把 Cookie 附到返回的 Response 上                         |
| `apps/worker/src/middleware/guards.ts`                              | Origin/Referer 严格校验、`application/json` 强校验、正文大小上限（不信任 `Content-Length`）、Zod 解析                          |
| `apps/worker/src/middleware/session.ts`                             | 会话装载（滑动续期 + 写阈值）、`requireSession`、`requireCsrf`                                                                 |
| `apps/worker/src/services/account.ts`                               | 首运行初始化、TOTP 登录校验、恢复码单次核销、TOTP Secret 读取（ADR-002）                                                       |
| `apps/worker/src/services/sessions.ts`                              | 会话创建（5 上限 + 淘汰最久未活动）、滑动/绝对过期、设备列表/改名/单个撤销/全部撤销、CSRF token 派生与校验                     |
| `apps/worker/src/services/audit.ts`                                 | 审计写入（detail 加密）、30 天清理、限流表清理                                                                                 |
| `apps/worker/src/services/rate-limit.ts`                            | IP/账号/端点三类窗口计数 + 指数退避（1s→2s→…→60s 上限，无永久锁定）                                                            |
| `apps/worker/src/routes/{auth,sessions,audit}.ts`                   | 全部 P2 端点                                                                                                                   |
| `apps/worker/src/index.ts`                                          | Cron：审计 30 天清理 + 限流过期清理（`waitUntil`，失败只记录不抛）                                                             |
| `apps/worker/test/support.ts`                                       | 集成测试支撑（`SELF.fetch`、Cookie 罐、限流/重放守卫重置——**每个测试前必须重置**）                                             |
| `apps/worker/test/{auth,sessions,security,base32,totp,lib}.test.ts` | 90 个新测试                                                                                                                    |

### 13.2 本次发现并修掉的**真实缺陷**（很重要，务必记住）

1. **`setCookie(c, …)` + 返回自建 `Response` 会静默丢失 Cookie**。P0 的 `jsonOk()` 返回裸 `Response`，于是登录/登出/撤销的 Cookie 全部丢失。已改为把 Cookie **显式附加到返回的 Response**（`applySessionCookies` / `applyClearedSessionCookies`）。**新增任何返回自建 Response 且需要写 Cookie 的路由，都必须用这两个函数。**
2. **`securityHeaders()` 用 `new Headers(response.headers)` 重建响应会丢掉 `Set-Cookie`**（Header 迭代不含它）。已显式复制（`readSetCookieHeaders`）。
3. **`getAccount()` 原按 `created_at ASC` 取第一行**，一个更小的时间戳就能顶掉真实账户。已改为按 `rowid ASC`（插入顺序，不可伪造）。
4. **`ApiError` 曾把 Error message 当 diagnostic 回传**，会泄露内部字符串。已分离 `message` 与 `diagnostic`。
5. **`0001_init.sql` 的 `NOT NULL` 与客户端持有 DEK 的设计冲突**：DEK 由浏览器生成，服务端永不持有，因此新账户在客户端上传包裹前没有密钥material。已把 `users.wrapped_dek_*` 与 `recovery_codes.wrapped_dek_*`/`crypto_version`/`key_version` 改为可空，并加 `CHECK`（两者同时存在或同时缺失）。**这是对已提交迁移的修改**，理由是尚未部署、无其他使用者；本地状态已删除并重新验证（`37 commands executed successfully`）。
6. 测试侧教训：这是**按文件**隔离存储（不是按测试），因此同一文件内不同测试会互相污染限流桶与账户退避状态 → `beforeEach(resetRateLimits)`；`loginOnce()` 会先清 TOTP 步号守卫。

### 13.3 新增配置（P3+ 必须知道）

- Worker secrets：`SECRET_WRAP_KEY`、`CSRF_SIGNING_KEY`（base64 32 字节）。本地放 `.dev.vars`（已 gitignore），生产用 `wrangler secret put`。测试用 `vitest.config.ts` 里的固定测试值。
- 新 `[vars] ALLOWED_ORIGINS`：开发为 Vite 两个源；**生产必须只列部署源**，否则 Origin 校验会全部拒绝。
- 端点写法：不安全方法**必须**带允许的 `Origin`（无 Origin 直接 403），并带 `x-csrf-token`（取自 `csrf` Cookie）。

### 13.4 待后续阶段

- **P3**：客户端信封加密/KEK-DEK 派生；`/auth/setup` 后需新增「上传包裹后的 DEK」端点与 TOTP 换绑状态机（含一次性 nonce 表，新迁移）；`keyMaterialPresent: false` 表示尚未上传。
- **P4**：客户端在收到任意 401（`UNAUTHENTICATED`）时删除本地缓存与包裹密钥并回到认证；`GET /api/v1/auth/session` 返回 200 + `authenticated:false` 便于启动探测。
- **P2 已实现审计写入但设备列表未做分页**；审计查询支持 `limit`/`before`。

### 13.5 本次新增的配置校验与两个环境注意点

- **缺 secret 曾经只会得到一个难懂的 500**（AES-GCM 内部崩），现已在 API 中间件最前面加
  `findConfigProblem(env)`（`src/lib/config.ts`）：缺 `SECRET_WRAP_KEY` / `CSRF_SIGNING_KEY` /
  `ALLOWED_ORIGINS`、或密钥不是 32 字节 base64 时，返回 500 并在 development 用 diagnostic
  **点名缺哪个绑定**（绝不回显密钥值）。有测试覆盖。
- **本机 8787 端口已被另一个进程占用**（不是本仓库：它返回 `ORIGIN_REQUIRED`/`AUTH_REQUIRED`
  这种不属于我们的错误格式）。`wrangler dev` 会以 `Address already in use` 失败。
  **不要杀掉那个进程**（可能属于用户的其他项目）；改用 `wrangler dev --port 8791` 之类的空闲端口即可。
  **重要**：如果 8787 上已有别的服务，`curl 127.0.0.1:8787` 拿到的是**别人的响应**，
  不要据此判断本项目的行为。
- 本地已生成 `apps/worker/.dev.vars`（随机 32 字节密钥，已 gitignore）。**本地 D1 状态已清空**，
  下次 `wrangler dev` 会回到首运行初始化；首次 setup 返回的 10 个恢复码与 TOTP Secret **只显示一次**。

### 13.6 P2 端到端实测（真实 HTTP，非测试桩）

在 `wrangler dev`（端口 8791）上用真实 TOTP 码跑通：

```
setup            → 200，10 个恢复码
login            → 200，2 个 Set-Cookie（session + csrf），totpSecret 下发，keyMaterialPresent=false
GET /sessions    → 200，1 个会话且 current 标记正确
logout 无 CSRF   → 403 CSRF_FAILED
logout 带 CSRF   → 200，2 个 Cookie 被清除（Max-Age=0）
登出后 /sessions → 401 UNAUTHENTICATED
```

这一步专门验证了 13.2 第 1 条的 Cookie 修复在真实运行时的确生效（这是测试桩**无法**覆盖的失败模式：
`SELF.fetch` 与真实 `wrangler dev` 在 Cookie 头重建路径上行为一致，但只有真实链路能证明最终
客户端确实收到 `Set-Cookie`）。
