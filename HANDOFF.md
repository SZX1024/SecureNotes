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

## 14. P3 完成记录（加密域，本次）

### 14.1 交付物

| 文件                                                                                                | 内容                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/crypto/bytes.ts`                                                               | 纯字节原语（UTF-8、hex/base64、CSPRNG、SHA-256、常数时间比较、`concatBytes`、`wipe`）+ **`Bytes` 类型别名**                                                                                          |
| `packages/shared/src/crypto/base32.ts`                                                              | RFC 4648 base32 唯一实现（worker 改为**再导出**，不再各写一份）                                                                                                                                      |
| `packages/shared/src/crypto/envelope.ts`                                                            | 信封加解密：`encryptObject` / `decryptObject` / `parseEnvelope` / `encryptJson` / `decryptJson`；AAD 复用冻结的 `buildAad`                                                                           |
| `packages/shared/src/crypto/keys.ts`                                                                | 密钥层级：`deriveKek`（username ‖ 0x00 ‖ TOTP 密钥字节 + salt → HKDF）、`deriveRecoveryKek`、`generateDekRaw`、`importDek`（**不可导出**）、`wrapDek`/`unwrapDek`、`buildRecoveryWrappings`（10 份） |
| `apps/worker/migrations/0002_key_material_and_nonces.sql`                                           | `operation_nonces` 表 + `totp_config` 的换绑状态机列（9 条语句）                                                                                                                                     |
| `apps/worker/src/services/nonces.ts`                                                                | 一次性 nonce 的签发/核销/清理（**服务端签发**，绑定 user+session+operation，5 分钟）                                                                                                                 |
| `apps/worker/src/services/key-material.ts`                                                          | 包裹 DEK 的存储与形状/版本/完整性校验（Zod + `parseEnvelope`）                                                                                                                                       |
| `apps/worker/src/services/totp-rebind.ts`                                                           | 换绑状态机：`startRebind` / `verifyRebind` / `completeRebind` / `rollbackRebind` / `readPendingSecretBase32`                                                                                         |
| `apps/worker/src/routes/security.ts`                                                                | 上述端点                                                                                                                                                                                             |
| `packages/shared/test/crypto.test.ts`（20 测试）、`apps/worker/test/crypto-flow.test.ts`（15 测试） | 见 14.4                                                                                                                                                                                              |

### 14.2 关键设计（P4+ 必须遵守）

- **包裹 DEK 的 AAD** = 冻结 AAD，`object_type = user_key_material`，`object_id = 账户 id`，`revision = key_version`。因此 API 现在返回 `userId` 与 `kdfSalt`（setup/login/recovery/`GET /auth/session`），客户端才能自行构造 AAD。二者都不是秘密（§26：id 是标识符，不是授权）。
- **DEK 在内存中不可导出**：原始字节只在包裹/解包的瞬间存在；随后只保留 non-extractable `CryptoKey`（§7）。
- **恢复码下发格式变为 `[{ code, salt }]`**（原为 `string[]`）：客户端需要每个码的公开 salt 才能构造该码的恢复包裹。
- **换绑是 4 个端点**（start/verify/complete/rollback），而 §15 只列了 2 个。原因：§3 要求「撤销全部会话」**且**「客户端迁移数据」；若在 verify 就撤销全部会话，迁移所需的会话会被自己销毁。故 verify 撤销**其他**会话，complete 撤销**全部**。§15 明确允许细化。
- **换绑窗口内同时返回新旧两个 secret**：新 secret 派生新 KEK，旧 secret 用于解开仍由它保护的 DEK。这正是「可中断续跑」的实现方式；complete 后两者都被替换。登录响应在 `rebindState === 'rewrapping'` 时附带 `pendingTotpSecret`，供中断后恢复。
- **换绑不重新加密任何笔记密文**（ADR-004）：DEK 不变，只重包裹 + 升 `key_version`。

### 14.3 本次踩坑与修正（重要）

1. **TS 6 的泛型 `Uint8Array` 与 WebCrypto `BufferSource` 不兼容**（`SharedArrayBuffer` 分支）。引入 `Bytes = Uint8Array<ArrayBuffer>` 别名，并在构造处（`utf8`/`buildAad`/`base32Decode`）确保落到普通 `ArrayBuffer`。**新增任何进入 `crypto.subtle` 的字节值都要用 `Bytes`。**
2. **共享化时的真实回归**：我重写 `apps/worker/src/lib/crypto.ts` 时漏掉 `randomToken`，被 typecheck 立刻抓住。共享化已用 `pnpm -r typecheck` + 全量测试验证。
3. **测试与真实客户端必须用同一套 AAD**：最初的测试用 `userId: ""` 自洽，掩盖了「客户端拿不到 user id」这个设计缺口。现在测试从登录响应取真实 `userId`/`kdfSalt`，缺口已补。
4. 与 P2 的同类交互：故意失败的登录会**武装退避**，紧接着的成功登录会 429。测试中需显式让窗口过期（`UPDATE users SET auth_backoff_until = NULL`）。

### 14.4 验证

- `apps/worker` 145 测试、`packages/shared` 31 测试全绿；`pnpm check` exit 0。
- **最强的一条**：`test/crypto-flow.test.ts` 用 `@securenotes/shared` 里**真实的客户端代码**跑完
  注册 → 生成 DEK → KEK 包裹 → 上传 → 换绑（start/verify/complete）：断言旧 secret 登录被拒、新 secret 可登录、
  会话全部撤销、`key_version` 升级、**用新 KEK 能还原出同一个 DEK**、**用恢复码也能还原出同一个 DEK**。
- 迁移中断注入：verify 后模拟客户端崩溃 → 旧 secret 仍可登录且响应给出 `pendingTotpSecret` + `rebindState='rewrapping'` → 可继续或回滚。
- 需求 §32「Encryption」12 项**已满足 7 项**（AES-256-GCM 正确、IV 唯一、AAD 校验、key_version 追踪、恢复可还原 DEK、换绑迁移数据、中断可续跑/回滚）；其余 5 项（明文不出端、文件夹/标签/标题正文/附件名加密）需要 P5/P6 的客户端与数据域才能端到端证明。

### 14.5 延迟到后续阶段

- `POST /recovery-codes/regenerate`（重新包裹 10 个恢复码）未实现——它需要「已登录 + 已解锁」的客户端流程，放在 P4/P5。
- P4 需要：Dexie 存储、**不可导出设备密钥**包裹 DEK、App Lock 40 分钟、收到 401 时销毁本地密钥材料、启动时用 `GET /key-material` 解锁。

## 15. P4 完成记录（本地层与 PWA，本次）

### 15.1 交付物

| 文件                               | 内容                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web/src/local/schema.ts`     | Dexie schema：`SCHEMA_DEFINITIONS`（v1/v2）逐版本声明、可「按版本上限」打开                              |
| `apps/web/src/local/migrations.ts` | **影子库迁移**：读数据库自身版本 → 只读打开旧库 → 建新库并复制 → 校验行数 → 才切换指针并删除旧库         |
| `apps/web/src/local/device-key.ts` | 不可导出设备 CryptoKey（持久化在 IndexedDB）；`wrapDekForDevice`/`unwrapDekForDevice`；`forgetDeviceKey` |
| `apps/web/src/local/key-store.ts`  | 内存密钥持有（DEK + TOTP secret）、App Lock 40 分钟（惰性判定）、`pagehide`/`beforeunload`/`freeze` 即清 |
| `apps/web/src/local/eviction.ts`   | 只淘汰**已同步且无排队改动**的附件缓存；按行内 `sizeBytes` 计账                                          |
| `apps/web/src/local/sync-queue.ts` | 队列读/入队/确认/失败退避（只有服务端确认才移除）                                                        |
| `apps/web/src/pwa/update-gate.ts`  | 纯函数更新门控（fail-closed）                                                                            |
| `apps/web/src/pwa/register.ts`     | SW 注册 + 门控激活 + 同步成功后应用延迟更新                                                              |
| `apps/web/public/sw.js`            | 离线应用外壳；**绝不缓存 `/api/*`**；不自行 skipWaiting                                                  |
| `apps/worker/wrangler.toml`        | `[assets]` + `run_worker_first = ["/api/*"]`；worker 只对「要求 HTML 且非 /api」的请求返回外壳           |
| `docs/local-layer.md`              | 上述设计与理由                                                                                           |

