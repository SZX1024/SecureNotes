import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { openAppDatabase } from "./local/migrations";
import { pendingChangeCount } from "./local/sync-queue";
import { registerServiceWorker } from "./pwa/register";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("root container is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Start the local database and the service worker.
 *
 * Both are fire-and-forget: the shell renders first, and a failure here (private
 * browsing without IndexedDB, a browser without service workers) must not stop
 * the app from working online. The update gate is handed the real queue size, so
 * a deferred update is only applied when nothing is waiting to sync (§21).
 */
void (async () => {
  try {
    const { db } = await openAppDatabase(localStorage);
    await registerServiceWorker({
      countPendingChanges: () => pendingChangeCount(db),
    });
  } catch (error) {
    console.warn("local database or service worker unavailable", error);
  }
})();
