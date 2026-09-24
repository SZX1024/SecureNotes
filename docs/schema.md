# Database schema

D1 (SQLite) holds only ciphertext plus the structural metadata that requirements §24
allows the server to see. The authoritative DDL is
[`apps/worker/migrations/0001_init.sql`](../apps/worker/migrations/0001_init.sql); this
document explains the conventions and records the interpretations that the DDL encodes.

## Conventions

| Concern              | Convention                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ids                  | `TEXT`, UUIDv7. Satisfies the frozen AAD id charset `[A-Za-z0-9_-]{1,64}` (§6), so any id can be bound into a ciphertext.                                                                                                             |
| Timestamps           | `INTEGER` epoch milliseconds, always supplied by the application. No `DEFAULT`: SQLite's `CURRENT_TIMESTAMP` is text and would mix representations.                                                                                   |
| Booleans             | `INTEGER` restricted to 0/1 by a `CHECK`.                                                                                                                                                                                             |
| Encrypted object     | Explicit `crypto_version`, `key_version`, `iv`, `ciphertext` columns rather than a JSON blob, so the frozen envelope shape is enforced by the database. `iv`/`ciphertext` are base64 and `ciphertext` includes the 16-byte GCM tag.   |
| Verification digests | Lowercase hex `TEXT` (64 chars), `CHECK (length(...) = 64)`. These hash high-entropy random secrets (session tokens, recovery codes), not user-chosen passwords, so no slow KDF and no per-row salt are needed for the digest itself. |
| Deletion             | Soft delete (`deleted_at`) inside the recycle bin; hard deletes only in the explicit purge path.                                                                                                                                      |

`STRICT` tables are deliberately **not** used. The sandbox has no Cloudflare account,
so runtime-specific DDL could not be verified against real D1; portable `CHECK`
constraints cover the same integrity cases and are verified locally.

No triggers are used either: the SQL splitter shared by the test pool and the
wrangler/D1 tooling is statement based, and cross-table invariants are enforced in
application transactions and asserted by tests instead.

## Tables

Fourteen tables: the thirteen named in requirements §9 plus `rate_limits` (§3).

