import { MAX_ATTACHMENT_TOTAL_BYTES, MAX_TAGS_PER_NOTE } from "@securenotes/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { jsonOk } from "../lib/http";
import { parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import {
  attachmentUsageBytes,
  linkAttachment,
  listNoteAttachments,
  readAttachmentBytes,
  serializeAttachment,
  storeAttachment,
  unlinkAttachment,
  findAttachment,
} from "../services/attachments";
import { envelopeSchema } from "../services/notes";
import {
  createTag,
  deleteTag,
  listNoteTagIds,
  listTags,
  renameTag,
  serializeTag,
  setNoteTags,
} from "../services/tags";

/**
 * Tag and attachment endpoints (§9, §10, §14, §15).
 *
 * Attachments are the one binary upload in the API, so this router is also where
 * the JSON-only body guard is deliberately relaxed (see `app.ts`): the handler
 * parses the multipart form itself and enforces the 20 MB ceiling.
 */

export const tagRoutes = new Hono<AppBindings>();
export const attachmentRoutes = new Hono<AppBindings>();

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createTagSchema = z.object({ id: idSchema, name: envelopeSchema }).strict();
const renameTagSchema = z.object({ name: envelopeSchema }).strict();
const setTagsSchema = z.object({ tagIds: z.array(idSchema).max(MAX_TAGS_PER_NOTE) }).strict();

tagRoutes.get("/tags", requireSession(), async (c) => {
  const session = c.get("session")!;
  const tags = await listTags(c.env, session.userId);
  return jsonOk({ tags: tags.map(serializeTag), maxPerNote: MAX_TAGS_PER_NOTE });
});

tagRoutes.post("/tags", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, createTagSchema);
  const tag = await createTag(c.env, session.userId, body, Date.now());
  return jsonOk({ tag: serializeTag(tag) }, 201);
});

tagRoutes.patch("/tags/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, renameTagSchema);
  const tag = await renameTag(c.env, session.userId, c.req.param("id"), body.name, Date.now());
  return jsonOk({ tag: serializeTag(tag) });
});

/** Deleting a tag removes relationships only; the notes are untouched (§9). */
tagRoutes.delete("/tags/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const result = await deleteTag(c.env, session.userId, c.req.param("id"), Date.now());
  return jsonOk(result);
});

/** Replaces a note's tag set (set semantics, §16). */
tagRoutes.put("/notes/:id/tags", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, setTagsSchema);
  const tagIds = await setNoteTags(
    c.env,
    session.userId,
    c.req.param("id"),
    body.tagIds,
    Date.now(),
  );
  return jsonOk({ tagIds });
});

tagRoutes.get("/notes/:id/tags", requireSession(), async (c) => {
  const session = c.get("session")!;
  const tagIds = await listNoteTagIds(c.env, session.userId, c.req.param("id"));
  return jsonOk({ tagIds });
});

/**
 * `sizeBytes` has no upper bound here on purpose: the ceiling is enforced once,
 * in `storeAttachment`, so an oversized upload is reported as `PAYLOAD_TOO_LARGE`
 * (413) rather than as a malformed request (400). Two places deciding the limit
 * would also risk them disagreeing.
 */
const metadataSchema = z
  .object({
    id: idSchema,
    name: envelopeSchema,
    contentType: z.string().min(3).max(128),
    sizeBytes: z.number().int().min(1),
    // The content envelope (§7): without these the uploaded bytes are unreadable.
    contentIv: z.string().min(16).max(24),
    plaintextSizeBytes: z.number().int().min(1),
    /** Absent or null keeps the attachment; a timestamp makes it temporary. */
    expiresAt: z.number().int().positive().nullable().optional(),
  })
  .strict();

/**
 * Uploads an encrypted attachment.
 *
 * The body is `multipart/form-data` (§14) with a `metadata` JSON part and a
 * `blob` part holding the client's ciphertext. The declared size must match the
 * upload, so the limit cannot be bypassed by understating it.
 */
attachmentRoutes.post("/attachments", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const form = await c.req.formData();

  const metadataRaw = form.get("metadata");
  const blob = form.get("blob");
  if (typeof metadataRaw !== "string" || !(blob instanceof File)) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "expected a metadata part and a blob part",
    });
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(metadataRaw);
  } catch {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "metadata is not valid JSON" });
  }
  const metadata = metadataSchema.safeParse(parsedMetadata);
  if (!metadata.success) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "invalid attachment metadata" });
  }

  const bytes = await blob.arrayBuffer();
  const row = await storeAttachment(
    c.env,
    session.userId,
    {
      id: metadata.data.id,
      name: metadata.data.name,
      contentType: metadata.data.contentType,
      sizeBytes: metadata.data.sizeBytes,
      contentIv: metadata.data.contentIv,
      plaintextSizeBytes: metadata.data.plaintextSizeBytes,
      expiresAt: metadata.data.expiresAt ?? null,
      blob: bytes,
    },
    Date.now(),
  );

  return jsonOk({ attachment: serializeAttachment(row) }, 201);
});

/**
 * What the account stores, and what it may store.
 *
 * Registered before `/attachments/:id` on purpose: the router matches in order, so `usage` would otherwise be read as an
 * attachment identifier and answer 404.
 */
attachmentRoutes.get("/attachments/usage", requireSession(), async (c) => {
  const session = c.get("session")!;
  const usedBytes = await attachmentUsageBytes(c.env, session.userId);
  return jsonOk({ usedBytes, limitBytes: MAX_ATTACHMENT_TOTAL_BYTES });
});

attachmentRoutes.get("/attachments/:id", requireSession(), async (c) => {
  const session = c.get("session")!;
  const row = await findAttachment(c.env, session.userId, c.req.param("id"));
  if (!row) {
    throw new ApiError("NOT_FOUND");
  }
  return jsonOk({ attachment: serializeAttachment(row) });
});

/** Serves the stored ciphertext. The client decrypts; the worker cannot. */
attachmentRoutes.get("/attachments/:id/content", requireSession(), async (c) => {
  const session = c.get("session")!;
  const found = await readAttachmentBytes(c.env, session.userId, c.req.param("id"));
  if (!found) {
    throw new ApiError("NOT_FOUND");
  }

  return new Response(found.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(found.row.size_bytes),
      // Ciphertext is still user data: never let a shared cache keep it.
      "cache-control": "no-store",
    },
  });
});

attachmentRoutes.post("/notes/:id/attachments", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, z.object({ attachmentId: idSchema }).strict());
  await linkAttachment(c.env, session.userId, c.req.param("id"), body.attachmentId, Date.now());
  return jsonOk({ linked: true });
});

attachmentRoutes.delete(
  "/notes/:id/attachments/:attachmentId",
  requireSession(),
  requireCsrf(),
  async (c) => {
    const session = c.get("session")!;
    const result = await unlinkAttachment(
      c.env,
      session.userId,
      c.req.param("id"),
      c.req.param("attachmentId"),
      Date.now(),
    );
    return jsonOk(result);
  },
);

attachmentRoutes.get("/notes/:id/attachments", requireSession(), async (c) => {
  const session = c.get("session")!;
  const attachments = await listNoteAttachments(c.env, session.userId, c.req.param("id"));
  return jsonOk({ attachments });
});
