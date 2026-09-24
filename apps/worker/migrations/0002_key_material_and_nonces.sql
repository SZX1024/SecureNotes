-- P3: one-time operation nonces and the resumable TOTP rebind state machine.
--
-- Neither could be expressed in 0001: nonces were deferred by the P1 plan and
-- the rebind columns depend on the state machine design settled in P3. 0001 is
-- applied and committed, so this is a new migration rather than an edit.

-- ---------------------------------------------------------------------------
-- One-time operation ids (§26). Sensitive state transitions carry a nonce that
-- the server issued, so it is bound to the user and session that requested it
-- and has a short lifetime.
--
-- Consumption is a conditional UPDATE on `consumed_at`, so two concurrent
-- requests can never both spend the same nonce. Rows are swept with the
-- rate-limit cleanup; `consumed_at` is kept rather than deleting the row so a
-- replay attempt is refused for the whole lifetime of the window.
-- ---------------------------------------------------------------------------
CREATE TABLE operation_nonces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The session that requested it; a nonce must not be usable from another.
  session_id TEXT,
  operation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX operation_nonces_user_operation_idx ON operation_nonces (user_id, operation);
CREATE INDEX operation_nonces_expires_at_idx ON operation_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- TOTP rebind state machine (requirements §3, ADR-004).
--
-- `idle`                  — no rebind in progress; `secret_*` is the only secret.
-- `awaiting_verification` — a new secret exists as `pending_*`; the old one is
--                           still the active secret and the QR has been shown.
-- `rewrapping`            — the new secret was proven, so the client may now
--                           re-wrap the DEK and the recovery codes; the old
--                           secret is still stored so the data can always be
--                           recovered, and a rollback is still possible.
--
-- The old secret is only discarded, and the new one promoted, by the atomic
-- commit that also stores the new wrappings. An interruption at any point
-- therefore leaves recoverable data: that is what "resumable, with rollback"
-- means in practice.
-- ---------------------------------------------------------------------------
ALTER TABLE totp_config ADD COLUMN rebind_state TEXT NOT NULL DEFAULT 'idle'
  CHECK (rebind_state IN ('idle', 'awaiting_verification', 'rewrapping'));
ALTER TABLE totp_config ADD COLUMN pending_secret_iv TEXT;
ALTER TABLE totp_config ADD COLUMN pending_secret_ciphertext TEXT;
-- The key version the rebind will move to; written when the rebind starts so the
-- client knows which version to wrap under, even across an interruption.
ALTER TABLE totp_config ADD COLUMN pending_key_version INTEGER;
ALTER TABLE totp_config ADD COLUMN rebind_started_at INTEGER;
