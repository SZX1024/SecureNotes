# Decision log

Approved decisions and open questions. Requirements §33.1 forbids silently changing frozen
product requirements: anything that interprets or extends them is recorded here, with the
alternative that was rejected and why.

## ADR-001 — Technology stack (approved)

**Decision.** pnpm workspace monorepo: Hono + TypeScript on Cloudflare Workers
(D1 + R2 bindings), React 19 + Vite client, Dexie for IndexedDB, Milkdown v7
(ProseMirror + remark) as the WYSIWYG editor with CodeMirror 6 for Markdown source mode,
MiniSearch for the in-memory index, DOMPurify for HTML/SVG sanitisation, KaTeX and Mermaid
for rendering, Shiki for code highlighting, fflate for ZIP export, Zod for schemas,
Vitest (+ `@cloudflare/vitest-pool-workers`) and Playwright for tests.

**Why.** Requirements §28 leaves framework choice open but demands Markdown-as-canonical
storage with round-trip preservation of unknown extensions, strict sanitisation and full
offline operation. Milkdown is Markdown-native (round-trip is its data model rather than a
bolt-on), which is the single highest-risk requirement in the editor.

**Rejected.** TipTap + `tiptap-markdown` — larger extension ecosystem, but Markdown
round-trip fidelity needs substantially more custom work and unknown-extension
preservation is harder to guarantee.

**Risk and mitigation.** ProseMirror round-trip fidelity is the top implementation risk.
Mitigation: Markdown stays the single source of truth in storage, unknown blocks degrade to
a raw node, and round-trip property tests (parse → serialise → parse must be stable) are
written before the editor features.

## ADR-002 — TOTP secret delivery to the client (approved)

**Decision.** After a successful TOTP authentication the worker returns the account's TOTP
secret to the client over HTTPS. The client keeps it in memory only for KEK derivation:
never persisted, never logged, never rendered, never exportable through the UI.

**Why.** Requirements §6 and §35 freeze the KEK input as
`username + TOTP secret + fixed application context + account KDF salt`. The client cannot
derive the KEK without the secret, so delivery after authentication is the only reading
consistent with the frozen hierarchy. Requirements §25 explicitly accepts the consequence
that a full Worker compromise plus secrets makes historical data decryptable.

**Rejected.** A separate KDF secret distinct from the TOTP secret — stronger (the worker
would never hold a KEK input), but it changes a frozen requirement and would require an
explicit requirements amendment.

## ADR-003 — Offline unlock and App Lock (approved)

**Decision.** IndexedDB stores (a) the KEK-wrapped DEK and (b) a DEK wrapped by a
non-extractable device `CryptoKey` generated locally. App Lock is 40 minutes; unlocking a
locked client uses the device key, so full offline editing works without the server. TOTP
remains mandatory for authentication and synchronisation.

**Why.** Requirements §7 requires full offline operation while forbidding any plaintext DEK
persistence; a device-bound non-extractable key satisfies both. No requirement makes TOTP
a per-unlock factor, and requiring it offline would force the TOTP secret onto disk, which
is worse.

**Rejected.** Requiring a TOTP code for every unlock — needs the secret persisted locally
(weakens the secret) or forces the user online (breaks offline-first).
**Option retained for later.** WebAuthn/Passkey as an additional local factor (§7 optional).

## ADR-004 — TOTP rebind migration semantics (approved)

**Decision.** A TOTP rebind re-wraps the DEK (new KEK) and all 10 recovery wrappings and
bumps `key_version`. Note and attachment ciphertext is **not** re-encrypted in bulk.

**Why.** The DEK is what protects data; the KEK only protects the DEK. Re-wrapping achieves
the same security result with no long interruption window, and rollback is trivial (keep the
old wrapping until the new one is verified). Requirements §3.7 says "re-encrypt/migrate all
data using the new key hierarchy", and §3 also demands resumability, rollback and that data
preservation outranks migration speed — re-wrapping is the reading that satisfies all of it.

**Rejected.** Literal full re-encryption of every object under a new DEK — slow, large
interruption window, complex rollback, and no additional security benefit.

## ADR-005 — Sixth session policy (approved)

