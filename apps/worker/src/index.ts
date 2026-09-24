import { app } from "./app";
import type { Env } from "./env";

export default {
  fetch: app.fetch,

  /**
   * Scheduled maintenance. P2 implements the audit-log sweep here: retention is
   * exactly 30 days and users cannot clear logs manually (§5).
   */
  scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): void {
    // Intentionally empty in P0: the cron trigger is wired in wrangler.toml so
    // the deployment shape is already correct.
  },
} satisfies ExportedHandler<Env>;
