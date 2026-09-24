# SecureNotes 实施方案与任务清单

> 本文件导出「已批准方案 + 任务列表」，供新会话与后续阶段直接使用。
>
> - 需求唯一权威：`requirements.md`（1067 行，已冻结）
> - 决策记录（含被否决备选）：`docs/decisions.md`
> - P0 执行细节、环境限制、踩坑结论：`HANDOFF.md`
> - 架构 / 加密格式 / API 契约 / 威胁模型：`docs/architecture.md`、`docs/crypto-format.md`、`docs/api-contract.md`、`docs/threat-model.md`

---

# 第一部分：方案

## 1. 目标与信任边界

个人单用户、客户端加密、local-first 的 Markdown 备忘录 PWA；部署在 Cloudflare Workers + D1 + R2；认证为自建 用户名 + TOTP；加密与解密全部在浏览器完成。

```text
Internet → Cloudflare DNS/HTTPS → Worker(auth/session/API 校验/sync) → D1(ciphertext) + R2(encrypted images)
                                          ↑
                    Browser(唯一可信明文区：编辑、加密、IndexedDB、同步队列、搜索索引、SW)
```

- 服务端**不可见**：笔记标题/正文、文件夹名、标签名、附件原始文件名、搜索查询与内容。
- 服务端**可见**（需求 §24 允许）：IP、时间、UA/网络信息、API 路径、随机对象 ID、大小、创建时间、结构关系、同步/会话元数据。
- 威胁模型：常规互联网攻击（爆破、XSS、CSRF、SQLi、会话劫持、越权、恶意上传、重放、同步冲突）。
- 明确接受：Worker 运行时被完全攻破并拿到 D1/R2/会话密钥/TOTP Secret/环境密钥后，历史数据可能被解密（需求 §25）。

## 2. 技术栈选型（ADR-001）

