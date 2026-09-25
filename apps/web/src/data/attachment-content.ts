import { bytesToBase64, decryptObject, type Bytes, type CryptoEnvelope } from "@securenotes/shared";

import { apiRequest } from "../api/client";
import { ATTACHMENT_URL_PREFIX } from "../editor/attachments";

/**
 * Showing an attachment (§7, §12).
 *
 * The server stores ciphertext and hands back ciphertext, so an `<img src="…/content">` points the browser at
 * bytes it cannot render — which is exactly what a broken image in a note is. The bytes have to be fetched,
 * decrypted here, and turned into something the browser can display.
 *
 * The IV lives with the attachment's metadata rather than in the content response, so reading an image takes
 * two requests: the row (for the IV and the content type) and the bytes. Both are cached per id, because a note
 * that shows the same image twice must not fetch it twice.
 *
 * Everything happens in the page with the key that never leaves it, and the result is a blob URL — not a data
 * URL, so a large image is not copied into the DOM as base64. Object URLs keep their bytes alive until they
 * are released, so the caller disposes them.
 */

export const ATTACHMENT_CONTENT_PATTERN = new RegExp(
  `${ATTACHMENT_URL_PREFIX}([0-9a-fA-F-]{36})/content`,
  "g",
);

/** The attachment ids a piece of HTML refers to, in order. */
export function attachmentIdsInHtml(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(ATTACHMENT_CONTENT_PATTERN)) {
    found.add(match[1]!);
  }
  return [...found];
}

/** The attachment id an address points at, or null when it is not an attachment address. */
export function attachmentIdFromUrl(url: string): string | null {
  // Not the shared global pattern: a single lookup must not depend on, or leave behind, lastIndex state.
  const match = new RegExp(`^${ATTACHMENT_URL_PREFIX}([0-9a-fA-F-]{36})/content$`).exec(url);
  return match ? match[1]! : null;
}

/**
 * Replaces attachment URLs with displayable ones.
 *
 * Pure and total: an id with no URL yet keeps its original address, so a note can be rendered immediately and
 * filled in as the images arrive — and one unreadable image does not hide the rest.
 */
export function rewriteAttachmentUrls(html: string, urlFor: (id: string) => string | null): string {
  return html.replace(ATTACHMENT_CONTENT_PATTERN, (whole, id: string) => urlFor(id) ?? whole);
}

export interface AttachmentUrls {
  /** A displayable URL, or null while it has not been read yet. */
  get(attachmentId: string): string | null;
  /** Reads whatever is missing. Never throws: an unreadable attachment keeps its original URL. */
  load(attachmentIds: readonly string[]): Promise<void>;
  /** Releases every URL created here. */
  dispose(): void;
}

export interface AttachmentUrlOptions {
  dek: CryptoKey;
  keyVersion: number;
  /** Overridden in tests, which have no server to read from. */
  readAttachment?: (attachmentId: string) => Promise<{ bytes: Bytes; contentType: string }>;
}

interface AttachmentMeta {
  attachment: { contentIv: string; contentType: string; cryptoVersion: number; keyVersion: number };
}

/**
 * The API-relative path of an attachment's metadata.
 *
 * `ATTACHMENT_URL_PREFIX` is the address a note's text carries, which already includes the API mount point.
 * The client adds that mount point itself, so passing the full prefix asked for `/api/v1/api/v1/attachments/…`
 * and every read answered 404 — the metadata, and therefore the IV, never arrived.
 */
function metadataPath(attachmentId: string): string {
  return `${ATTACHMENT_URL_PREFIX.replace(/^\/api\/v1/, "")}${attachmentId}`;
}

/** Fetches and decrypts one attachment, returning plaintext and the type the server recorded. */
export async function fetchAttachment(
  dek: CryptoKey,
  keyVersion: number,
  attachmentId: string,
): Promise<{ bytes: Bytes; contentType: string }> {
  const { attachment } = await apiRequest<AttachmentMeta>(metadataPath(attachmentId));
  const response = await fetch(`${ATTACHMENT_URL_PREFIX}${attachmentId}/content`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`the attachment could not be read (${response.status})`);
  }

  // The IV is filed with the metadata, so the envelope is assembled here: the content endpoint deliberately
  // returns bare ciphertext, and the AAD binds the blob to this attachment's id and revision.
  const envelope: CryptoEnvelope = {
    crypto_version: attachment.cryptoVersion,
    key_version: attachment.keyVersion,
    alg: "AES-256-GCM",
    iv: attachment.contentIv,
    ciphertext: bytesToBase64(new Uint8Array(await response.arrayBuffer()) as Bytes),
  };

  const plaintext = await decryptObject(
    dek,
    { objectType: "attachment_blob", objectId: attachmentId, revision: 1, keyVersion },
    envelope,
  );
  return { bytes: plaintext as Bytes, contentType: attachment.contentType };
}

export function createAttachmentUrls(options: AttachmentUrlOptions): AttachmentUrls {
  const urls = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const read =
    options.readAttachment ??
    ((id: string) => fetchAttachment(options.dek, options.keyVersion, id));

  const load = async (attachmentIds: readonly string[]): Promise<void> => {
    for (const id of attachmentIds) {
      if (urls.has(id) || inFlight.has(id)) {
        continue;
      }
      const work = read(id)
        .then(({ bytes, contentType }) => {
          urls.set(id, URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType })));
        })
        .catch((error: unknown) => {
          console.log(
            "[att] failed",
            id.slice(0, 8),
            error instanceof Error ? error.message : String(error),
          );
          // Left unread: the reference stays visible as a broken image rather than disappearing, which is the
          // honest outcome for content this device cannot decrypt.
        })
        .finally(() => {
          inFlight.delete(id);
        });
      inFlight.set(id, work);
      await work;
    }
  };

  return {
    get: (attachmentId) => urls.get(attachmentId) ?? null,
    load,
    dispose: () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    },
  };
}
