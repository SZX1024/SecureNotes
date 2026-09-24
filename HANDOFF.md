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

| 阶段 | 范围             | 关键交付                                                                                                                                                                                                                                                            |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | D1 schema 与迁移 | 0001 迁移：users/sessions/recovery_codes/totp_config/folders/tags/notes/note_revisions/note_tags/attachments/note_attachments/sync_changes/audit_logs（+ 限流表）；外键、索引、事务；`wrangler d1 migrations` 本地跑通；worker 测试改为读迁移（`readD1Migrations`） |
| P2   | 认证域           | 首运行初始化（用户名+TOTP+10 恢复码）、登录/恢复登录、会话（UUIDv7 + 256bit token 只存 SHA-256、40 分钟滑动过期、5 会话上限+淘汰、设备列表、撤销）、限流与指数退避、审计日志（30 天 Cron 清理、敏感字段加密、IP 截断）、CSRF/Origin 强校验、统一错误与请求体限制    |
| P3   | 加密域           | 客户端信封加密/AAD/HKDF/KEK-DEK、恢复码包裹、TOTP 换绑迁移状态机（可中断续跑/可回滚）、一次性 operation id/nonce                                                                                                                                                    |
| P4   | 本地层           | Dexie schema 与版本化迁移（保留旧库直到成功）、设备密钥 + 包裹 DEK、App Lock 40 分钟、PWA/SW 骨架 + 静态资源绑定接入 Worker（`[assets]`）                                                                                                                           |
| P5   | 数据域           | notes/folders/tags/revisions/recycle bin/attachments（引用计数 + 异步 R2 删除）/搜索（MiniSearch 内存索引）                                                                                                                                                         |
| P6   | 编辑器           | Milkdown WYSIWYG + CodeMirror 源码、DOMPurify HTML/SVG/CSS 策略、CSP（`frame-src https:`、`img-src https:`）、Mermaid→SVG 二次净化、KaTeX trust:false、iframe sandbox（**绝不允许 allow-same-origin**）、粘贴/拖放                                                  |
| P7   | 同步             | cursor 增量、`base_revision` 乐观锁、三方冲突 Base/Local/Remote、Markdown 三方合并、重试退避、tombstone 30 天、同笔记串行/异笔记并行                                                                                                                                |
| P8   | 导入导出         | 全量明文 ZIP 导出（fflate）、独立恢复包（版本化）、事务性导入（校验后提交、失败整体回滚）、SW 在有未同步数据时推迟更新                                                                                                                                              |
| P9   | 安全加固         | 需求 §31 全部必测 + 需求 §32 验收清单逐项勾选与报告                                                                                                                                                                                                                 |

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
