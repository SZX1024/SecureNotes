# Security policy

SecureNotes protects personal notes with client-side encryption. The server is **not**
trusted with plaintext, and the source code, algorithms and protocol are public: security
rests on secret key material and correct implementation, never on obscurity.

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → Security → Advisories) or
contact the maintainer directly. Please include reproduction steps and the affected
version from Settings → About. Do not open a public issue for an unfixed vulnerability.

There is no bug-bounty programme and no response-time SLA; this is a personal project.

## What is in scope

- Plaintext disclosure of note content, folder/tag names or attachment filenames.
- Authentication, session and recovery-code weaknesses.
- Injection, XSS (including stored XSS through sanitised HTML/SVG/Mermaid), CSRF,
  IDOR/BOLA, SQL injection, request smuggling and replay.
- Sync integrity: silent overwrite, lost unsynced work, conflict-handling bypass.
- Cryptographic misuse: IV reuse, missing AAD verification, key-version confusion,
  plaintext DEK persistence.

## What is explicitly accepted (not a vulnerability)

From requirements §25: an attacker who fully compromises the Worker runtime **and**
obtains D1, R2, session secrets, the TOTP secret and Worker environment secrets may be
able to decrypt historical data. This is a documented, accepted boundary of the design —
the TOTP secret is a KDF input by requirement, and the browser obtains it after
successful authentication in order to derive the KEK.

Nation-state adversaries, full Cloudflare infrastructure compromise, and compromise of an
unlocked client device (for example an XSS-free attacker with local code execution or a
malicious browser extension) are outside the threat model.

## Non-negotiable invariants

These are restated from requirements §33 because every change must preserve them:

1. Never log secrets, keys, recovery codes, TOTP secrets or note plaintext.
2. Never send note plaintext, folder/tag names, attachment filenames or search queries to
   the server.
3. Never reuse an AES-GCM IV under the same key; a fresh random 96-bit IV per encryption.
4. Never persist a plaintext DEK; only wrapped key material.
5. Never treat a random identifier as authorisation; verify ownership on every request.
6. Never use last-write-wins for note conflicts, and never discard unsynced local changes.
7. Never bypass TOTP because a device is remembered.
8. Never render user-controlled HTML, SVG or Mermaid output without sanitisation.
9. Never allow URL schemes other than `http`/`https`, and never weaken CSP to permit
   arbitrary script execution.
10. Never introduce third-party analytics or server-side plaintext processing.
11. Never weaken the strict `Content-Type`, origin/CSRF or body-size validation on
    state-changing endpoints.
12. Never expose stack traces, SQL detail or secrets in an API response.

## Testing

Security tests are mandatory and grow with each phase (requirements §31). `pnpm test`
runs the unit and worker integration suites; `pnpm check` runs the full gate including
lint, typecheck and version consistency. Playwright-based attack suites (XSS, SVG active
content, CSRF, cache eviction, migration interruption) land in P6–P9.