### 15.2 本次实测出来的 4 个事实（都改变了实现）

1. **Dexie 不会因「声明版本低于已存版本」而报错**：它按声明版本打开、只暴露该版本的表，**且不修改已存数据库**——这正是影子库迁移所需的安全属性（我原以为会抛 `VersionError`，文档与注释已按实测更正）。
2. **Dexie 在 IndexedDB 里把版本号 ×10 存储**（`verno=2` → `version=20`），读原始版本必须除以 10。
3. **`indexedDB.open(name)` 对不存在的库会「创建」它**：因此必须先 `Dexie.exists()` 再探版本，否则全新设备会被误判成「有旧库要迁移」，还会留下一个空库。
4. **`CryptoKey` 从 IndexedDB 读回是新对象**（结构化克隆），所以「同一把设备密钥」只能用**行为**证明（用 A 包裹、用 B 解开得到同一 DEK），不能用 `toBe`。

另：fake-indexeddb 不会保留 `Blob` 的 `size`，因此淘汰计账改用行内 `sizeBytes`（本来也更稳）。

### 15.3 与既有代码的交互

- `notFound` 现在只在「非 `/api` 且 `Accept` 含 `text/html`」时返回应用外壳，其余保持 JSON 404 —— 这样 P0 的既有测试与 API 契约都不受影响。
- ESLint 为 `public/sw.js` 单独加了 `globals.serviceworker`（否则 `self`/`caches` 报未定义）。
- `apps/web/src/test/setup.ts` 现提供 `fake-indexeddb` 与 Node WebCrypto（jsdom 两者都没有），测试用的是**真实**的 Dexie/IndexedDB/WebCrypto，而非 mock。

### 15.4 验证

`pnpm check` exit 0；`packages/shared` 31 + `apps/web` **42** + `apps/worker` 145 = **218** 测试。新增 32 个测试覆盖：迁移保数据、迁移失败保旧库、半成品目标被丢弃、设备密钥不可导出、App Lock 40 分钟与页面关闭清理、淘汰只碰已同步且未排队的数据、SW 更新门控 fail-closed、队列确认语义。

### 15.5 未完成 / 留给 P5

- **§32「Offline」与「Platform」大部分验收项需要真实数据域**（笔记/附件/搜索/离线编辑），P5 才能端到端证明；P4 只交付了它们依赖的底座。
- 应用外壳目前仍是 P0 的连通性展示页；真实三栏 UI 与编辑器属 P5/P6。
- `manifest.webmanifest` 仍是占位（PNG 图标、更多尺寸）——P9 前补。
- `App.tsx` 尚未接入 KeyStore/解锁界面（需要登录流程与数据域，P5）。