| 层        | 选型                                                                     | 理由                                             |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| 仓库      | pnpm workspace 单仓（apps/* + packages/*）                               | Worker 与前端共享类型、错误契约、加密格式常量    |
| Worker    | Hono + TypeScript(strict) + Zod                                          | 体积小、中间件模型契合「每端点校验/鉴权/限流」   |
| 前端      | React 19 + Vite 8                                                        | 三栏布局、命令面板、冲突对比 UI 可控             |
| WYSIWYG   | **Milkdown v7**（ProseMirror + remark）                                  | Markdown 原生双向；未知语法可降级为 raw 节点保留 |
| 源码模式  | CodeMirror 6                                                             | 需求 §12 的 Markdown source mode                 |
| 本地存储  | Dexie（IndexedDB）                                                       | 版本化迁移，满足「保留旧库、迁移成功后再切换」   |
| 搜索      | MiniSearch                                                               | 内存索引，模糊 + 高亮，不落盘明文索引            |
| 净化/渲染 | DOMPurify（HTML + SVG 双 profile）、KaTeX(`trust:false`)、Mermaid、Shiki | 需求 §12/§13，使用成熟 Sanitizer                 |
| 导出      | fflate                                                                   | 全量明文 ZIP                                     |
| 测试      | Vitest + `@cloudflare/vitest-pool-workers`、Playwright、fast-check       | 需求 §31 的 24 项安全必测                        |
| TOTP      | Worker 内自实现 HMAC-SHA1 + Base32（Web Crypto）                         | 避免引入不可审依赖                               |

**最高风险点**：Milkdown 的 Markdown round-trip 保真（需求要求未知扩展必须原样保留）。对策：Markdown 始终是唯一真相源，未知块降级为 raw 节点，先写 round-trip 属性测试（parse→serialize→parse 必须稳定）再写功能。

## 3. 目录结构

```text
SecureNotes/
├─ pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  .prettierrc.json
├─ README.md  SECURITY.md  HANDOFF.md  PLAN.md  requirements.md
├─ docs/{architecture,crypto-format,api-contract,threat-model,decisions}.md
├─ scripts/check-version.mjs
├─ packages/shared/            # 类型、Zod schema、错误契约、加密格式与 AAD
├─ apps/worker/
│  ├─ wrangler.toml  migrations/  worker-configuration.d.ts（wrangler types 生成）
│  ├─ src/{api/v1,middleware,domain,db,lib}/  app.ts  index.ts  env.ts  version.ts
│  └─ test/
└─ apps/web/
   ├─ src/{crypto,storage,sync,editor,markdown,sanitizer,search,ui,api,pwa}/
   ├─ public/（manifest、icons）
   └─ e2e/（Playwright，含安全用例）
```

## 4. 关键机制落地（把需求变成可编码规格）

**加密信封**（每个对象统一）：`{crypto_version, key_version, alg:"AES-256-GCM", iv(12B 随机), ciphertext}`，`ciphertext` 含 16B GCM tag。
**AAD**：`SecureNotes/v1|object_type|object_id|revision|key_version|crypto_version`，`object_id` 限 `[A-Za-z0-9_-]{1,64}`，解密时确定性重建并校验；绑定对象身份与版本，防止跨对象替换与降级重放。每次加密使用全新随机 96-bit IV。

**密钥层级**：`KEK = HKDF-SHA256(username ‖ TOTP Secret ‖ 固定应用上下文, account_kdf_salt)` → 包裹 DEK → DEK 用 AES-256-GCM 加密全部数据；6 位动态码永不作为 KDF 输入。
**恢复路径**：每个恢复码独立 salt/context → Recovery KEK → 各自包裹 DEK（10 份）；服务端只存恢复码哈希 + 包裹结果。
**TOTP Secret 下发（ADR-002）**：认证通过后经 HTTPS 一次性返回客户端用于派生 KEK，仅存内存，不落盘/不进日志/UI 不可导出。
**换绑迁移（ADR-004）**：只重包裹 DEK + 10 个恢复码并升 `key_version`；可中断续跑、可回滚；存在未同步改动时禁止换绑，迁移期间禁用编辑。

**会话**：UUIDv7 + 256-bit 随机 token，服务端只存 SHA-256；Cookie `session; HttpOnly; Secure; SameSite=Strict; Path=/`；40 分钟滑动过期（距上次写入超过阈值才写 D1，需求 §4 允许）；最多 5 个，第 6 个淘汰最久未活动者（ADR-005）；列表展示最近活动、浏览器+OS、IP 截断、当前设备标记、可改设备名；单个撤销 + 全部撤销（含当前）。
**限流/审计**：D1 按 IP/账号/全局三类桶 + 指数退避（有上限，永不永久锁定）；`audit_logs` 敏感字段加密、IP 截断、UA 仅类别、失败原因仅类别、保留恰好 30 天由 Cron 清理、用户不可手动清除。
**离线解锁（ADR-003）**：IndexedDB 存 KEK 包裹的 DEK + 不可导出设备 CryptoKey 包裹的 DEK；App Lock 40 分钟；离线解锁走设备密钥；联网登录与同步仍强制 TOTP；可选 WebAuthn 后续叠加。
**附件**：仅图片、≤20MB、保留原始分辨率/GIF 动图/动态 WebP、不自动压缩；客户端用 DEK 加密字节后上传，R2 key 为 `attachments/{random-id}`，原始文件名加密；`attachments` + `note_attachments` 引用计数，归零后异步幂等删除 R2 对象。
**同步**：local-first 增量；客户端携带 `base_revision`，服务端仅在相等时接受，否则建冲突而非静默覆盖；冲突保留 Base/Local/Remote 三方 + Markdown 三方合并辅助；删除-修改一律冲突；离线新建可用临时 ID，同步后由服务端映射并原子重写引用；同笔记串行、异笔记并行；退避重试，多次失败后暂停自动重试并保留队列 + `Sync Now`；服务端 cursor 增量 + tombstone 30 天。
**编辑器与净化**：Markdown 为规范存储格式，WYSIWYG 默认 + 源码模式；严格 CSP 且绝不为放行脚本而放宽（`frame-src https:`、`img-src https:` 是需求允许的必要放宽）；HTML 走 DOMPurify + 自定义规则，禁 `<script>` 与全部内联事件属性，`style` 严格过滤；SVG 严格净化（禁 script/事件/危险外部引用）；Mermaid 客户端渲染且 SVG 必须再过净化器；KaTeX 仅用其安全 HTML 输出；链接仅 `http/https` + `rel="noopener noreferrer"`；不自动把纯文本转链接；iframe 任意 HTTPS 但必须 `sandbox` 且**不得同时给 `allow-same-origin`**，确保无法触达应用 DOM/存储。

**API**：同源 `/api/v1/*`，**永不开启 CORS**；CSRF 三重防护（double-submit token + 严格 Origin/Referer + SameSite=Strict）；严格 `Content-Type`、每端点固定方法集、schema 校验、body 大小/字段数/深度/数组长度限制、资源归属校验；全部参数化 SQL + 外键 + 索引 + 事务；生产错误统一通用结构，绝不暴露堆栈/SQL/密钥。

## 5. 已确认决策（ADR，用户已批准）

| 编号    | 决策                                                            |
| ------- | --------------------------------------------------------------- |
| ADR-001 | 技术栈（见 §2），编辑器选 Milkdown                              |
| ADR-002 | 认证后经 HTTPS 下发 TOTP Secret 供客户端派生 KEK，仅存内存      |
| ADR-003 | 离线/App Lock 解锁用不可导出设备密钥包裹的 DEK                  |
| ADR-004 | TOTP 换绑只用最小化迁移（重包裹 DEK + 恢复码 + 升 key_version） |
| ADR-005 | 第 6 个会话淘汰最久未活动者并写审计                             |
| ADR-006 | 逐阶段交付，每阶段结束暂停等确认                                |

## 6. 分阶段执行计划（需求 §30）

| 阶段 | 范围                                                           | 完成判据                                                                                                                |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P0   | 脚手架：workspace、Worker 骨架、客户端外壳、质量链路、文档     | ✅ **已完成**（`pnpm check` 全绿 + 构建成功 + 健康检查端到端可达 + 首个 commit）                                        |
| P1   | D1 schema 与迁移（14 张表 + 限流表）                           | ✅ **已完成**（本地迁移跑通 + 外键/索引生效 + 23 个 schema 测试通过）                                                   |
| P2   | 认证域（初始化/TOTP/恢复码/会话/限流/审计/CSRF）               | ✅ **已完成**（新增 90 测试：P2 集成 54 + 密码学基础 36；§32「Authentication」9 项全满足）                              |
| P3   | 加密域（信封/AAD/密钥层级/恢复包裹/换绑迁移）                  | ✅ **已完成**（新增 35 测试：shared 20 + worker 15；§32 Encryption 12 项中 **7 项**已满足，其余 5 项需客户端与数据域）  |
| P4   | 本地层（Dexie 迁移、设备密钥、App Lock、PWA/SW、静态资源绑定） | ✅ **已完成**（新增 32 测试：迁移/设备密钥/App Lock/淘汰/更新门控；§32 Offline/Platform 部分项需 P5 数据域）            |
| P5   | 数据域（notes/folders/tags/revisions/回收站/附件/搜索）        | ✅ **已交付**（服务端 + 客户端数据层 + 搜索 + 三栏 UI；**视觉/交互待用户在浏览器验收**）                                |
| P6   | 编辑器与渲染安全                                               | 🔶 **进行中**：净化/CSP/嵌入隔离/Markdown 管线（KaTeX+Mermaid）/预览已交付（49 测试）；编辑器本体·语法高亮·粘贴拖放待续 |
| P7   | 同步（cursor/乐观锁/冲突三方合并/重试/tombstone）              | 需求 §32「Sync」全部勾选                                                                                                |
| P8   | 导入导出 + 恢复包 + SW 更新门控                                | 事务性导入回滚测试通过                                                                                                  |
| P9   | 安全加固与验收（需求 §31 全部用例 + §32 逐项）                 | 验收对照报告                                                                                                            |

**每阶段交付格式**：变更摘要 + 测试结果 + 验收对照 + 一个 commit，然后暂停等确认（ADR-006）。

## 7. 质量门禁与工作约定

```bash
pnpm check     # check:version + format:check + lint + typecheck + test
pnpm test      # 仅测试
pnpm format    # 应用 Prettier
```

- 不静默修改冻结需求；实现与需求冲突时**先停下来说明**（需求 §33.2）。
- 不记录秘密/明文；不引入第三方统计；不用 last-write-wins；不自动丢弃未同步改动；不把随机 ID 当授权；不为放行脚本而放宽 CSP；不重用 AES-GCM IV；不持久化明文 DEK。
- 每个安全边界都要有测试；安全敏感代码隔离且可测；DB 变更一律走迁移；用显式 crypto/key version 保证密文兼容性。
- Conventional Commits；每阶段一个 commit。

## 8. 环境与运行前提

- node ≥22、pnpm 10.33、git；**未登录 Cloudflare，全程本地 Miniflare**（本地 D1/R2 在 `.wrangler/state`）。
- 沙箱内**所有 pnpm 命令必须加 `--store-dir .pnpm-store`**（全局 store 在工作区外，写入被拒）。
- `wrangler dev` 需要可写的 `$HOME`（写 `~/.config/.wrangler/registry`），否则报 `EROFS` 退出：用 `HOME="$PWD/.sandbox-home"`（`.sandbox-home/` 已 gitignore）。
- Vite 只绑定 `localhost`（本机解析为 IPv6 `::1`），**用 `http://localhost:5173`，不要用 `127.0.0.1:5173`**。
- `compatibility_date` 必须 ≤ `2026-08-22`（`@cloudflare/vitest-pool-workers@0.22.0` 锁定的 workerd 上限）；提升该日期必须同时升级该测试池。
- 版本约束不可随意升级：`typescript >=5 <6.1`（typescript-eslint peer）、`vitest ^4.1.0`（Workers 测试池 peer）。
- 部署需：自有域名、创建 D1 并替换 `wrangler.toml` 占位 `database_id`、创建 R2 bucket、配置 P2/P3 引入的 Worker secrets。

---

# 第二部分：任务列表

状态图例：`[x]` 已完成并验证 · `[~]` 已完成但未验证 · `[ ]` 未开始

## P0 脚手架（已完成 ✅ 2026-09-24）

- [x] `git init -b main`（main 分支，已创建首个 commit）
- [x] 根配置：`package.json`（含全部脚本）、`pnpm-workspace.yaml`、`tsconfig.base.json`、`eslint.config.js`、`.prettierrc.json`、`.prettierignore`、`.editorconfig`、`.gitignore`
- [x] CI：`.github/workflows/ci.yml`（install --frozen-lockfile + `pnpm check`）
- [x] `scripts/check-version.mjs`（版本一致性校验）
- [x] `packages/shared`：错误契约（封闭错误码 + 通用文案 + 冻结）、`API_PREFIX`/cookie/header 常量、加密格式常量与 `canonicalAad`/`buildAad`、barrel
- [x] `packages/shared` 测试：AAD 确定性/字段绑定/分隔符注入拒绝/非法整数拒绝/文案不泄露（11 测试）
- [x] `apps/worker`：wrangler.toml（D1/R2/Cron/observability/dev 端口）、env.ts、version.ts、`jsonOk`/`jsonFail`、request-id 中间件、安全响应头中间件、`createApp()`（health / 405 / 404 / onError）、worker 入口（fetch + scheduled 占位）
- [x] `apps/worker` 测试用例：health 信封与信息最小化、405、未知路径 404、安全头、API CSP、no-store、request id、HSTS 仅 prod、**生产不泄露 diagnostic/堆栈**
- [x] `wrangler types` 生成并接入 `worker-configuration.d.ts`；`Env` 类型由生成类型派生（`Omit` 拓宽 `ENVIRONMENT`）
- [x] 迁移到 Workers 测试池 0.22 的插件式 API（`cloudflareTest`）
- [x] `apps/web`：Vite 配置（版本注入、`/api` 代理、vitest jsdom）、index.html、manifest、icon、`apiRequest` 客户端（同源 + CSRF + 统一错误）、P0 外壳 UI（健康状态 + 版本 + 跟随系统主题）
- [x] `apps/web` 测试（10 测试：信封解包、文案不泄露、非 JSON 回退、未知码回退、网络错误、CSRF 仅写请求、健康成功/失败渲染、版本展示）
- [x] 依赖安装 + 版本钉死（typescript 6.0.3 / vitest 4.1.11 / hono 4.13.9 / wrangler 4.138.0 / vite 8.3.1 / react 19.3.0）
- [x] `pnpm check:version` 与 `pnpm format` 执行通过
- [x] `pnpm typecheck` 三包全绿
- [x] **跑通 `pnpm --filter @securenotes/worker test`**（12 测试全绿；根因是 `compatibility_date` 超过测试池 workerd 上限，已下调为 `2026-08-22`，详见 `HANDOFF.md` §11.1）
- [x] `pnpm lint` 全绿
- [x] `pnpm build`（web 生产构建）成功
- [x] 端到端验证：`pnpm dev:worker`(8787) + `pnpm dev:web`(5173)，两处 `/api/v1/health` 均返回 200（且无 CORS 头、安全头经代理保留）
- [x] 首个 commit：`chore: scaffold SecureNotes monorepo (P0)`
- [x] 向用户汇报 P0 结果并暂停

## P1 D1 schema 与迁移（已完成 ✅ 2026-09-24）

- [x] `migrations/0001_init.sql`：users、sessions、recovery_codes、totp_config、folders、tags、notes、note_revisions、note_tags、attachments、note_attachments、sync_changes、audit_logs、rate_limits（14 张表，37 条语句）
- [x] 外键 + 索引（含唯一约束、tombstone/cursor 索引）。**关于 `notes(id, revision)` 索引：未新增**——`id` 已是主键，§27 的原子条件本身就是单行主键查找，额外索引只会增加写开销；理由见 `docs/schema.md`「Recorded interpretations」第 4 条
- [x] `notes` 更新使用 `WHERE id=? AND revision=?` 原子条件；`meta.changes === 0` 视为冲突（有测试覆盖）
- [x] 迁移工具链：`wrangler d1 migrations apply securenotes-db --local` 本地跑通；测试侧用 `readD1Migrations` + `applyD1Migrations` 注入同一批 SQL 文件
- [x] schema 测试：表/索引清单、外键级联与 RESTRICT 行为、CHECK 约束、UNIQUE 约束、AUTOINCREMENT 游标不复用、乐观锁、附件引用计数（23 个测试）
- [x] 记录 `database_id` 占位符替换说明（部署前）→ `docs/schema.md`「Before the first deploy」

**遗留到后续阶段（必须用新迁移，不得改 0001）**：P3 的 TOTP 换绑 pending 列与一次性 nonce 表、P7 的冲突状态表；D1 单行大小上限对「超大笔记」的限制也已记录在 `docs/schema.md`。

## P2 认证域（已完成 ✅ 2026-09-24）

- [x] 首运行初始化：设置不可变用户名、生成 TOTP Secret（QR）、生成 10 个 32 字符恢复码、仅展示一次
- [x] 登录：用户名 + 当前 TOTP；恢复登录：用户名 + 一个恢复码（一次性）
- [x] 会话：UUIDv7 + 256-bit token（只存 SHA-256）、Cookie 属性、40 分钟滑动过期（写阈值）、remember-device ≤30 天且绝不绕过 TOTP
- [x] 会话上限 5 + 淘汰最久未活动（写审计）；设备列表（最近活动/浏览器+OS/IP 截断/当前设备/可改设备名）；单个撤销、全部撤销（含当前）
- [x] 被撤销会话的设备端检测 → 删除本地缓存与包裹密钥并回到认证
- [x] 限流：IP/账号/全局三类桶 + 指数退避 + 上限；无永久锁定
- [x] 审计日志：所需事件 + 敏感字段加密 + IP 截断 + UA 类别 + 30 天 Cron 清理
- [x] CSRF（double-submit + Origin/Referer 严格校验）、严格 Content-Type、body 大小限制、统一错误结构
- [x] 一次性 operation id/nonce 基础设施（用户+会话绑定、短有效期），供 TOTP 变更与恢复操作使用
- [x] 安全测试：爆破/限流、CSRF、会话固定与劫持、越权/IDOR、重放、SQLi

## P3 加密域（已完成 ✅ 2026-09-24）

- [x] 客户端 `crypto/`：信封编解码、AAD 重建、HKDF、KEK/DEK 派生与包裹、随机 IV 生成
- [x] 恢复码独立包裹路径（10 份）与恢复码登录后可恢复 DEK
- [x] 会话建立后的 TOTP Secret 一次性下发与内存持有（不落盘、不导出、不进日志）
- [x] TOTP 换绑：start/verify 流程、旧 secret 仅在新 secret 验证成功后失效、撤销全部会话
- [x] 迁移状态机：可中断续跑、可回滚、禁用编辑、存在未同步改动时拒绝换绑
- [x] 测试：加解密往返、IV 唯一性、AAD 校验失败、key_version 追踪、恢复可还原 DEK、迁移中断注入

## P4 本地层与 PWA（已完成 ✅ 2026-09-24）

- [x] Dexie schema + 版本化迁移（保留旧库直到新 schema 成功后再切换）
- [x] 不可导出设备 CryptoKey 生成与持久化；设备密钥包裹 DEK；KEK 包裹 DEK
- [x] App Lock 40 分钟；关闭页面时清理内存明文与密钥材料
- [x] 缓存策略：存储压力下可淘汰已同步旧数据与已同步附件；**未同步数据永不自动淘汰**
- [x] Service Worker / PWA 骨架 + 应用外壳离线可用；应用版本展示
- [x] Worker 静态资源绑定（`[assets]`）接入，单源同站
- [x] 测试：离线启动、IndexedDB 迁移保数据、缓存淘汰安全性、撤销会话后本地清理

## P5 数据域（已完成 ✅ 2026-09-24 — 服务端 + 客户端数据层 + 搜索 + UI）

- [x] notes：单文件夹归属、当前 revision、创建时间、删除状态、同步版本、加密 Markdown 载荷（标题在正文内）
- [x] revisions：编号从 1 单调递增、保留当前 + 至多 10 历史、超限自动删最旧、历史删除不可逆
- [x] folders：加密名称、父关系、最大深度 10、删除进回收站并保留 ID 与子树关系
- [x] tags：扁平 + 加密名称 + `note_tags` 多对多、每笔记最多 10 个、删除只删关系（「收藏复用标签机制」是客户端约定，随 UI 落地）
- [x] attachments：仅图片 ≤20MB、引用计数、归零后异步幂等删除 R2
- [x] 回收站：**逻辑删除/恢复/永久删除**已交付；「30 天自动清理」的 Cron 扫描仍在 P5 剩余批次
- [x] 搜索：解锁后内存建索引（标题/正文/标签/文件夹/附件信息），精确 + 模糊 + 高亮，**不持久化明文索引**
- [x] 排序（最近修改/创建时间/标题/手动拖拽）、置顶、最近打开、全局搜索快捷键、命令面板

## P6 编辑器与渲染安全（进行中 — 渲染安全已交付，编辑器待续）

- [ ] Milkdown WYSIWYG + CodeMirror 6 源码模式；移动端默认 WYSIWYG
- [ ] Markdown 特性：代码块 + 语法高亮、KaTeX、表格、任务列表、Mermaid、外链、外图、SVG、安全 HTML、iframe/video
- [ ] **未知 Markdown 扩展保留为原始 Markdown**（先写 round-trip 测试）
- [x] DOMPurify HTML profile + CSS `style` 严格过滤；禁 `<script>` 与全部内联事件属性
- [x] SVG 严格净化（script/事件/危险外部引用/foreignObject）
- [x] Mermaid：客户端渲染 → SVG → 净化 → 插入 DOM（`renderMermaidBlocks`）
- [ ] KaTeX：仅安全 HTML 输出、`trust:false`
- [ ] 链接：仅 http/https、新窗口 + `rel="noopener noreferrer"`、纯文本 URL 不自动链接
- [ ] 外图：任意 HTTPS；iframe/video：任意 HTTPS + `sandbox`（**不给 allow-same-origin**）+ CSP 明确覆盖
- [ ] CSP：严格并为上述能力显式开列所需指令，绝不放宽 script
- [ ] 粘贴/拖放：富文本粘贴提示选择并净化、剪贴板图片立即建附件并插入内部 Attachment ID、拖放仅图片、>20MB 拒绝
- [ ] 测试：存储型 XSS、SVG 活动内容、Mermaid SVG 攻击、Sanitizer 绕过、CSS 注入、iframe 隔离

## P7 同步

- [ ] `/api/v1/sync/push` + `/api/v1/sync/pull` + 服务端 cursor
- [ ] `base_revision` 乐观锁校验；不等则建冲突（绝不 last-write-wins）
- [ ] 冲突模型：Base/Local/Remote 三方 + 三栏 diff UI；保留本地 / 保留远端 / 手动合并；Markdown 三方合并辅助且未解决段落保持可见
- [ ] 文件夹移动冲突、标签集合语义、删除-修改必为冲突
- [ ] 离线临时 ID → 服务端最终 ID 映射与本地引用原子重写
- [ ] 队列：每操作可追踪、同笔记串行/异笔记并行、连续编辑可压缩上传但**不丢弃未同步意图**
- [ ] 重试：指数退避、多次失败暂停自动重试 + 保留队列 + 错误态 + `Sync Now`；认证失败触发重新认证；冲突暂停该对象
- [ ] tombstone 保留 30 天
- [ ] 触发时机：停止编辑约 5 秒后、启动、页面恢复、网络恢复；同步状态 UI 七态
- [ ] 测试：并发编辑、删除/修改冲突、重复同步幂等、离线队列持久化、浏览器重启后解锁

## P8 导入导出与更新

- [ ] 全量明文 ZIP 导出（专用结构、无自动备份、导出后清理临时数据、30 天未导出提醒）
- [ ] 独立恢复包（不含明文 TOTP Secret、仅最小受保护密钥/恢复元数据、格式带版本）
- [ ] 导入：先全量校验（归档/记录/引用/附件元数据/加密元数据）再提交，任一失败整体回滚
- [ ] 重复 ID 由用户选择合并/重映射；智能合并而非无条件覆盖
- [ ] SW 更新：安全时自动；存在未同步数据时推迟到同步安全后
- [ ] 测试：导入事务回滚、导出 ZIP 有效性、SW 更新不破坏未同步数据

## P9 安全加固与验收

- [ ] 需求 §31 全部 24 项安全测试逐项落地并全绿
- [ ] 需求 §32 验收清单逐项勾选（Authentication / Encryption / Offline / Sync / Editor / Data lifecycle / Platform）
- [ ] 输出验收对照报告（含未达标项与原因）
- [ ] 部署文档：域名、D1 创建与 id 替换、R2 bucket、secrets、Cron 校验、CSP 生产验证

## 待决问题（需用户拍板，不阻塞当前阶段）

- [ ] UI 语言：英文现状 / 中文 / 双语 i18n
- [ ] 许可证：MIT / AGPL-3.0（需求要求可开源发布）
- [ ] note/folder/tag 的 ID 格式：建议统一 UUIDv7（满足 AAD 字符集）
- [ ] 历史版本保存间隔：建议「活跃编辑每 5 分钟最多一个 + 显式保存一个」，上限 10
- [ ] 限流阈值：建议账号 1s→2s→4s…上限 60s、10 次/小时/账号、30 次/小时/IP + 全局上限
- [ ] 回收站中文件夹名保持全程加密（确认是否符合预期）

## 风险清单

| 风险                                         | 影响           | 对策                                                                                                    |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| Milkdown Markdown round-trip 保真            | 编辑器阶段返工 | Markdown 为唯一真相源 + 未知块降级 raw + 先写 round-trip 属性测试（P6）                                 |
| iframe/外图所需的 CSP 放宽                   | 渲染安全       | 只开 `frame-src`/`img-src`，绝不放宽 script；iframe 强制 sandbox 且不给 allow-same-origin，并用测试固化 |
| 20MB 附件在浏览器内加解密                    | 内存/卡顿      | 单次 AES-GCM 处理并限制并发；必要时后续切分块（不改变信封语义）                                         |
| 迁移（换绑/IndexedDB）中断                   | 数据丢失       | 先写后删、保留旧包裹/旧库直到新路径验证成功、可续跑可回滚                                               |
| 沙箱内 workerd 能否启动                      | P0 验证受阻    | 如实记录环境限制，改用 `wrangler dev` + curl 做最小替代验证，绝不伪造通过                               |
| 需求 §3.7「重加密所有数据」与 ADR-004 的取舍 | 需求解释偏差   | 已由用户批准 ADR-004；决策与理由记录在 `docs/decisions.md`                                              |
