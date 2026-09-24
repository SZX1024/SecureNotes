import type { SecureNotesDatabase } from "../local/schema";
import { pendingChangeCount } from "../local/sync-queue";
import { decideUpdate, SKIP_WAITING_MESSAGE } from "./update-gate";

/**
 * Service-worker registration and update handling (§21).
 *
 * The worker never activates itself: `public/sw.js` waits for an explicit
 * message, and this module only sends it once the update gate says there is no
 * unsynced work. Until then the new worker stays waiting and the app keeps
 * running the version whose caches and queue it understands.
 */

export interface UpdateStatus {
  /** True when a newer version is installed and waiting to activate. */
  updateAvailable: boolean;
  /** True when the update was withheld because work is still queued. */
  deferredByUnsyncedData: boolean;
}

export type UpdateListener = (status: UpdateStatus) => void;

interface RegisterOptions {
  /** Reads the queue size; a failure is treated as "has pending work". */
  countPendingChanges: () => Promise<number>;
  onStatusChange?: UpdateListener;
}

async function safePendingCount(count: () => Promise<number>): Promise<number> {
  try {
    return await count();
  } catch {
    // Fail closed: an unreadable queue is not evidence that there is no work.
    return 1;
  }
}

/**
 * Registers the service worker and wires up gated updates.
 *
 * Returns the registration, or null in an environment without service-worker
 * support (jsdom, an insecure origin, or a browser with it disabled).
 */
export async function registerServiceWorker(
  options: RegisterOptions,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

  const notify = (status: UpdateStatus) => options.onStatusChange?.(status);

  const handleWaiting = async (waiting: ServiceWorker | null) => {
    if (!waiting) {
      return;
    }
    const pending = await safePendingCount(options.countPendingChanges);
    const decision = decideUpdate({ updateWaiting: true, pendingChanges: pending });

    if (decision.apply) {
      waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
      notify({ updateAvailable: true, deferredByUnsyncedData: false });
      return;
    }
    notify({ updateAvailable: true, deferredByUnsyncedData: true });
  };

  await handleWaiting(registration.waiting);

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        void handleWaiting(registration.waiting ?? installing);
      }
    });
  });

  return registration;
}

/**
 * Applies a deferred update once the queue is empty. Called after a successful
 * sync, which is the moment §21 describes as "when synchronization is safe".
 */
export async function applyDeferredUpdate(db: SecureNotesDatabase): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const waiting = registration?.waiting ?? null;
  if (!waiting) {
    return false;
  }

  const pending = await safePendingCount(() => pendingChangeCount(db));
  if (!decideUpdate({ updateWaiting: true, pendingChanges: pending }).apply) {
    return false;
  }

  waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
  return true;
}
