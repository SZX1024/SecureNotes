# API contract

Same-origin REST under `/api/v1` (requirements §14, §15). No CORS headers are ever sent;
access is cookie-based and same-origin only.

## Envelope

Success:

```json
{ "ok": true, "data": {} }
```

Failure:

```json
{
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "The requested resource was not found." }
}
```

- `code` comes from the closed set in `packages/shared/src/errors.ts`.
- `message` is a fixed generic sentence per code; it never contains request-derived data.
- `error.diagnostic` is present **only** when the worker runs with
  `ENVIRONMENT=development`. It is absent in production, so no stack trace, SQL fragment
  or secret can leak.
- The client maps `code` onto its own local message table and never renders a
  server-supplied string.

## Status codes

| Code                     | HTTP | Meaning                                       |
| ------------------------ | ---- | --------------------------------------------- |
| `BAD_REQUEST`            | 400  | Malformed request                             |
| `VALIDATION_FAILED`      | 400  | Schema validation failed                      |
| `UNAUTHENTICATED`        | 401  | No valid session                              |
| `INVALID_CREDENTIALS`    | 401  | Username/TOTP/recovery code rejected          |
| `TOTP_REQUIRED`          | 401  | A current authenticator code is required      |
| `FORBIDDEN`              | 403  | Authenticated but not permitted               |
| `ORIGIN_REJECTED`        | 403  | `Origin`/`Referer` failed validation          |
| `CSRF_FAILED`            | 403  | CSRF token missing or mismatched              |
| `NOT_FOUND`              | 404  | Unknown resource **or** not owned by the user |
| `METHOD_NOT_ALLOWED`     | 405  | Wrong HTTP method for the endpoint            |
| `CONFLICT`               | 409  | State conflict (for example duplicate id)     |
| `REVISION_CONFLICT`      | 409  | `base_revision` no longer matches the server  |
| `PRECONDITION_FAILED`    | 412  | Operation invalid for the current state       |
| `PAYLOAD_TOO_LARGE`      | 413  | Body limit exceeded                           |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | `Content-Type` not allowed                    |
| `RATE_LIMITED`           | 429  | Progressive backoff active                    |
| `INTERNAL`               | 500  | Unexpected failure, details withheld          |

## Headers

Request:

| Header         | Notes                                                        |
| -------------- | ------------------------------------------------------------ |
| `Cookie`       | `session` (HttpOnly) and `csrf` (readable by same-origin JS) |
| `X-CSRF-Token` | Required on state-changing methods (double submit)           |
| `Content-Type` | `application/json`, or `multipart/form-data` for attachments |

Response:

| Header                      | Notes                                             |
| --------------------------- | ------------------------------------------------- |
| `X-Request-Id`              | Correlation id, also referenced by audit records  |
| `Content-Security-Policy`   | `default-src 'none'; …; sandbox` on API responses |
| `Cache-Control`             | `no-store` on API responses                       |
| `X-Content-Type-Options`    | `nosniff`                                         |
| `Referrer-Policy`           | `no-referrer`                                     |
| `X-Frame-Options`           | `DENY`                                            |
| `Cross-Origin-*`            | `same-origin` for opener and resource policy      |
| `Strict-Transport-Security` | Production only                                   |

## Endpoints

Method sets are strict: an unsupported method returns `METHOD_NOT_ALLOWED`, never a
misleading `404`. Every authenticated endpoint verifies authenticated user + resource
ownership + operation validity (§26).

| Method                | Path                                  | Phase | Notes                                                    |
| --------------------- | ------------------------------------- | ----- | -------------------------------------------------------- |
| GET                   | `/api/v1/health`                      | P0 ✅ | Version and environment only, unauthenticated            |
| POST                  | `/api/v1/auth/login`                  | P2    | Username + TOTP; returns wrapped key material + KDF salt |
| POST                  | `/api/v1/auth/recovery`               | P2    | Username + one recovery code                             |
| POST                  | `/api/v1/auth/logout`                 | P2    | Revokes the current session                              |
| GET                   | `/api/v1/auth/session`                | P2    | Current session and device                               |
| POST                  | `/api/v1/auth/setup`                  | P2    | First-run enrolment (single account)                     |
| GET                   | `/api/v1/sessions`                    | P2    | Max 5; least-recently-active is evicted on a 6th login   |
| DELETE                | `/api/v1/sessions/:id`                | P2    | Individual revoke                                        |
| POST                  | `/api/v1/sessions/revoke-all`         | P2    | Includes the current session                             |
| POST                  | `/api/v1/security/totp/change/start`  | P3    | One-time operation id, short lifetime                    |
| POST                  | `/api/v1/security/totp/change/verify` | P3    | Verifies new secret, then invalidates old                |
| GET/POST/PATCH/DELETE | `/api/v1/notes/...`                   | P5    | Ciphertext payloads, `base_revision` enforced            |
| GET/POST/PATCH/DELETE | `/api/v1/folders/...`                 | P5    | Encrypted names, max depth 10                            |
| GET/POST/PATCH/DELETE | `/api/v1/tags/...`                    | P5    | Encrypted names, max 10 per note                         |
| GET/POST/DELETE       | `/api/v1/attachments/...`             | P5    | Images only, ≤ 20 MB, random R2 ids                      |
| POST                  | `/api/v1/sync/push`                   | P7    | Batched, idempotent, per-object conflict                 |
| GET                   | `/api/v1/sync/pull`                   | P7    | Cursor-based incremental pull                            |
| POST                  | `/api/v1/export/...`                  | P8    | Manual, full export only                                 |
| POST                  | `/api/v1/import/...`                  | P8    | Fully transactional, validate-then-commit                |
| GET                   | `/api/v1/audit-logs`                  | P2    | 30-day window, sensitive fields encrypted                |
| POST                  | `/api/v1/recovery-codes/regenerate`   | P3    | Re-wraps the DEK for 10 new codes                        |

Exact decomposition may be refined during implementation without changing requirements
(§15); this table is updated as routes land.

## Request limits

Per endpoint, as applicable: strict `Content-Type` check, body-size limit, field count,
nesting depth and array length limits, and parameterised SQL only. Attachments add a
20 MB limit and image-only MIME validation. Production errors never expose SQL detail.
