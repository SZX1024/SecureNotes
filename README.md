# SecureNotes

A personal, single-user, local-first Markdown notebook with client-side encryption, running on Cloudflare Workers, D1
and R2.

The browser is the only place plaintext exists. The worker, the database and the object store only ever see ciphertext,
structural metadata and security state. There is no account recovery that involves anyone but you: the key is derived
from your authenticator secret, and the recovery package is a file you keep.

> **Status:** complete. Every phase in the plan is done, the acceptance criteria in `requirements.md` §31 and §32 are
> all covered by tests, and the deployed artefact is a PWA you can install and use offline.
>
> | Gate              | Result                                                                             |
> | ----------------- | ---------------------------------------------------------------------------------- |
> | `pnpm check`      | 638 tests, lint, types, formatting, version consistency, 76/76 acceptance criteria |
> | `pnpm e2e`        | 122 checks in a real browser                                                       |
> | `pnpm acceptance` | regenerates [`ACCEPTANCE.md`](./ACCEPTANCE.md) from the repository                 |
>
> The frozen product requirements live in [`requirements.md`](./requirements.md); they are the authority for every
> design decision here. [`HANDOFF.md`](./HANDOFF.md) is the working record — including the defects found by measuring
> rather than by looking, and the things deliberately not done.

## What it does

**Writing.** Markdown notes in a visual editor or in source mode, with tabs for the notes you have open, a note list
that shows each note's opening words, folders and tags as chips, tables, task lists, code with syntax highlighting,
LaTeX, and Mermaid diagrams. Attachments — any file, up to 60 MB — are encrypted on the device before they leave it.

**A temporary drop.** An attachment can be kept for a week or a month instead of forever, chosen next to the button that
adds it, and the hourly sweep removes it: the object, the row and the references, with every device told. A total of 5 GB
per account is enforced before an upload is stored, and the settings dialog says how much of it is in use. Nothing is
shared publicly: the application stays single-user, and the file type is the only thing about a file's content the
server learns.

**Not losing anything.** Everything is encrypted locally first and synced afterwards, so a note can be written, edited
and illustrated with no network at all; the queue is durable and survives a restart. Concurrent edits become visible
conflicts with a three-way merge rather than a silent overwrite. Deleted notes go to a recycle bin for 30 days, and a
deletion can be undone from the message that reports it.

**Getting the data out.** A plaintext export archive (notes, folders, tags, attachments and their names, with a README
inside the ZIP), an import that merges or remaps without duplicating, and a separate recovery package holding the key
material needed to get back into the account. The interface reminds you when a backup is overdue.

**Staying yours.** Username and TOTP, single-use recovery codes, sessions that can be revoked individually or all at
once, five concurrent sessions at most, progressive backoff on failed attempts, and 30 days of audit events. A session
that expires while you are writing is renewed in place, with a code, rather than by sending you to another screen.

## Stack

| Area         | Choice                                                            |
| ------------ | ----------------------------------------------------------------- |
| Backend      | Cloudflare Workers, Hono, D1, R2, cron triggers                   |
| Frontend     | React 19, Vite, Dexie (IndexedDB), service worker                 |
| Editor       | Milkdown (visual) + CodeMirror 6 (Markdown source)                |
| Cryptography | Web Crypto: AES-256-GCM, HKDF-SHA-256, per-object AAD             |
| Rendering    | DOMPurify (HTML and SVG profiles), KaTeX, Mermaid, highlight.js   |
| Search       | MiniSearch, in memory only                                        |
| Validation   | Zod, shared between worker and client                             |
| Tests        | Vitest, `@cloudflare/vitest-pool-workers`, Playwright, fast-check |

KaTeX is pinned to a single version through a pnpm override. Two copies were installed once — the application's and the
one `rehype-katex` brought — and they name their CSS classes differently, so the preview's superscripts silently kept the
wrong size while the editor's were correct.

## Repository layout

```text
apps/worker/        Cloudflare Worker: API, authentication, sync protocol, audit, cron sweeps
apps/web/           Browser client: crypto, storage, sync, editor, interface, PWA
packages/shared/    Types, error contract, cryptographic format constants, policy numbers
docs/               Architecture, crypto format, API contract, threat model, decisions
scripts/            Quality gates and browser tooling (see below)
```

## Quick start

```bash
pnpm install

# terminal 1 — worker on http://127.0.0.1:8787, with local D1 and R2 through Miniflare
pnpm dev:worker

# terminal 2 — client on http://localhost:5173, proxying /api to the worker
pnpm dev:web
```

Open `http://localhost:5173` and follow the enrolment screen: it shows an `otpauth://` URI to scan and ten recovery
codes to keep. No Cloudflare account is needed for development — `wrangler dev` runs D1 and R2 locally under
`.wrangler/state`, which is git-ignored.

