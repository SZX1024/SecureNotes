import { MAX_HISTORICAL_REVISIONS } from "@securenotes/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { jsonOk } from "../lib/http";
import { parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import { writeAuditEvent } from "../services/audit";
import {
  createNote,
  findNote,
  listNotes,
  listRevisions,
  purgeNote,
  restoreNote,
  restoreRevision,
  serializeNote,
  softDeleteNote,
  updateNote,
  envelopeSchema,
} from "../services/notes";

/**
 * Notes endpoints (§9, §15, §18, §19, §27).
 *
 * Every route is scoped by the authenticated user in addition to the object id,
 * so a valid id from elsewhere is still a `NOT_FOUND` — ids are identifiers,
 * never authorization (§26).
 */

export const noteRoutes = new Hono<AppBindings>();

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createSchema = z
  .object({
    id: idSchema,
    folderId: idSchema.nullable().optional(),
    payload: envelopeSchema,
    pinned: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    baseRevision: z.number().int().min(1),
    payload: envelopeSchema.optional(),
    folderId: idSchema.nullable().optional(),
    pinned: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  folderId: idSchema.optional(),
  includeDeleted: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

noteRoutes.get("/notes", requireSession(), async (c) => {
  const session = c.get("session")!;
  const query = listQuerySchema.safeParse({
    folderId: c.req.query("folderId"),
    includeDeleted: c.req.query("includeDeleted"),
    limit: c.req.query("limit"),
  });
  if (!query.success) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "invalid note query" });
  }

  const notes = await listNotes(c.env, session.userId, {
    ...(query.data.folderId === undefined ? {} : { folderId: query.data.folderId }),
    includeDeleted: query.data.includeDeleted === "1",
    ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
  });

  return jsonOk({ notes });
});

noteRoutes.post("/notes", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, createSchema);
  const now = Date.now();

  const existing = await findNote(c.env, session.userId, body.id);
  if (existing) {
    throw new ApiError("CONFLICT", { diagnostic: "a note with that id already exists" });
  }

  const note = await createNote(
    c.env,
    session.userId,
    {
      id: body.id,
      folderId: body.folderId ?? null,
      payload: body.payload,
      ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    },
    now,
  );

  return jsonOk({ note: serializeNote(note) }, 201);
});

noteRoutes.get("/notes/:id", requireSession(), async (c) => {
  const session = c.get("session")!;
  const note = await findNote(c.env, session.userId, c.req.param("id"));
  if (!note) {
    throw new ApiError("NOT_FOUND");
  }
  return jsonOk({ note: serializeNote(note) });
});

noteRoutes.patch("/notes/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, updateSchema);
  const now = Date.now();

  const note = await updateNote(
    c.env,
    session.userId,
    c.req.param("id"),
    {
      baseRevision: body.baseRevision,
      ...(body.payload === undefined ? {} : { payload: body.payload }),
      ...(body.folderId === undefined ? {} : { folderId: body.folderId }),
      ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    },
    now,
  );

  return jsonOk({ note: serializeNote(note) });
});

/** Soft delete: the note keeps its id and history and moves to the recycle bin (§19). */
noteRoutes.delete("/notes/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const note = await softDeleteNote(c.env, session.userId, c.req.param("id"), Date.now());

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "data",
      eventType: "data_operation",
      sessionId: session.id,
      detail: "note deleted to the recycle bin",
    },
    Date.now(),
    c.get("requestId"),
  );

  return jsonOk({ note: serializeNote(note) });
});

noteRoutes.post("/notes/:id/restore", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const note = await restoreNote(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk({ note: serializeNote(note) });
});

/** Permanent deletion removes the note and all of its history. */
noteRoutes.delete("/notes/:id/permanent", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  await purgeNote(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk({ purged: true });
});

noteRoutes.get("/notes/:id/revisions", requireSession(), async (c) => {
  const session = c.get("session")!;
  const revisions = await listRevisions(c.env, session.userId, c.req.param("id"));
  return jsonOk({ revisions, maxHistorical: MAX_HISTORICAL_REVISIONS });
});

noteRoutes.post(
  "/notes/:id/revisions/:revisionId/restore",
  requireSession(),
  requireCsrf(),
  async (c) => {
    const session = c.get("session")!;
    const note = await restoreRevision(
      c.env,
      session.userId,
      c.req.param("id"),
      c.req.param("revisionId"),
      Date.now(),
    );
    return jsonOk({ note: serializeNote(note) });
  },
);

/** The recycle bin: everything soft-deleted, newest first (§19). */
export const recycleBinRoutes = new Hono<AppBindings>();

recycleBinRoutes.get("/recycle-bin", requireSession(), async (c) => {
  const session = c.get("session")!;
  const notes = await listNotes(c.env, session.userId, { includeDeleted: true });
  return jsonOk({ notes: notes.filter((note) => note.deletedAt !== null) });
});
