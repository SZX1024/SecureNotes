# SecureNotes

Personal, single-user, local-first memo PWA with client-side encryption, running on
Cloudflare Workers + D1 + R2.

The browser is the only place plaintext exists. The worker, D1 and R2 only ever see
ciphertext, structural metadata and security state.

> **Status:** P0 — scaffolding. The worker skeleton, the client shell, the quality
> gate and the shared cryptographic format are in place. Nothing is deployable as a
> usable notes app yet; see the phase table below.
>
> The frozen product requirements live in [`requirements.md`](./requirements.md). They
> are the authority for every design decision in this repository.

## Stack

| Area         | Choice                                                               |
| ------------ | -------------------------------------------------------------------- |
| Backend      | Cloudflare Workers, Hono, D1, R2                                     |
| Frontend     | React 19, Vite, Dexie (IndexedDB), Service Worker/PWA                |
| Editor       | Milkdown (WYSIWYG) + CodeMirror 6 (Markdown source)                  |
| Crypto       | Web Crypto: AES-256-GCM, HKDF-SHA-256                                |
| Sanitisation | DOMPurify (HTML + SVG profiles), KaTeX, Mermaid, Shiki               |
| Search       | MiniSearch, in-memory only                                           |
| Validation   | Zod, shared between worker and client                                |
| Tests        | Vitest (+ `@cloudflare/vitest-pool-workers`), Playwright, fast-check |

## Repository layout

```text
apps/worker/        Cloudflare Worker: API, auth, sync protocol, audit
apps/web/           Browser client: crypto, storage, sync, editor, UI, PWA
packages/shared/    Types, error contract, cryptographic format constants
docs/               Architecture, crypto format, API contract, threat model, ADRs
scripts/            Repository maintenance scripts
```

## Quick start

```bash
pnpm install

# terminal 1 — worker on http://127.0.0.1:8787 (local D1 + R2 via Miniflare)
pnpm dev:worker

# terminal 2 — client on http://localhost:5173, proxies /api to the worker
pnpm dev:web
```

No Cloudflare account is needed for development: `wrangler dev` runs D1 and R2 locally
under `.wrangler/state` (git-ignored). Deploying requires a real account, a domain and
replacing the placeholder `database_id` in `apps/worker/wrangler.toml`.

### Restricted environments

`wrangler` keeps a global registry under `$HOME/.config/.wrangler` and aborts with
`EROFS` when `$HOME` is read-only. Point `HOME` at a throwaway directory inside the
repository instead (git-ignored):

```bash
mkdir -p .sandbox-home
HOME="$PWD/.sandbox-home" pnpm dev:worker
```

Two related notes for such environments:

- The pnpm store must also live inside the repository — add `--store-dir .pnpm-store`
  to every `pnpm` command when the global store is not writable.
- `vite` binds the `localhost` name only, which resolves to `::1` on some hosts. Use
  `http://localhost:5173`, not `http://127.0.0.1:5173`.

## Quality gate

```bash
pnpm check        # version consistency + format + lint + typecheck + tests
pnpm test         # unit and integration tests only
pnpm format       # apply Prettier
```

CI runs the same command on every push and pull request (`.github/workflows/ci.yml`).

## Phase plan

| Phase | Scope                                                                         | State |
| ----- | ----------------------------------------------------------------------------- | ----- |
| P0    | Scaffolding: workspace, worker skeleton, client shell, tests, documentation   | done  |
| P1    | D1 schema and migrations for all core tables                                  | done  |
| P2    | Auth: enrolment, TOTP login, recovery codes, sessions, rate limiting, audit   | next  |
| P3    | Crypto: key hierarchy, envelope, recovery wrapping, TOTP rebind migration     |       |
| P4    | Local layer: IndexedDB migrations, device key, App Lock, PWA shell            |       |
| P5    | Data: notes, folders, tags, revisions, recycle bin, attachments, search       |       |
| P6    | Editor: WYSIWYG, source mode, sanitisation, CSP, Mermaid, KaTeX, SVG, iframes |       |
| P7    | Sync: cursor, optimistic locking, conflict merge UI, retry, tombstones        |       |
| P8    | Import/export, recovery package, service-worker update gating                 |       |
| P9    | Mandatory security test suite and acceptance-criteria sign-off                |       |

## Documentation

- [Architecture](./docs/architecture.md) — trust boundary, request flow, module map
- [Database schema](./docs/schema.md) — tables, conventions, migrations, deploy prerequisites
- [Cryptographic format](./docs/crypto-format.md) — envelope, AAD, key hierarchy, migration
- [API contract](./docs/api-contract.md) — envelope, error codes, endpoints
- [Threat model](./docs/threat-model.md) — what is defended, what is explicitly accepted
- [Decision log](./docs/decisions.md) — approved decisions and open questions
- [Security policy](./SECURITY.md) — reporting and non-negotiable invariants
