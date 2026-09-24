import { app } from "./app";
import type { Env } from "./env";
import { purgeExpiredAuditLogs, purgeExpiredRateLimits } from "./services/audit";
import { purgeExpiredNonces } from "./services/nonces";

export default {
  fetch: app.fetch,

  /**
   * Scheduled maintenance, from the hourly cron trigger in wrangler.toml.
   *
   * Two jobs, both pure retention:
   * - audit entries older than exactly 30 days are deleted (§5; a user can
   *   never clear the log, so this is the only path that removes them);
   * - expired rate-limit windows and spent operation nonces are dropped, since
   *   both are short-lived counters rather than history.
   *
   * `waitUntil` keeps the isolate alive until the sweeps finish; a failure is
   * logged rather than thrown, because a missed sweep must not crash the trigger
   * and will run again on the next tick.
   */
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      (async () => {
        const now = Date.now();
        try {
          const auditRows = await purgeExpiredAuditLogs(env, now);
          const rateLimitRows = await purgeExpiredRateLimits(env, now);
          const nonceRows = await purgeExpiredNonces(env, now);
          console.log(
            `scheduled cleanup: removed ${auditRows} audit row(s), ${rateLimitRows} rate-limit row(s), ${nonceRows} nonce row(s)`,
          );
        } catch (error) {
          console.error("scheduled cleanup failed", error);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
