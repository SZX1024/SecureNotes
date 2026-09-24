import { MAX_ATTACHMENT_BYTES } from "@securenotes/shared";

import { ApiError } from "../api/client";
import { attachmentMarkdown } from "../editor/attachments";

/**
 * Uploading an attachment (§12, §15).
 *
 * The request shape matches the API contract exactly: a `metadata` part and a `blob`
 * part, in one multipart body. The declared size is the number of bytes actually being
 * sent — the server compares the two, because under-declaring would be a way around
 * the limit.
 *
 * **Open item, deliberately not papered over**: the API contract carries no envelope
 * fields for an attachment (no IV, key version or ciphertext parameters), so this
 * client cannot yet encrypt the bytes the way a note is encrypted. Until the sync
 * layer (P7) defines that, the caller supplies the bytes and this module does not
 * claim they are encrypted. It is recorded in HANDOFF §19.6 rather than described as
 * finished.
 */

export interface UploadedAttachment {
  id: string;
  markdown: string;
}

export interface AttachmentUploadInput {
  file: File;
  /** The bytes to send. The caller decides how they are produced. */
  bytes: Uint8Array;
  /** Extra headers, e.g. a CSRF token if one is not already on the document. */
  headers?: Record<string, string>;
}

export async function uploadAttachment(input: AttachmentUploadInput): Promise<UploadedAttachment> {
  const { file, bytes } = input;
  if (bytes.byteLength === 0) {
    throw new Error("The file is empty.");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Each file must be under ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const id = crypto.randomUUID();
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      id,
      name: file.name || "attachment",
      contentType: file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
    }),
  );
  form.set("blob", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), "blob");

  const response = await fetch("/api/v1/attachments", {
    method: "POST",
    body: form,
    headers: input.headers,
    credentials: "same-origin",
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: { attachment: { id: string } } }
    | { ok: false; error: { code: string } }
    | null;

  if (response.status === 413) {
    throw new Error(
      `Each file must be under ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
    );
  }
  if (!response.ok || !payload || payload.ok !== true) {
    // The code is passed through for the caller to branch on; an unrecognised one
    // becomes INTERNAL rather than being asserted into the union.
    const code = payload && payload.ok === false ? payload.error.code : "INTERNAL";
    throw new ApiError(
      code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INTERNAL",
      response.status,
    );
  }

  const createdId = payload.data.attachment.id;
  return { id: createdId, markdown: attachmentMarkdown(createdId, file.name) };
}