**Decision.** When a sixth session is created, the least-recently-active session is revoked
and the event is written to the audit log.

**Why.** Requirements §4 caps sessions at 5 and requires individual and bulk revocation. It
does not say a login must fail. Eviction keeps the user from locking themselves out while
remaining auditable.

**Rejected.** Rejecting the new login and asking the user to revoke a session first.

## ADR-006 — Phase delivery cadence (approved)

**Decision.** Work proceeds phase by phase (P0…P9 per requirements §30). Each phase ends with
a summary, test results, an acceptance-criteria cross-check and one commit, then stops for
review before the next phase begins.

**Why.** The specification is large and security-critical; review gates at phase boundaries
catch direction errors while they are still cheap to fix.

## Open questions

Tracked here until decided; none of them block P0.

1. **UI language.** Requirements are written in English; the repository documentation is
   English. Should the application UI ship in Chinese, English, both (i18n), or
   user-selectable? P0 uses English strings with no i18n framework.
2. **Licence.** The repository currently declares no licence. Requirements §1 asks for
   open-source publication compatibility; a licence (for example MIT or AGPL-3.0) should be
   chosen deliberately before publishing.
3. **Note/folder/tag identifier format.** Requirements fix UUIDv7 for sessions and random
   ids for R2 keys, but not for notes. Proposal: UUIDv7 everywhere for time-sortable,
   collision-free ids that satisfy the 64-character AAD charset.
4. **History-save interval.** Requirements §18 leaves the interval to implementation.
   Proposal: at most one historical revision per 5 minutes of active editing, plus one on
   explicit save, capped at 10 (restoring history creates a new current revision).
5. **Rate-limit thresholds.** **Decided in P2** (the proposal was accepted): per-account
   failures back off 1s→2s→4s… capped at 60s, 10 attempts/hour/account, 30/hour/IP and a
   300/hour ceiling per endpoint bucket. The values live in
   `packages/shared/src/policy.ts` so the client can show the same cooldown the server
   enforces. There is never a permanent lockout.
6. **Deleted-folder name disclosure.** Recycle bin keeps ids and structure for 30 days;
   names remain encrypted throughout, including in the bin. Confirm this is the intent.

## P2 decisions (authentication)

- **Session expiry model.** §4 states exactly two rules — a 40-minute sliding inactivity
  window and a 30-day absolute cap for remember-device — so those are the only two
  enforced. `expires_at` stores the sliding deadline; the absolute cap is derived from
  `created_at` + `remember_device`, so no extra column was needed and the schema did not
  have to change.
- **Stateless CSRF token.** The token is an HMAC-SHA-256 of the session id under
  `CSRF_SIGNING_KEY`: no session column, no extra write, bound to one session, and it dies
  with that session. The `X-CSRF-Token` header is required — accepting the cookie alone
  would add nothing beyond SameSite.
- **TOTP replay.** The accepted time-step is recorded and a code from a consumed step is
  refused even inside its window (RFC 6238 §5.2). Accepted consequence: a second login
  within the same 30-second window fails.
- **Purpose-separated at-rest keys.** The single `SECRET_WRAP_KEY` root derives
  per-purpose AES-GCM keys with HKDF-SHA-256 (`totp-secret`, `audit-detail`), so a blob
  sealed for one purpose cannot be opened as another while only one secret must be
  provisioned.
- **Enrolment does not create a session.** After `/auth/setup` the user logs in through the
  normal TOTP path, so first-run setup can never bypass the second factor.
- **Cookies are attached to the response, not the context.** `setCookie(c, …)` followed by
  a handler returning a freshly built `Response` silently drops cookies in Hono, and the
  P0 `jsonOk` helper returns a raw Response — a live bug that this phase fixed. Cookies are
  appended to the outgoing response, and the security-header middleware copies
  `Set-Cookie` explicitly when it rebuilds one, because header iteration omits it.
- **`getAccount` orders by rowid.** The schema holds exactly one account, but ordering by
  the caller-supplied `created_at` let a row with a smaller timestamp shadow the real
  account. Insertion order is the deterministic, non-forgeable tiebreaker.
