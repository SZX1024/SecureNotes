import { useEffect, useState } from "react";

import { Icon } from "./Icon";

/**
 * Asking for a code without leaving the page (§3, §22).
 *
 * A session expires while someone is writing and the syncing stops. Sending them to the sign-in screen to fix that costs
 * them the note they had open, the cursor in it, and anything they had not saved — for a session that only needs a code.
 * This asks for the code where they are and, on success, the sync resumes with everything as it was.
 *
 * It is not a second login form. There is no "remember this device" to decide — the device is already this one — and the
 * username is known, except after a recovery sign-in, where the account comes back without it and it has to be asked
 * for.
 */

export interface ReauthDialogProps {
  /** Known in most cases; empty after a recovery sign-in. */
  username: string;
  /** Returns an error to show, or null when the session was restored and syncing can resume. */
  onSubmit: (username: string, code: string) => Promise<string | null>;
  onClose: () => void;
}

export function ReauthDialog({ username, onSubmit, onClose }: ReauthDialogProps) {
  const [name, setName] = useState(username);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    if (code.trim().length === 0 || name.trim().length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(name.trim(), code.trim());
    setBusy(false);
    if (failure === null) {
      onClose();
    } else {
      setError(failure);
      setCode("");
    }
  };

  return (
    <div className="overlay" onPointerDown={onClose}>
      <section
        className="dialog reauth"
        role="dialog"
        aria-label="Sign in again"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Sign in again to sync</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="remove" />
          </button>
        </header>

        <form
          className="reauth-body"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="muted">
            The session has expired. Your notes are on this device and untouched; this only restores
            the connection.
          </p>

          {username.trim().length === 0 && (
            <label className="field">
              <span>Username</span>
              <input
                aria-label="Username"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}

          <label className="field">
            <span>Authenticator code</span>
            <input
              aria-label="Authenticator code"
              value={code}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>

          {error !== null && <p className="error">{error}</p>}

          <div className="reauth-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || code.trim().length === 0 || name.trim().length === 0}
            >
              {busy ? "Checking…" : "Sign in and sync"}
            </button>
            <button type="button" onClick={onClose}>
              Not now
            </button>
          </div>

          <p className="muted">
            Lost the authenticator? A recovery code signs in from the sign-in screen, which reloads
            the application.
          </p>
        </form>
      </section>
    </div>
  );
}
