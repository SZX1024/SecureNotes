import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { jsonOk } from "../lib/http";
import { requireSession } from "../middleware/session";

/**
 * Audit log read endpoint (§5, §15).
 *
 * Read-only on purpose: §5 says a user can never clear the log, so there is no
 * delete route and retention is enforced only by the scheduled cleanup. The
 * encrypted `detail` column is never decrypted here — the API exposes the
 * metadata an operator needs, not the sensitive payload.
 */

export const auditRoutes = new Hono<AppBindings>();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(0).optional(),
});

auditRoutes.get("/audit-logs", requireSession(), async (c) => {
  const session = c.get("session")!;
  const query = querySchema.safeParse({
    limit: c.req.query("limit"),
    before: c.req.query("before"),
  });
  if (!query.success) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "invalid audit-log query" });
  }

  const limit = query.data.limit ?? 100;
  const rows = await c.env.DB.prepare(
    `SELECT id, category, event_type, outcome, session_id, ip_truncated, client_category, created_at
       FROM audit_logs
      WHERE user_id = ?1 AND (?2 IS NULL OR created_at < ?2)
      ORDER BY created_at DESC
      LIMIT ?3`,
  )
    .bind(session.userId, query.data.before ?? null, limit)
    .all<{
      id: string;
      category: string;
      event_type: string;
      outcome: string;
      session_id: string | null;
      ip_truncated: string | null;
      client_category: string | null;
      created_at: number;
    }>();

  return jsonOk({
    entries: rows.results.map((row) => ({
      id: row.id,
      category: row.category,
      eventType: row.event_type,
      outcome: row.outcome,
      sessionId: row.session_id,
      ipTruncated: row.ip_truncated,
      clientCategory: row.client_category,
      createdAt: row.created_at,
    })),
  });
});
