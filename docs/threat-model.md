# Threat model

Derived from requirements §1, §17, §24, §25 and §26. The model is deliberately explicit
about what is **not** defended, so that hardening effort goes where it matters.

## Assets

| Asset                                  | Where it lives                            |
| -------------------------------------- | ----------------------------------------- |
| Note plaintext (title + Markdown body) | Browser memory only                       |
| Folder names, tag names, filenames     | Browser memory only                       |
| DEK / KEK                              | Browser memory only                       |
| Wrapped DEK, device-wrapped DEK        | D1, IndexedDB (ciphertext/protected)      |
| Attachment bytes                       | R2 (ciphertext)                           |
| TOTP secret, recovery code hashes      | D1 (server-side secrets)                  |
| Session tokens                         | Client cookie; server stores SHA-256 only |

## Adversaries in scope

- An attacker who obtains **source code + D1 ciphertext + R2 ciphertext** but no key
  material. Must not be able to decrypt anything.
- An ordinary internet attacker: brute force, credential stuffing, session hijacking,
  CSRF, XSS, SQL injection, IDOR/BOLA, malicious uploads, replay, sync race conditions.
- A malicious note author — that is, the user's own synchronised content arriving from
  another device and rendered in the editor (stored XSS and active content in HTML, SVG,
  CSS, Mermaid, KaTeX, iframes, external images).
- Network attackers on the transport, and replay of captured API requests.

## Out of scope (explicitly accepted)

- Full Worker-runtime compromise together with D1, R2, session secrets, the TOTP secret
  and Worker environment secrets (§25). The TOTP secret is a KEK input by requirement and
  is handed to the client after authentication, so this boundary is inherent.
- Cloudflare infrastructure compromise, nation-state adversaries.
- A compromised unlocked client device, a malicious browser extension, or a hostile
  browser: any of those defeats client-side encryption by definition.
- Denial of service and resource exhaustion at the platform edge.
- Loss of local data caused by the user clearing browser site data (§8: no extra warning
  is required).

## Threats and mitigations

| Threat                        | Mitigation                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential brute force        | TOTP-only authentication, exponential backoff with a cap, rate limiting per IP / account / global; no permanent lockout (§3).                                                                                           |
| Session hijacking             | 256-bit random token, server stores only SHA-256, `HttpOnly; Secure; SameSite=Strict; Path=/`, 40-minute sliding inactivity, max 5 sessions, revoke-all, device listing with truncated IP and UA category (§4).         |
| Session fixation              | New token issued on every authentication; TOTP rebind and recovery revoke other sessions.                                                                                                                               |
| CSRF                          | Double-submit token + strict `Origin`/`Referer` validation + `SameSite=Strict`, enforced on every state-changing endpoint (§14).                                                                                        |
| XSS (stored and reflected)    | DOMPurify with dedicated HTML and SVG profiles, CSS filtering, KaTeX `trust: false`, Mermaid SVG re-sanitised before insertion, strict CSP that is never weakened to allow script, no plain-URL autolinking (§12, §13). |
| Active content in SVG/Mermaid | Scripts, event handlers and external resource references stripped; generated SVG passes the sanitizer before DOM insertion.                                                                                             |
| iframe embeds                 | Allowed only over HTTPS, isolated with `sandbox` **without** `allow-same-origin`, so embedded content cannot reach application DOM or storage; CSP accounts for `frame-src` (§12).                                      |
| SQL injection                 | Parameterised queries only, no string-built SQL, foreign keys and indexes, D1 transactions (§14, §27).                                                                                                                  |
| IDOR / BOLA                   | Ownership check on every access; random ids are identifiers, never authorisation (§26).                                                                                                                                 |
| Malicious uploads             | Images only, ≤ 20 MB, content sniffed and `Content-Type` validated, stored as opaque encrypted objects, served with `nosniff` (§9).                                                                                     |
| Path/object manipulation      | R2 keys are server-chosen random ids; client-supplied names are never used as keys.                                                                                                                                     |
| Replay                        | One-time operation ids/nonces bound to user + session with a short lifetime for TOTP changes and recovery operations; idempotent sync/upload/delete transitions (§26).                                                  |
| Silent data loss on sync      | `base_revision` optimistic locking, conflict records, no last-write-wins, unsynced work is never evicted or discarded (§16, §8).                                                                                        |
| Audit-log abuse               | Sensitive fields encrypted, IP truncated, UA reduced to a category, no plaintext ever logged, exactly 30-day retention, user cannot clear logs (§5).                                                                    |
| Crypto misuse                 | Fresh 96-bit IV per encryption, AAD bound to object identity and revision, explicit `crypto_version`/`key_version`, no plaintext DEK persisted, resumable and reversible key migration (§6).                            |
| Client tampering with sync    | The server validates envelope shape, revisions and ownership; it never trusts client-supplied ownership, revision or size claims.                                                                                       |
| Data loss during migration    | IndexedDB migrations keep the last known-good database until the new schema succeeds; interrupted TOTP migration resumes or rolls back (§21, §3).                                                                       |
| Analytics / third-party leak  | No third-party analytics or telemetry of any kind (§1, §13, §24).                                                                                                                                                       |

## Privacy boundary

The server legitimately observes normal network and structural metadata: IP, request time,
User-Agent/network information, API path, random object ids, sizes, creation timestamps,
folder/note structural relationships, and session/sync metadata (§24).

The server must never receive: note titles or bodies, folder names, tag names, original
attachment filenames, or search queries and content. Modification times follow the
encrypted-metadata design so they are not exposed either.

## Verification

Requirements §31 lists the mandatory security tests; they are implemented alongside the
feature that introduces the surface (authentication in P2, sanitisation in P6, sync races
in P7, migration and cache safety in P4/P9) and summarised in the P9 acceptance report.
