import { SESSION_IDLE_TIMEOUT_MS } from "@securenotes/shared";

/**
 * In-memory key material and App Lock (§7).
 *
 * "On application/page close, clear in-memory plaintext and DEK/key material
 * where possible. Persist only protected/encrypted material."
 *
 * So the DEK and the TOTP secret live here and nowhere else: this object is the
 * only place in the client that holds them, it has no serialisation, and `lock()`
 * drops the references. App Lock is the same 40 minutes the server applies to
 * session inactivity, so the two never disagree about when the app is stale.
 *
 * The lock is evaluated lazily whenever the material is read, so a tab that was
 * left open in the background locks itself without needing a timer to fire.
 */

export interface UnlockMaterial {
  /** The DEK, imported non-extractable: usable, never exportable. */
  dek: CryptoKey;
  /** Base32 TOTP secret, needed to re-derive the KEK. Memory-only (ADR-002). */
  totpSecret: string;
  userId: string;
  kdfSalt: string;
  keyVersion: number;
}

export class LockedError extends Error {
  constructor() {
    super("the app is locked");
    this.name = "LockedError";
  }
}

export class KeyStore {
  #material: UnlockMaterial | null = null;
  #lastActivityAt = 0;
  #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  }

  unlock(material: UnlockMaterial, nowMs: number = Date.now()): void {
    this.#material = material;
    this.#lastActivityAt = nowMs;
  }

  /** Drops the key material. Called on lock, logout, revocation and page close. */
  lock(): void {
    this.#material = null;
    this.#lastActivityAt = 0;
  }

  isUnlocked(nowMs: number = Date.now()): boolean {
    if (!this.#material) {
      return false;
    }
    if (nowMs - this.#lastActivityAt >= this.#timeoutMs) {
      // App Lock expired: drop the material now rather than reporting it as
      // available and locking on the next call.
      this.lock();
      return false;
    }
    return true;
  }

  /** Records activity, extending the App Lock window. */
  touch(nowMs: number = Date.now()): void {
    if (this.#material) {
      this.#lastActivityAt = nowMs;
    }
  }

  /**
   * The unlocked material, or a `LockedError`. Throwing rather than returning
   * null makes it impossible to accidentally proceed with `undefined` keys.
   */
  require(nowMs: number = Date.now()): UnlockMaterial {
    if (!this.isUnlocked(nowMs)) {
      throw new LockedError();
    }
    this.touch(nowMs);
    return this.#material!;
  }
}

/** The events that must clear in-memory key material (§7). */
export const LOCK_EVENTS = ["pagehide", "beforeunload", "freeze"] as const;

/**
 * Wires the store to the page lifecycle so closing or freezing the page clears
 * the keys. Returns a function that removes the listeners again.
 */
export function attachLockOnPageHide(
  store: KeyStore,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const lock = () => store.lock();
  for (const event of LOCK_EVENTS) {
    target.addEventListener(event, lock);
  }
  return () => {
    for (const event of LOCK_EVENTS) {
      target.removeEventListener(event, lock);
    }
  };
}