### Worker secrets

Two 256-bit secrets are required. Locally they come from `.dev.vars` (git-ignored; the format is in
`.dev.vars.example`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # run twice
cp apps/worker/.dev.vars.example apps/worker/.dev.vars                        # paste the two values
```

| Secret             | Purpose                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `SECRET_WRAP_KEY`  | Root for the per-purpose keys that protect the TOTP secret at rest |
| `CSRF_SIGNING_KEY` | Signs the double-submit CSRF token                                 |

### Restricted environments

`wrangler` keeps a registry under `$HOME/.config/.wrangler` and aborts with `EROFS` when `$HOME` is read-only. Point
`HOME` at a throwaway directory inside the repository instead (git-ignored):

```bash
mkdir -p .sandbox-home
HOME="$PWD/.sandbox-home" pnpm dev:worker
```

Two related notes:

- The pnpm store must also live inside the repository — add `--store-dir .pnpm-store` to every `pnpm` command when the
  global store is not writable.
- `vite` binds the `localhost` name only, which resolves to `::1` on some hosts. Use `http://localhost:5173`, not
  `http://127.0.0.1:5173`.

## Quality gate

```bash
pnpm check        # version consistency, formatting, lint, types, tests, acceptance criteria
pnpm e2e          # 122 checks in a real browser, with its own ports and its own database
pnpm acceptance   # regenerate ACCEPTANCE.md; fails if any criterion loses its evidence
pnpm ui-shots     # capture the interface: light and dark, wide and narrow, into .sandbox-home/ui
```

`pnpm check` is the gate. It includes `pnpm acceptance`, which regenerates the acceptance report from the repository and
fails when a criterion has no test behind it — so the report cannot drift away from the code.

`pnpm e2e` and `pnpm ui-shots` need nothing prepared: each starts a worker and a dev server on ports of its own, against
its own persistence directory, enrols an account through the interface, and tears everything down. They never touch a
development server you have running.

The browser tooling is in `scripts/`: `e2e.mjs` runs the suite, `browser.spec.mjs` holds the checks, `ui-shots.mjs`
captures screenshots, and `lib/dev-stack.mjs` starts the stack both of them use.

## Deploying to Cloudflare

The worker, the database, the bucket and the client are one deployment: the client is served as static assets from the
same origin as the API, which is what keeps the application same-origin only.

**Prerequisites.** A Cloudflare account, `wrangler` authenticated (`wrangler login`), and a built client.

```bash
# 1. Create the database and the bucket once, then put the id into apps/worker/wrangler.toml.
pnpm --filter @securenotes/worker exec wrangler d1 create securenotes-db
pnpm --filter @securenotes/worker exec wrangler r2 bucket create securenotes-attachments
#    ^ prints a database_id. Replace the placeholder in apps/worker/wrangler.toml with it.

# 2. The two secrets. The name is the argument; the value is read from the terminal, and piping it in avoids the
#    interactive prompt entirely. These must be different values from your development ones.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
  | pnpm --filter @securenotes/worker exec wrangler secret put SECRET_WRAP_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
  | pnpm --filter @securenotes/worker exec wrangler secret put CSRF_SIGNING_KEY

# 3. The deployment: build the client, apply migrations, deploy the production environment.
#
#    The values a deployment needs live in `[env.production]` in apps/worker/wrangler.toml, so there is nothing to
#    remember on the command line. Edit the deployed origin there — it is the only one allowed to call the API, and a
#    wrong value makes the deployed app refuse its own requests.
pnpm deploy:prod
```

`wrangler.toml` holds two environments: the top-level values are the **development** ones that `wrangler dev` uses, and
`[env.production]` holds the deployed ones. `pnpm deploy:prod` is `wrangler deploy --env production` with the build and
the migrations in front of it. Two things about that split are worth knowing:

- **A bare `wrangler deploy` deploys the development configuration.** It is a valid command that publishes localhost as
  the allowed origin and turns diagnostics back on. `pnpm deploy:prod` exists so that the deployed path is the easy one.
- **The bindings are written twice.** Wrangler does not inherit `d1_databases` or `r2_buckets` into an environment, so
  the database id and the bucket name appear in both sections and the two must agree. `wrangler deploy --env production
--dry-run` warns when they do not — run it after editing either one.

`wrangler deploy` prints the deployed URL. Open it, enrol, and install it: the manifest and the service worker make it
a PWA that works offline.

Two things worth knowing before the first deploy:

- **The asset directory must exist.** `pnpm build` must run before `wrangler deploy`; the worker configuration serves
  `apps/web/dist`, and an empty directory deploys a worker with no client.
- **The origin must be right.** `ALLOWED_ORIGINS` is a security control, not a convenience: it is what stops another
  site from driving the API with your cookies. Development values in production mean a deployed app that rejects itself,
  and a secret entered under the wrong name means a worker that reports `SECRET_WRAP_KEY is not configured` on every
  request — the name is the argument to `wrangler secret put`, and the value is what it then asks for.

To check the configuration without deploying:

```bash
pnpm --filter @securenotes/worker exec wrangler deploy --dry-run
```

## Deploying from GitHub

Two ways to bind the repository to Cloudflare. The first is scripted here and needs no dashboard work.

**GitHub Actions (this repository ships the workflow).** `.github/workflows/deploy.yml` runs on every push to `main`:
it runs the full gate and then `pnpm deploy:prod`, which builds the client, applies migrations and deploys the
production environment. Add two repository secrets:

| Kind   | Name                    | Value                                                               |
| ------ | ----------------------- | ------------------------------------------------------------------- |
| Secret | `CLOUDFLARE_API_TOKEN`  | API token from the Cloudflare dashboard ("Edit Cloudflare Workers") |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Your account id                                                     |

Without the two secrets the workflow still runs the gate and says so, rather than failing: a fork or a fresh clone
stays green.

**Cloudflare's own Git integration.** In the dashboard, _Workers & Pages → Create → Connect to Git_, choose this
repository, set the build command to `pnpm build` and the deploy command to
`pnpm --filter @securenotes/worker exec wrangler deploy`, and add `SECRET_WRAP_KEY` and `CSRF_SIGNING_KEY` as encrypted
build variables. This gives preview deployments per branch; it also means Cloudflare holds a token with access to your
repository, which is the trade to weigh against the two secrets above.

## Attachment limits

| Limit       | Value                   | Why                                                                                                        |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Per file    | 60 MB                   | What a browser can encrypt on the device without trouble, and below the request body limit of the platform |
| Per account | 5 GB                    | A per-file ceiling does not bound a total, and a total means nobody watches a bill                         |
| Retention   | Forever, or 7 / 30 days | Chosen when the file is attached; the hourly sweep removes what has expired                                |
| Types       | Any                     | The object store holds ciphertext and never looks inside it                                                |
| Sharing     | None                    | Single-user: there is no unauthenticated way to fetch a file                                               |

Beyond the object store's free allowance the cost is $0.015 per GB-month, and egress is free. The three refusals an
upload can meet are a file over 60 MB, an account over 5 GB, and a file whose expiry is in the past.

## Known limits

Written down rather than left to be discovered.

- **The mobile layout has not been seen by a person.** It is implemented, and a browser check asserts that the activity
  rail is reachable and the panel opens over the note list, but no human has used it on a phone.
- **A note row has no delete control.** Right-click, the command palette and the keyboard all delete, with an undo.
  A row's own button was written and withdrawn: adding any control to a note row makes Playwright unable to click the
  list at all — it reports the row visible, enabled and stable, and then never finishes scrolling it into view. Three
  entries that work beat four with a list that cannot be clicked. The same anomaly affects the editor's own buttons, and
  the browser scripts carry an evidenced fallback for it.
- **An embedded YouTube player degrades inside the strict iframe sandbox.** The isolation is deliberate; serving those
  embeds from a separate origin is the fix, and it is not done.
- **A temporary attachment's expiry is only visible when it is chosen.** The attachment list is derived from the note's
  Markdown, which carries an identifier and a filename and no expiry, so a file that will disappear in three days does
  not say so on the row. It does say so when it is attached, and the sweep does remove it.
- **How the editor feels to write in is not something a test settles.** The document round trip, in-place formulas and
  diagrams, and images are covered.

## Documentation

- [Acceptance report](./ACCEPTANCE.md) — every criterion from §31 and §32, with the test behind it
- [Working record](./HANDOFF.md) — decisions, defects, and what each phase verified
- [Plan](./PLAN.md) — the phase table and its state
- [Architecture](./docs/architecture.md) — trust boundary, request flow, module map
- [Database schema](./docs/schema.md) — tables, conventions, migrations, deploy prerequisites
- [Local layer](./docs/local-layer.md) — IndexedDB schema, migration, device key, App Lock, cache policy
- [Cryptographic format](./docs/crypto-format.md) — envelope, AAD, key hierarchy, migration
- [API contract](./docs/api-contract.md) — envelope, error codes, endpoints
- [Threat model](./docs/threat-model.md) — what is defended, what is explicitly accepted
- [Decision log](./docs/decisions.md) — approved decisions and open questions
- [Security policy](./SECURITY.md) — reporting and non-negotiable invariants
- [Requirements](./requirements.md) — frozen; the authority for everything above
