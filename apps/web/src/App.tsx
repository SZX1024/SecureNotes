import { useEffect, useState, type JSX } from "react";

import { ApiError, fetchHealth } from "./api/client";

type HealthState =
  | { kind: "loading" }
  | { kind: "ready"; version: string; environment: string }
  | { kind: "error"; message: string };

/**
 * P0 shell.
 *
 * It exists to prove the whole chain end to end (browser -> same-origin API ->
 * worker -> bindings) and to show the application version (§21). Layout,
 * routing, unlock and the three-pane workspace arrive in later phases.
 */
export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal).then(
      (payload) =>
        setHealth({ kind: "ready", version: payload.version, environment: payload.environment }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof ApiError ? error.message : "Unexpected error";
        setHealth({ kind: "error", message });
      },
    );
    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>SecureNotes</h1>
        <span className="app-version" data-testid="app-version">
          v{__APP_VERSION__}
        </span>
      </header>

      <main className="app-main">
        <section className="panel" aria-labelledby="status-heading">
          <h2 id="status-heading">Backend status</h2>
          {health.kind === "loading" && <p>Checking…</p>}
          {health.kind === "ready" && (
            <p className="status-ok">
              Connected · worker v{health.version} · {health.environment}
            </p>
          )}
          {health.kind === "error" && <p className="status-error">{health.message}</p>}
        </section>

        <section className="panel" aria-labelledby="phase-heading">
          <h2 id="phase-heading">Implementation status</h2>
          <p>
            P0 scaffolding is in place: workspace, worker skeleton, client shell, tests and
            documentation. Notes, encryption, offline storage and sync are wired in later phases.
          </p>
        </section>
      </main>
    </div>
  );
}
