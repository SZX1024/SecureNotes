import { MAX_FOLDER_DEPTH } from "@securenotes/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { jsonOk } from "../lib/http";
import { parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import {
  createFolder,
  listFolders,
  purgeFolder,
  restoreFolder,
  serializeFolder,
  softDeleteFolder,
  updateFolder,
  findFolder,
} from "../services/folders";
import { envelopeSchema } from "../services/notes";

/**
 * Folder endpoints (§9, §10, §15).
 *
 * Depth is capped at 10 and a subtree can be moved, so the checks that matter are
 * the ones a single request cannot express: whether a move would push a leaf past
 * the maximum, and whether a folder is being moved into its own subtree.
 */

export const folderRoutes = new Hono<AppBindings>();

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable().optional(),
    name: envelopeSchema,
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: envelopeSchema.optional(),
    parentId: idSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

folderRoutes.get("/folders", requireSession(), async (c) => {
  const session = c.get("session")!;
  const includeDeleted = c.req.query("includeDeleted") === "1";
  const folders = await listFolders(c.env, session.userId, { includeDeleted });

  return jsonOk({ folders: folders.map(serializeFolder), maxDepth: MAX_FOLDER_DEPTH });
});

folderRoutes.post("/folders", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, createSchema);

  const existing = await findFolder(c.env, session.userId, body.id);
  if (existing) {
    throw new ApiError("CONFLICT", { diagnostic: "a folder with that id already exists" });
  }

  const folder = await createFolder(
    c.env,
    session.userId,
    {
      id: body.id,
      parentId: body.parentId ?? null,
      name: body.name,
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    },
    Date.now(),
  );

  return jsonOk({ folder: serializeFolder(folder) }, 201);
});

folderRoutes.get("/folders/:id", requireSession(), async (c) => {
  const session = c.get("session")!;
  const folder = await findFolder(c.env, session.userId, c.req.param("id"));
  if (!folder) {
    throw new ApiError("NOT_FOUND");
  }
  return jsonOk({ folder: serializeFolder(folder) });
});

folderRoutes.patch("/folders/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, updateSchema);

  const folder = await updateFolder(
    c.env,
    session.userId,
    c.req.param("id"),
    {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    },
    Date.now(),
  );

  return jsonOk({ folder: serializeFolder(folder) });
});

/** Soft delete: the subtree and its notes keep their ids and relationships. */
folderRoutes.delete("/folders/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const result = await softDeleteFolder(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk(result);
});

folderRoutes.post("/folders/:id/restore", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const result = await restoreFolder(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk(result);
});

folderRoutes.delete("/folders/:id/permanent", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const result = await purgeFolder(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk(result);
});
