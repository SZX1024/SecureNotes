# Architecture

## Trust boundary

```text
                         TRUST BOUNDARY
                               |
                               v
    +--------------------------------------------------+
    |                    Browser                       |
    |                                                  |
    |  Markdown plaintext      DEK (memory only)       |
    |  Decrypted notes         Search index (memory)   |
    |  WYSIWYG editor          Sync queue (IndexedDB)  |
    +--------------------------+-----------------------+
                               |
                        encrypted transport (HTTPS, same origin)
                               |
                               v
    +--------------------------------------------------+
    |               Cloudflare Worker                  |
    |                                                  |
    |  Authentication   Sessions   Sync protocol       |
    |  Authorization    Rate limit  Audit log          |
    |  Envelope validation and opaque storage          |
    +--------------------------+-----------------------+
                               |
                   ciphertext / structural metadata
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
        +------------------+        +------------------+
        |       D1         |        |       R2         |
        | ciphertext       |        | encrypted image  |
        | metadata         |        | objects          |
        | sessions, audit  |        |                  |
        +------------------+        +------------------+
```

The browser is the only place that holds keys or plaintext. The worker validates
envelopes and enforces ownership, sessions and sync semantics, but cannot read note
content. Requirements §34 makes this boundary a core architectural requirement.

## Request flow

1. `index.html` / assets are served by the worker from the static-assets binding
   (wired in P4), so the API and the shell share one origin. CORS is never enabled.
2. The client calls `/api/v1/*` with the `session` cookie and, for state-changing
   requests, a double-submit CSRF header.
3. Middleware runs in a fixed order: correlation id → baseline security headers →
   (per-endpoint) strict `Content-Type`, body-size, schema, CSRF/origin, session and
   authorisation checks.
4. Domain handlers touch D1 through parameterised queries only, and R2 for opaque
   attachment objects. Multi-record logical operations use D1 transactions.
5. Errors leave through one funnel that maps a closed set of codes to generic public
   messages; diagnostics exist only when `ENVIRONMENT === "development"`.

## Module boundaries

Requirements §28 suggests the module split; the implementation follows it closely.

```text
apps/worker/src/
  api/v1/         endpoint definitions and per-route validation
  middleware/     request id, security headers, csrf, origin, rate limit, body limits
  domain/         auth, session, totp, recovery, audit, notes, folders, tags,
                  attachments, sync, revisions, recycle-bin
  db/             parameterised queries, transactions, migrations
  lib/            uuidv7, sha256, base32/HMAC-SHA1 (TOTP), ip truncation, UA classes
  app.ts          composition root
  index.ts        worker entry (fetch + scheduled)

apps/web/src/
  crypto/         envelope, AAD, HKDF, KEK/DEK, recovery wrapping, migration machine
  storage/        Dexie schema + migrations, device key, sync queue, cache eviction
  sync/           cursor, push/pull, conflict detection, retry/backoff
  editor/         Milkdown WYSIWYG, CodeMirror source mode, paste/drop handling
  markdown/       markdown pipeline, Shiki, KaTeX, Mermaid
  sanitizer/      DOMPurify profiles (HTML, SVG, CSS filtering)
  search/         in-memory MiniSearch index and highlighting
  ui/             3-pane desktop layout, dedicated mobile layout, command palette,
                  shortcuts, conflict diff view, settings
  api/            same-origin fetch wrapper with CSRF and the shared error contract
  pwa/            service worker registration and update gating

packages/shared/  types, error contract, crypto format constants and AAD builder
```

## Local development topology

```text
browser :5173  -->  Vite dev server  --(/api)-->  wrangler dev :8787
                                                    |
                                                    +-- local D1  (.wrangler/state)
                                                    +-- local R2  (.wrangler/state)
```

Both origins are same-site during development (`localhost`), which keeps cookie and
CSRF behaviour realistic. `changeOrigin` stays `false` so the worker sees the Vite
origin, exactly as it will see the real domain in production.

## Deployment

Cloudflare DNS/HTTPS → Worker (assets + `/api/v1/*`) → D1 + R2, plus the hourly cron
trigger used for retention sweeps. Deploying needs a real domain, a created D1 database
(replace the placeholder `database_id`), an R2 bucket and the worker secrets introduced
in P2/P3. No Cloudflare Access, VPS, self-hosted backend or native app is used
(requirements §2).