| Table              | Purpose and notable constraints                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`            | The single account. `username` is `UNIQUE` and immutable (it is a KDF input, so it is stored byte-exact). Holds the random KDF salt, the KEK-wrapped DEK, and the progressive-backoff counters (never a permanent lockout, §3).                                                                                                                                                |
| `totp_config`      | One row per account. The secret is stored **recoverably** (encrypted under a Worker-side key), never hashed, because it must be re-delivered after authentication to derive the KEK — the accepted risk in §25. `last_used_step` rejects a code from an already-consumed time-step (RFC 6238 §5.2).                                                                            |
| `recovery_codes`   | Ten single-use codes per account for the initial schema. Stores only a verification digest, a per-code HKDF salt and the code's own opaque wrapping of the DEK. `code_hash` is `UNIQUE`.                                                                                                                                                                                       |
| `sessions`         | UUIDv7 id, `SHA-256(token)` only, `UNIQUE`. Sliding 40-minute expiry, remember-device ≤ 30 days. The 5-session cap and least-recently-active eviction (ADR-005) are application invariants and cannot be a `CHECK`. Only a truncated IP and a coarse browser/OS category are stored (§4).                                                                                      |
| `folders`          | Encrypted names; `parent_id` and `depth` are plaintext because §24 permits structural metadata. `depth` is 1-based and `CHECK`ed to 1–10, so the documented maximum depth is enforced by the database.                                                                                                                                                                         |
| `tags`             | Flat, encrypted names. Hard-deleted: deleting a tag removes relationships only.                                                                                                                                                                                                                                                                                                |
| `notes`            | Encrypted Markdown (the title lives inside it — there is deliberately no plaintext title column). `revision` is the optimistic lock. `pinned` and `sort_order` back the §10 ordering features.                                                                                                                                                                                 |
| `note_revisions`   | Full history: **including** the current revision, because §9 says to keep "current revision plus at most 10 historical versions". `UNIQUE (note_id, revision)` makes revision numbering monotonic and replay of the same revision idempotent. `parent_revision_id` is `ON DELETE SET NULL` so pruning the oldest version is never blocked by its children.                     |
| `note_tags`        | Many-to-many join. Cascades from both sides: deleting a note or a tag removes relationships only. The limit of 10 tags per note is an application invariant.                                                                                                                                                                                                                   |
| `attachments`      | Images only, ≤ 20 MB, stored in R2 under a random key; original filename encrypted. `content_type` is `CHECK`ed to `image/%` and `size_bytes` to 1…20971520 so both limits are database-enforced. `ref_count` is maintained transactionally; `deletion_enqueued_at` drives asynchronous R2 deletion once it reaches zero.                                                      |
| `note_attachments` | Join with `ref_count` bookkeeping. Both foreign keys are `RESTRICT`, so an attachment or note cannot be deleted without the application explicitly removing links and adjusting the count.                                                                                                                                                                                     |
| `sync_changes`     | Incremental sync feed and tombstones (§16). `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`: a cursor value is never reused, so a long-offline client cannot silently skip a change. Deletes are rows with `change_type = 'delete'`, retained 30 days.                                                                                                                            |
| `audit_logs`       | §5 events. `category` uses a closed vocabulary; `event_type` is free text so new event names need no migration. Sensitive detail goes into an encrypted envelope that must be wholly present or wholly absent (`CHECK ((detail_iv IS NULL) = (detail_ciphertext IS NULL))`). `session_id` intentionally has **no** foreign key so the entry outlives the session it describes. |
| `rate_limits`      | Fixed windows keyed by `(scope, bucket, window_start)` for the IP / account / endpoint / global limits of §3.                                                                                                                                                                                                                                                                  |

## Recorded interpretations

These are the places where the frozen requirements left room, and the reading the
schema commits to. Each is cheap to revisit, but the reasoning is recorded so the
choice is not silently reversed later.

1. **`notes.folder_id` is nullable.** §10 says a note "has exactly one folder". `NULL`
   means root / unfiled. This keeps the semantics "at most one folder, never several"
   while avoiding two real problems: a bootstrap chicken-and-egg (creating a folder
   before any note can exist) and restore-after-purge, where the original folder may
   already be gone and the note must land somewhere. The application presents root as
   a normal location.
2. **The current revision is stored twice** — in `notes` for fast reads and as the
   newest `note_revisions` row for a complete history. §9 asks for both. The invariant
   `notes.revision = max(note_revisions.revision)` must be written in one transaction
   and is asserted by the schema tests.
3. **`RESTRICT` instead of `CASCADE` on destructive paths** (`folders.parent_id`,
   `notes.folder_id`, both `note_attachments` keys). Cascading silently would let one
   wrong `DELETE` destroy a subtree or desynchronise `ref_count`. `RESTRICT` fails
   loudly and forces the purge path to be explicit and ordered. Deletion of an
   _account_ still cascades fully, which is verified by test.
4. **The optimistic lock needs no extra index.** §27 requires the atomic condition
   `WHERE id = ? AND revision = ?`; `id` is the primary key, so the statement is
   already a single-row lookup. A separate `(id, revision)` index would only add write
   cost.
5. **No id-charset `CHECK`.** Id validity is enforced at the serialisation boundary by
   `isValidObjectId` in `packages/shared` (already covered by tests) instead of by
   `GLOB` expressions repeated across nine tables.
6. **`audit_logs.event_type` is free text while `category` is closed.** The event
   vocabulary grows in every later phase; the category is stable and drives filtering.
7. **No `STRICT` tables**, as explained above.

## Migrations

- Files live in `apps/worker/migrations/`, named `NNNN_name.sql`; the tooling orders
  them by the leading integer.
- Apply locally: `wrangler d1 migrations apply securenotes-db --local` (from
  `apps/worker`). A Cloudflare account is not needed; local state lives in
  `apps/worker/.wrangler/state`.
- Apply remotely: add `--remote` (requires a real `database_id`, see below).
- Tests consume the same files: `vitest.config.ts` reads them with
  `readD1Migrations` into the `TEST_MIGRATIONS` binding and
  `test/apply-migrations.ts` applies them per test file. The schema under test is
  therefore always the schema that ships.
- Never edit a migration that has been applied anywhere. Add a new one.
- Changing the schema means the generated types must be refreshed:
  `pnpm --filter @securenotes/worker cf-typegen`.

## Before the first deploy

`apps/worker/wrangler.toml` ships a placeholder D1 id. Replace it once the real
database exists, otherwise `wrangler deploy` targets nothing:

```bash
cd apps/worker
wrangler d1 create securenotes-db          # prints the real database_id
# paste the printed id into wrangler.toml, replacing
#   00000000-0000-0000-0000-000000000000
wrangler d1 migrations apply securenotes-db --remote
```

The R2 bucket (`securenotes-attachments`) must exist as well.

## Deferred to later phases

Adding these must be done as new migrations, not by editing `0001_init.sql`:

- **P3** — the pending-rebind columns for the resumable TOTP rebind state machine, and
  the table of one-time operation ids/nonces required by §26.
- **P7** — persistent conflict state (base / local / remote) for the three-way merge.
- **P5/P7** — D1 row-size limits bound the largest note that can be stored inline. If a
  note payload can exceed a D1 row, large payloads must move to R2 in a later phase.
