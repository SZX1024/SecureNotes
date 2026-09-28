/**
 * Product policy constants shared by the worker and the client.
 *
 * Every value here is a number the frozen requirements state explicitly, or a
 * threshold recorded in docs/decisions.md as an approved default. They live in
 * `shared` because the client and the worker must agree on them: the worker
 * enforces a session's idle timeout and the client enforces App Lock against
 * the same 40 minutes.
 */

/** §4: normal inactivity policy. Sliding. */
export const SESSION_IDLE_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * §4: remember-device maximum lifetime. It caps a remembered session
 * absolutely and never bypasses TOTP.
 */
export const REMEMBER_DEVICE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * §4 allows skipping the D1 write on literally every request: the sliding
 * window is only persisted once this much time has passed.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

/** §4: maximum number of active sessions. The 6th evicts the least recently active. */
export const MAX_ACTIVE_SESSIONS = 5;

/** §3: recovery codes are single-use, 10 per account, 32 random characters each. */
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 32;

/** §6 TOTP parameters. Only the long-lived secret is a KDF input, never a code. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = "SHA-1";
/** Accepted time-step drift either side of now (RFC 6238 §5.2 recommends 1). */
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;

/** §5: audit retention is exactly 30 days; users cannot clear logs manually. */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** §16/§19: tombstones and recycle-bin entries are retained for 30 days. */
export const RECYCLE_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * §9 as amended: an attachment is any file of at most 60 MB. The ceiling is what fits in a
 * browser's memory while it is encrypted on the device before upload, and it sits well below the
 * request body limit of the platform it is uploaded to. Folders nest at most 10 deep.
 */
export const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_FOLDER_DEPTH = 10;
export const MAX_TAGS_PER_NOTE = 10;

/** §18: at most 10 historical revisions are kept in addition to the current one. */
export const MAX_HISTORICAL_REVISIONS = 10;

/**
 * Request body ceilings (§14 requires body-size limits). Authentication
 * payloads are tiny, so those routes use the smaller limit.
 */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_AUTH_BODY_BYTES = 8 * 1024;

/**
 * Rate limits and progressive backoff (§3). These are the defaults recommended
 * in docs/decisions.md and adopted for P2; the backoff is exponential with a
 * cap and never becomes a permanent lockout.
 */
export const AUTH_ATTEMPTS_PER_ACCOUNT_PER_HOUR = 10;
export const AUTH_ATTEMPTS_PER_IP_PER_HOUR = 30;
export const AUTH_ATTEMPTS_GLOBAL_PER_HOUR = 300;
export const AUTH_BACKOFF_BASE_MS = 1000;
export const AUTH_BACKOFF_CAP_MS = 60 * 1000;

/**
 * §26 one-time operation ids: bound to the user and session that requested them
 * and valid for a short window. Five minutes is long enough to complete a
 * re-wrap on a slow connection and short enough that a leaked nonce is useless.
 */
export const OPERATION_NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * §3 TOTP rebind: an abandoned rebind must not leave a second usable secret
 * behind, so the pending secret expires and is discarded.
 */
export const REBIND_TTL_MS = 15 * 60 * 1000;