## 16. P5 第 1-4 批（服务端数据域 + 客户端数据层 + 搜索完成）— **P5 未完成（仅剩 UI）**

### 16.1 本批已交付

| 文件                                  | 内容                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/worker/src/services/records.ts` | `syncChangeStatement`（同步变更/墓碑写入）、`pruneRevisionHistory`（保留当前 + 10 历史）  |
| `apps/worker/src/services/notes.ts`   | 创建/读取/乐观锁更新/软删除/恢复/永久删除/历史列表/历史恢复为新当前版本                   |
| `apps/worker/src/routes/notes.ts`     | `/api/v1/notes...`、`/api/v1/recycle-bin`（全部 `requireSession` + 写操作 `requireCsrf`） |
| `apps/worker/test/notes.test.ts`      | **17 个测试**                                                                             |

已实现并测试的不变量：

- **乐观锁（§27）**：`WHERE id=? AND revision=?` 命中才更新，过期基数返回 `REVISION_CONFLICT`，且原内容不被覆盖。
- **历史（§9/§18）**：notes.revision 恒等于最新 note_revisions.revision；恢复历史**追加**新当前版本而非回退；上限为「当前 1 + 历史 10」，超限永久删最旧并从同步流发出 delete。
- **回收站（§19）**：软删除保留 id/revision/历史；恢复不丢历史；永久删除清除当前与全部历史（并对 `note_attachments` 做 RESTRICT 前置处理与引用计数回退）。
- **同步流（§16）**：create/update/delete 各写一行 `sync_changes`，`seq` 严格递增（游标不会漏）。
- **授权（§26）**：所有路由按 `user_id` 限定；他人 note id 一律 404，且不出现在列表中。
- 请求体严格校验：意外的 `title`/`body` 字段会被**拒绝**（不是忽略），确保服务端永不接受明文标题。

### 16.1b 第 2 批：folders API（`services/folders.ts`、`routes/folders.ts`、`test/folders.test.ts`，17 测试）

- **深度 ≤10 与服务端一致**：创建时 `parent.depth + 1`，超限 412；**移动**时还会计算子树高度，若「新深度 + 子树高度 > 10」则整体拒绝且**不写入任何行**。
- **移动子树**：递归 CTE 取子孙，按同一 delta 更新全部 `depth`，相对深度保持不变。
- **拒绝成环**：不能把文件夹移进自己的子树（412）。
- **删除进回收站**：整个子树 + 其中的笔记一起软删除，**保留 id 与 parent 关系**；恢复时整体还原。
- **永久删除**：笔记先删（并回退附件引用计数），文件夹**由深到浅**删（自引用是 RESTRICT，顺序错会报错而不是留下孤儿）。
- 踩坑：这几条批量 UPDATE 最初混用了 `?N` 与 `?` 占位符 → SQLite 编号错乱导致 500；已统一为位置参数并加注释。

### 16.1c 第 3 批：tags + attachments + 保留期清理（`services/tags.ts`、`services/attachments.ts`、`services/maintenance.ts`、`routes/tags-attachments.ts`、`test/tags-attachments.test.ts`，11 测试）

- **tags**：扁平 + 加密名称；`PUT /notes/:id/tags` 是**集合语义**替换，>10 或含他人标签一律拒绝；删除标签只删关系（笔记不受影响）。
- **attachments**：`multipart/form-data` 上传（§14 允许的唯一二进制体）；**声明大小必须等于实际字节数**——否则可以少报来绕过 20MB 上限；R2 写成功但行写失败时会**回滚对象**，不留孤儿；`GET /attachments/:id/content` 返回密文且 `cache-control: no-store`。
- **引用计数**：链接与计数同事务（`ref_count` 恒等于链接行数）；归零时**只入队**异步删除，不在用户操作里做 R2 删除；清理是**幂等**的（R2 delete 对不存在的键也成功，且行只在对象删掉后才删）。
- **保留期**：`services/maintenance.ts` 提供回收站 30 天清理（连带历史与附件引用计数回退）、附件对象清理、tombstone 30 天清理，全部挂到 Cron。
- **两处踩坑**：① 测试里 multipart 上传最初用了运行时 `fetch`（无 DNS）→ 改用 `SELF.fetch`，并在 `support.ts` 加了 `apiMultipart`/`apiDownload`；② 附件大小上限最初被 Zod 的 `max()` 先拦成 400，与服务的 413 冲突 → **上限只在一处判定**（`storeAttachment`），Zod 不再设上限，避免两个地方各判一次而语义不一致。

### 16.1d 第 4 批：客户端数据层 + 搜索（`src/data/*`、`src/search/index.ts`、`test/local-data.test.ts`，23 测试）

- **写入即加密**：`createLocalNote`/`updateLocalNote`/`createLocalFolder`/`createLocalTag` 用 DEK + 绑定 object_type/id/**revision** 的 AAD 加密后再落 Dexie；每次写入**同时**入队（两条规则合起来保证「不存明文」与「改动必被同步」）。
- **标题在密文里**（§9）：笔记明文是单个 Markdown，标题是首个 `# ` 一级标题，`splitNoteDocument`/`joinNoteDocument` 负责双向转换。
- **AAD 绑定可验证**：revision-1 的密文无法当作 revision 2 解开（测试直接断言），换一把 DEK 也解不开。
- **坏行不拖垮全局**：`readAllLocalNotes` 跳过解不开的行（而不是抛错或删行）。
- **搜索（§11）**：MiniSearch 内存索引，字段含标题/正文/标签/文件夹/附件名；支持模糊与前缀；**标题命中权重更高**；`clear()` 丢弃全部明文；测试断言「建完索引后数据库里仍无明文」。
- **高亮不产生标记**：`highlightSegments` 返回纯文本片段（调用方决定怎么渲染），且查询词**按字面**处理（`.*`/`<b>` 都不会被当成模式）。
- **踩坑**：MiniSearch 7 的 `result.match` 是**普通对象**（`{term: field[]}`）而不是 Map → 字段名是**值**不是键；已按「值」提取，并且兼容 Map 形态，避免以后版本变化时静默返回「无命中」。

### 16.2 P5 **尚未完成**的部分（下一会话请从这里继续）

**仅剩 UI**（用户要求 P5 一并交付；服务端与数据层/搜索已就绪）：

1. **三栏布局**：文件夹/标签 | 笔记列表 | 编辑器（移动端需独立布局，不是桌面缩小）。
2. **排序与组织**：最近修改/创建时间/标题/手动拖拽、置顶、最近打开列表。
3. **全局搜索 UI**：搜索框 + 结果高亮 + 快捷键。
4. **命令面板**与完整键盘快捷键。
5. **解锁与登录界面**：接 `KeyStore` 与 `GET /key-material`（P4 只交付了底座），首运行用 `/auth/setup` 的 QR + 10 个恢复码。
6. **编辑器本体属 P6**：P5 的编辑面先用简单文本域，P6 换成 Milkdown/CodeMirror。

验收方式（用户已确认）：我实现 + 你在浏览器里做视觉/交互验收；我这边能验证渲染与状态流转，但不能替代真实浏览器体验。

### 16.3 提示下一会话

- 新增数据路由请沿用本批模式：`requireSession` + 写操作 `requireCsrf`、Zod `.strict()`、所有查询带 `user_id`、每次变更写 `sync_changes`。
- 清点类测试请用 `apps/worker/test/notes.test.ts` 作为模板（含 IDOR 与同步流断言）。

## 17. P5 第 5 批：UI（本次交付）— **P5 代码完成，视觉待你验收**

### 17.1 交付物

| 文件                                                   | 内容                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`                                 | 应用外壳：引导 → 首运行/登录/解锁 → 三栏（文件夹/标签 \| 笔记列表 \| 编辑器） |
| `apps/web/src/styles/app.css`                          | 外壳样式（**刻意朴素**，视觉语言待 P6 编辑器落地后统一）                      |
| `apps/web/src/app/flows.ts`                            | 注册（生成并上传包裹密钥）、登录并解锁、记住设备、离线设备解锁、销毁本地密钥  |
| `apps/web/src/state/unlock.ts`                         | 解锁状态机（纯 reducer，含「撤销/登出必须销毁本地密钥」）                     |
| `apps/web/src/ui/sort.ts`                              | 四种排序 + 置顶优先 + 最近打开 + 手动顺序                                     |
| `apps/web/src/ui/shortcuts.ts`                         | 快捷键表与匹配规则 + 命令面板（含构造与过滤）                                 |
| `apps/web/src/ui/ui-logic.test.ts`、`src/App.test.tsx` | 20 测试                                                                       |

### 17.2 本次修掉的两个真实问题

1. **本地 schema 缺 `pinned`/`sortOrder`**：§10 要求置顶与手动排序，但 P4 的 `LocalNote` 没有这两个字段。已**新增 schema v3** 并在迁移里补默认值——顺带暴露出迁移器的一个真实缺陷：
2. **迁移器多版本时重复复制**：`1 → 3` 会按每个版本各复制一遍所有表，后一遍会用**未经前一遍变换**的行覆盖已写入的行（`cachedAt` 因此变回 undefined）。已改为**把所有步骤组合成一次变换、单趟复制**，并加了断言。
3. React 规则：搜索索引与 KeyStore 原先在 render 期间读 `ref`（react-hooks 报错）→ 改为 `useState` 惰性初始化的稳定实例。

### 17.3 已实现的行为（可测部分都有测试）

- **首运行**：输入用户名 → 生成并上传 KEK 包裹的 DEK 与 10 个恢复包裹 → **一次性展示 otpauth URI 与 10 个恢复码** → 确认后进入应用。
- **登录**：用户名 + TOTP 码 + 「记住此设备」；记住时才写入设备包裹，**不记住时会主动清掉旧的离线解锁路径**。
- **离线解锁**：设备密钥解开本地 DEK（无网络、无 TOTP）；此路径**拿不到 TOTP secret**，因此离线会话不能重包裹密钥。
- **App Lock**：40 分钟无活动自动上锁（每 30 秒检查一次，且每次读取密钥材料时惰性判定）。
- **401 处理**：任何 `UNAUTHENTICATED` → 销毁本地密钥并回到登录，并给出提示（§4）。
- **三栏 + 排序/置顶/最近打开/搜索高亮/命令面板/快捷键/回收站视图/保存（Ctrl+S，加密写入 + 入队）**。
- 搜索索引在解锁后建立、上锁时 `clear()`（§11 不允许持久化明文索引）。

### 17.4 **请在浏览器验收的清单**（我无法替代真实视觉/交互判断）

```bash
# 本机 8787 已被别的进程占用，所以把 worker 跑在 8791 并把 Vite 代理指过去：
cd apps/worker
HOME=/home/SZX10246/Projects/software/SecureNotes/.sandbox-home npx wrangler dev --port 8791

# 另一个终端：
cd /home/SZX10246/Projects/software/SecureNotes
VITE_API_TARGET=http://127.0.0.1:8791 pnpm dev:web      # http://localhost:5173
```

`VITE_API_TARGET` 是本次新加的开关（`apps/web/vite.config.ts`），默认仍是 8787。
**若 8787 上跑着别的服务，`pnpm dev:web` 会把 /api 代理到那个服务**，界面会一直失败——务必确认代理指向本项目的 worker。

本次已实测（真实 HTTP，非 jsdom）：Vite 提供外壳 200、`/api/v1/auth/status` 经代理返回
`{"ok":true,"data":{"initialized":false}}`、入口模块可编译并提供、`sw.js` 在根路径可用。

1. 首次打开应显示 **First run**；输入用户名后显示 **otpauth URI 与 10 个恢复码**（只显示一次）。
2. 用认证器扫码/添加 URI 后，用 **Sign in** 输入 6 位码登录。
3. 三栏布局在窄屏是否可用（**移动端独立布局尚未实现**，见 17.5）。
4. 新建笔记、输入标题与正文、`Ctrl+S` → 出现「Saved locally and queued for sync」提示。
5. `Ctrl+K` 打开命令面板；`Ctrl+Shift+R` 打开回收站；`Ctrl+B` 切换侧栏；`Ctrl+P` 打开面板。
6. 搜索框输入标题片段 → 列表项命中处应有黄色高亮。
7. 刷新页面 → 应显示 **Locked**，点「Unlock this device」能离线解锁并看到刚才的笔记。
8. 在 D1 里直接看 `notes` 表：**载荷必须是密文**，任何表里都不应出现标题/正文明文。

### 17.5 明确**未**完成的部分

- **移动端独立布局**（§22 要求不是桌面缩小）——未实现。
- 文件夹/标签的**本地链接**：UI 目前只显示笔记列表，`note_tags` 的本地写入与文件夹树交互未接（服务端 API 已就绪）。
- 编辑器仍是**简单文本域**；Milkdown/CodeMirror 属 P6。
- 附件上传的 UI（API 已就绪）。
- 主题切换（跟随系统/手动亮/暗）——目前只有跟随系统的 CSS 变量。
- `manifest.webmanifest` 仍是占位图标。

## 18. P5 修复：注册向导无法完成（用户报告，已修）

### 18.1 现象与根因

用户报告：**输入用户名后没有显示 otpauth URI 与 10 个恢复码。**

根因：`POST /auth/setup` **不创建会话**（P2 的设计决定），但 `enrolAccount()` 在创建账户之后
必须调用 `POST /security/operation-nonce` 与 `POST /key-material` 上传包裹后的 DEK —— 这两个端点
都受 `requireSession` 保护，于是返回 **401**，函数抛出，向导在**已经创建了账户之后**失败，
所以二维码与恢复码从未渲染。更糟的是：账户已存在（再次 setup 会 412），而密钥材料永远无法上传。

这是我引入的真实缺陷；P2/P3 的测试都没覆盖「注册向导」这条路径（它们各自调用 setup 与 key-material，
但从不把两者串成一次流程）。

### 18.2 修复

`POST /auth/setup` 现在**建立第一个会话**（HttpOnly+Secure+SameSite=Strict 的 session 与可读的 csrf），
于是客户端可以在同一次向导里完成密钥材料上传。代价已在 `docs/decisions.md` 记录并被限定：
第一个会话由「创建账户」这一行为本身建立（谁能先到达该端点，账户本来就是谁的），
**后续任何会话仍然需要当前 TOTP 码**，且注册会话不是 remember-device 会话。

### 18.3 验证

- **真实 HTTP 全流程实测**（`wrangler dev`，全新数据库）：
  `POST /auth/setup` → 200，返回 session + csrf Cookie、totpUri、10 个恢复码；
  `POST /security/operation-nonce` → **200（修复前是 401）**；
  `POST /key-material`（10 份恢复包裹）→ 200 `{keyMaterialPresent:true,keyVersion:1}`。
- **新增回归测试** `apps/worker/test/enrolment.test.ts`（3 测试，独立空库）：
  1. setup 返回的会话能真正用于开 nonce 与上传密钥材料（直接覆盖本次缺陷）；
  2. 第二次 setup 返回 412 且**不发放会话**；
  3. 首个会话在审计里留下 `session_created` 事件且 detail 为密文。

### 18.4 仍需你注意

- 若浏览器在向导中途关闭：账户可能已创建但密钥材料未上传。此时再次 setup 会 412，
  而恢复码/二维码可能未保存 → **需要手工清空本地 D1 状态重来**（本地开发环境：删除
  `apps/worker/.wrangler/state`）。生产环境下的「重新完成注册」流程**尚未实现**，
  已记录为后续项。
- 本地 D1 已重置为首运行状态，你打开浏览器应看到 **First run**。

## 19. P6 第 1-4 批：渲染安全 + 管线 + 编辑器 + 高亮/主题/移动端 — **P6 接近完成**

### 19.1 交付物

| 文件                                             | 内容                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `apps/web/src/render/sanitize.ts`                | 净化核心：`sanitizeHtml`、`sanitizeSvg`、`sanitizeCss`、URL 策略、嵌入隔离、`containsActiveContent` |
| `apps/web/src/render/sanitize.test.ts`           | **26 个攻击性测试**（§31 的 XSS/存储型 XSS/SVG/净化绕过/CSS 注入/iframe 隔离）                      |
| `apps/worker/src/middleware/security-headers.ts` | **外壳 CSP**（P0 时预留、本次落地）+ 按内容类型选择策略                                             |
| `apps/worker/test/security-headers.test.ts`      | +4 测试（外壳策略内容、API 策略未受影响、按内容类型分流）                                           |

### 19.2 三个实测出来的关键事实（都改变了实现）

1. **DOMPurify 的 allowlist 是闸门，hook 只能收紧不能再放宽。** 不在 `ALLOWED_TAGS`/`ALLOWED_ATTR` 里的东西**在 hook 运行前就被删掉了**，所以 `style` 与**每个 SVG 子元素**（rect/circle/use…）都必须显式列出，否则「合法内容也一起消失」。
2. **绝对不要自定义 `ALLOWED_URI_REGEXP`。** DOMPurify 会把它套用到**所有不在其内部 URI-safe 列表里的属性**，而不只是 URL —— 我最初写了 `/^(?:https?:|\/|#)/i`，结果 `type="checkbox"` 被判为非法、输入框整个变成空。URL 策略改为在 hook 里按属性判定。
3. **位置相关的规则要自己做。** 「元素是否在 `<svg>` 内（故只允许 `#fragment` 引用）」「input 是否是任务清单复选框」都不是平铺的属性过滤能表达的 → `hardenFragment` 在解析后的 DOM 上执行。

### 19.3 已实现并测试的安全属性

- `<script>`/`on*`/`javascript:`/`vbscript:`/`data:` 全部拒绝；`//host` 协议相对 URL 也拒绝。
- 外链自动 `target="_blank" rel="noopener noreferrer"`，站内锚点**不**加 target（§12）。
- CSS 严格允许列表 + 逐属性值校验；`url()`/`expression()`/`@import`/反斜杠转义/注释走私全部拒绝。
- SVG：去 script/事件/`foreignObject`；`href` 只允许 `#fragment`（`<use href="#x">` 可用，外部引用被剥）。
- 嵌入：**sandbox 含 `allow-scripts` 但绝不含 `allow-same-origin`**，`no-referrer`，无权限；仅 HTTPS。
- 净化**幂等**（二次净化结果相同），并有经典变异的绕过测试（`<scr<script>ipt>`、`<math><mtext><script>`、`noscript` 属性逃逸、`&#106;avascript:` 等）。
- 外壳 CSP：`script-src 'self'`（**无 inline/eval**）、`object-src 'none'`、`frame-ancestors 'none'`、`img-src https: data:`、`frame-src https:`、`style-src 'self' 'unsafe-inline'`（KaTeX/Mermaid/净化后的 style 属性需要）、`connect-src 'self'`。

### 19.3b 第 2 批：Markdown 渲染管线（`src/render/markdown.ts` + `markdown.test.ts`，18 测试）

- **一条管线两个方向**：编辑与渲染共用同一组 remark 插件（`remark-parse`/`remark-gfm`/`remark-math`），
  所以「存进去的」与「显示出来的」不会分叉。
- **round-trip（§12）**：`:::note` 这类未知扩展**原样保留**；内联自定义语法即使序列化器加了转义
  （`[value]` → `\[value\]`），也断言**渲染结果相同**且**二次序列化稳定**——这比强行要求字节相同更诚实。
- **KaTeX**：`rehype-katex` + `trust:false`，测试断言 `\htmlData`/`\href{javascript:…}` **不产生标记**，
  且 TeX 原文被消费（`class="katex"` 存在、`a^2 + b^2` 不再作为文本出现）。
- **Mermaid**：`renderMermaidBlocks` 走 §12 指定的 `Markdown → Mermaid → SVG → 净化 → DOM`；
  渲染失败的块**保留原始文本**（坏图不能删掉作者写的内容）；无 mermaid 块时不做任何事。
- **敌意 Markdown（§31）**：8 类向量（`<img onerror>`、`javascript:` 链接、`data:` 图片、`<iframe>`、
  `<svg onload>`、内联 `<style>` 等）渲染后**无活动内容**；代码块内的 `<script>` 被转义为文本。
- **已接入界面**：编辑器新增 **Preview** 开关，渲染经 `renderMarkdown` + `renderMermaidBlocks`，
  是仓库里**唯一**使用 `dangerouslySetInnerHTML` 的地方（净化是它可接受的理由）。

### 19.3c 第 3 批：编辑器本体 + 首屏体积（`src/editor/*`，8 测试）

- **Markdown 源码模式**（CodeMirror 6 + `@codemirror/lang-markdown`）：显示的就是存储格式本身，
  因此它也是验证「未知扩展是否幸存」的地方。改动只回报给笔记文档，**绝不直接写存储**，
  所以一次按键无法绕过「加密 + 入队」这条路径。
- **WYSIWYG**（Milkdown + `commonmark` + `gfm` preset）：**Markdown 仍是存储格式** ——
  从笔记的 Markdown 建编辑器、回报 Markdown，保存的永远不是编辑器自己的文档模型。
  gfm preset 提供 §12 要求的表格与任务清单。
- **模式规则可测**：`defaultEditorMode(视口宽, 是否粗指针, 已存偏好)` → 手机/粗指针默认 WYSIWYG（§12），
  桌面默认源码，用户显式选择优先。已存偏好参数为下一步的持久化预留。
- **14 个测试里我明确不假装覆盖的部分**：WYSIWYG **不做 jsdom 渲染测试** ——
  Milkdown 建立在 ProseMirror 上、需要真实布局引擎（与 Mermaid 的 `getBBox` 同类限制）。
  我验证的是「模块可加载、宿主可挂载」，并在测试注释与报告里写明**真实编辑体验需要你在浏览器验收**。

#### 首屏体积：一次我造成又修掉的退化

| 阶段                            | 入口 chunk         | gzip       |
| ------------------------------- | ------------------ | ---------- |
| 第 2 批后（KaTeX 静态引入）     | 835 KB             | 259 KB     |
| 第 3 批首次尝试（以为已懒加载） | **976 KB（更糟）** | 325 KB     |
| 修复后                          | **370 KB**         | **117 KB** |

**为什么会先变糟**：我把 `defaultEditorMode` 从 `MarkdownSourceEditor.tsx` 静态引入 App，
而那个文件 `import` 了 CodeMirror —— 于是「懒加载编辑器」被一个**常量导入**击穿。
**两个独立信号同时指出了这个设计缺陷**：ESLint 的 `react-refresh/only-export-components`
（组件文件不得导出常量）与构建产物。把该函数移入 `src/editor/mode.ts`（不引入任何编辑器）
后两者同时消失。

已实测确认：入口 chunk 中 **katex / milkdown / prosemirror / codemirror 全部不存在**；
编辑器与渲染管线按需加载，Mermaid 的图类型各自分块（最大 elk 1.4 MB，仅在真的渲染对应图时才取）。

### 19.4 P6 尚未完成（下一批）

1. **代码块语法高亮**（Shiki/refractor）与动画 GIF/WebP 保留。
2. **粘贴/拖放**：富文本网页粘贴的提示与安全转换路径；剪贴板图片立即创建附件并插入内部附件 ID；拖放仅接受图片、>20MB 拒绝。
3. **附件引用 UI**（引用计数/归零异步删除的服务端已就绪）。
4. **移动端独立布局**（§22 要求不是桌面缩小）。
5. **编辑器模式的持久化**（`defaultEditorMode` 的 `stored` 参数已预留）。
6. `manifest.webmanifest` 真实图标、主题手动切换（跟随系统/亮/暗）——P5 遗留项。
7. **WYSIWYG 的真实浏览器验收**：Milkdown 的编辑体验无法在 jsdom 验证，需你确认。

### 19.5 Mermaid 的 CSP 问题：已实测，**不需要 `unsafe-eval`**

我曾提示「Mermaid 可能需要 `'unsafe-eval'`，那会与 §13 冲突」。**这是猜测，不是事实**，所以我先测了：

| 检查                                                                     | 结果                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 整个 Mermaid 12 bundle 里 `new Function(` / `eval(` 出现次数             | **0 / 0**                                                         |
| 把 `Function` 构造器替换为「调用即抛错」的 Proxy 后，逐个解析 8 种图类型 | **0 次违约**                                                      |
| 在同样污染下渲染无布局依赖的图（pie）                                    | 成功产出 SVG                                                      |
| 该 SVG 再过一遍 `sanitizeSvg`                                            | 无活动内容（§12 的 `Markdown → Mermaid → SVG → 净化 → DOM` 成立） |

**结论：CSP 不放宽** `script-src 'self'`（无 inline、无 eval），§13 保全。
新增守卫测试 `apps/web/src/render/mermaid-csp.test.ts`：**静态审计** Mermaid 的整个 `dist`（读取每个 `.mjs`/`.js`，断言无 `new Function(`/`eval(`，并断言实际扫描量 > 500KB，避免目录变动时「静默通过」）。一旦未来升级引入这些构造器，测试**直接失败**，而不是让 CSP 因为「图渲染不出来」被悄悄放宽。

**一次自我纠错值得记录**：这个守卫的第一版是在运行时把 `globalThis.Function` 换成「调用即抛错」的 Proxy，然后断言 0 次违约。我给它加了自检（断言污染确实生效），结果自检**失败**——替换根本没生效，也就是说那版守卫**无论 Mermaid 做什么都会通过**。**不会失败的守卫比没有守卫更糟，因为它会被相信**。因此改为静态审计。

（jsdom 没有布局引擎，flowchart 等类型会因 `getBBox` 缺失而无法渲染——那是渲染限制，与 script 策略无关；因此广度用 `parse` 覆盖，实际 `render` 只取无布局依赖的类型。）

### 19.6 第 4 批：高亮、粘贴/拖放、主题、移动端布局、manifest 图标

| 交付              | 说明                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 语法高亮          | `rehype-highlight`（`detect:false`）接在**懒加载**的渲染管线里；**自写 hljs token 配色**（含暗色），否则「已交付高亮」在界面上根本看不到颜色 |
| 粘贴/拖放规则     | `src/editor/paste.ts`：剪贴板图片优先于同次粘贴的文本、>20MB 拒绝、拖放仅图片且**混合拖放整体拒绝**（不留「到底进了哪个文件」的疑问）        |
| 附件引用          | `src/editor/attachments.ts`：引用用**内部附件 ID**、alt 只放文件名、`diffAttachmentRefs` 计算增删（归零即触发异步删除，出错会误删在用图片）  |
| 附件上传客户端    | `src/data/attachments-client.ts`，字段与 API 契约一致（`metadata` + `blob`，201 返回 `data.attachment`）                                     |
| 主题              | 系统/亮/暗，**显式选择优先于系统**（`resolveTheme` 纯函数 + 测试）；以 `data-theme` 应用，配色含暗色 token                                   |
| 编辑器模式持久化  | `loadEditorMode`/`saveEditorMode`（localStorage，本机 UI 状态，不同步）                                                                      |
| 移动端布局（§22） | 独立布局而非桌面缩小：单栏、文件夹面板转为默认收起、**窄屏上一次只显示一个面板**（打开笔记即切到编辑器）、触控目标 ≥44px、安全区内边距       |
| manifest 图标     | 由 `icon.svg` 生成**真实 PNG**（192/512/maskable-512），我**实际查看了 192px 图标**确认不是空白；manifest 指向三者                           |

#### 两个我**没有**假装完成的地方

1. **附件加密无法表达（需要你决策）**：`POST /attachments` 的 `metadata` 只有
   `id/name/contentType/sizeBytes` —— **没有任何信封字段**（IV、key_version、密文参数）。
   也就是说**客户端今天无法像加密笔记那样加密附件字节**。我没有把明文传上去冒充「已完成」，
   而是让图片粘贴/拖放**明确报告这一缺口**。可选路径：(a) 加迁移给附件表补信封列（P7 一并做），
   或 (b) 在 P7 定义附件加密方式。**这属于需求 §7「一切加密」与当前 API 的真实冲突，我不擅自决定。**
2. **富文本粘贴只接了明文路径**：「来自网页的粘贴」会询问，选**纯文本**可用；
   **保留格式**尚未接线（需要 HTML→Markdown 转换器 + 我们的净化层）。粘贴偏好也**尚未持久化**。

#### 另外两处待验证/待做

- **GIF/WebP 动画保留**未验证（`<img>` 引用不经过解码，理论上保留，但我没有实测，不写成已完成）。
- **附件引用 UI**（插入/列出/删除）未做。

### 19.7 附件内容信封（用户决策：加迁移）

**决策**：附件字节必须能加密（§7）。`POST /attachments` 原先只有 `id/name/contentType/sizeBytes`，
**没有任何承载内容信封的字段**，所以客户端无法像加密笔记那样加密附件。

**迁移** `0003_attachment_content_envelope.sql`：给 `attachments` 加
`content_iv TEXT` 与 `plaintext_size_bytes INTEGER`（两列可空 —— SQLite 无法加无默认值的 NOT NULL 列，
而给历史行编造 IV 会产生「看起来能解密、实际不能」的数据；新上传由 API 强制要求）。
`name_iv`/`name_ciphertext` 与 `crypto_version`/`key_version` 列**本来就有**（名称信封早就是加密的）。

**服务端**：

- `metadataSchema` 增加 `contentIv`、`plaintextSizeBytes`（仍 `.strict()`）。
- 校验**密文与明文的绑定**：`sizeBytes - plaintextSizeBytes === 16`。这不是装饰 —— 它让客户端
  无法为一个大上传声明一个小明文；对 GCM 而言二者的差恒为 tag 长度。
- 原有的「声明大小 == 实发字节」检查保留（少报仍是绕过上限的手段）。

#### 本次测试抓到的一个真实数据完整性缺陷

新增的「记录 IV」测试第一次运行时报告 `expected '16.0' to be 'BBBBBBBBBBBBBBBB'`。
根因：我在 INSERT 里**重排了 `?N` 占位符却没同步参数顺序**，而 `bind()` 是**按位置**传参的 ——
结果是 `content_iv` 被写入了明文长度（16）、`created_at` 被写入了 IV 字符串、`plaintext_size_bytes`
被写入了时间戳。这正是 P5 阶段同类错误的重复（批量 UPDATE 混用 `?N`/`?`）。
现在占位符顺序与绑定顺序一致，并在代码里写明了原因。

**`apps/worker` 195 测试**（新增 5：IV 落库、缺 IV 拒绝、明文/密文不一致拒绝、声明大小不符仍拒绝、
以及**字节往返** —— 用带 `NETSCAPE2.0` 循环扩展的 GIF 头验证内容**未被重新编码**，
这是「动画不会被压平」的可测代理）。

**客户端加密与接线（已完成）**：`src/data/attachments-client.ts` 在**字节离开浏览器之前**加密
（AES-256-GCM + DEK + fresh 96-bit IV，AAD 绑定 `attachment_blob` + 附件 id + key_version）。
对象类型用的是**冻结格式里已有的 `attachment_blob`**，因此没有改动冻结文件。
图片**粘贴与拖放**已接到这条路径：引用只在服务端确认存下对象**之后**才插入，所以失败的上传
不会留下指向空的引用。

测试里读的是**可解密性**而不是请求体形状：加密后用同一 DEK 能解回原字节、换 id 或换密钥都解不开、
两次上传 IV 必然不同、上传的字节里不含明文、超限与空文件在**加密与请求之前**就被拒绝
（断言 `fetch` 从未被调用）。

### 19.8 附件引用 UI 与引用计数（本批）

- **引用计数以笔记正文为准**：面板列出的是**从正文解析出来的引用**（`attachmentRefsIn`），
  不是另存一份列表 —— 两者不可能互相矛盾。
- **上传即链结**：上传成功后立刻 `POST /notes/:id/attachments`。若只在保存时才链结，
  一个「已上传但尚未被任何笔记引用」的对象会被清理程序当作孤儿删掉。
- **删除即改文本**：Remove 只从正文里去掉引用；真正的解链发生在**保存**时由
  `diffAttachmentRefs(打开时的引用, 当前引用)` 统一决定 —— **只有一条决定引用计数的代码路径**，
  避免「UI 删了但计数没降」或反之。
- **解链是尽力而为**：某个引用已经不存在（404）不会阻止其余引用被清理；计数正是决定对象
  能否被删除的东西，一个陈旧引用不该把其他清理堵住。
- 服务端在计数归零时**入队**异步删除（幂等清理），本批未改动这部分。

**测试**：`syncAttachmentLinks` 精确调用「该链的链、该解的解」（断言 URL 与 method）；
一个 404 不阻断其余；文本没变时**一次请求都不发**。
