import {
  bytesToBase64,
  encryptObject,
  generateDekRaw,
  importDek,
  utf8,
  type Bytes,
} from "@securenotes/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecureNotesDatabase } from "../local/schema";
import { pushChange } from "./client";

/**
 * Uploading what was encrypted offline (§7, §32).
 *
 * An attachment inserted with no network is encrypted and held on the device; the queue sends it later. The test
 * decrypts what the request actually carried, because the property that matters is not "an upload happened" but
 * "the bytes that went up are the ciphertext that was stored" — an upload of the wrong bytes would look identical
 * from the outside and be unreadable on every other device.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an attachment queued while offline", () => {
  /**
   * A database stand-in, because the unit under test reads and writes exactly one row.
   *
   * Going through IndexedDB here would test the environment: it clones a Blob into something without
   * `arrayBuffer()`, which a browser's Blob has and the end-to-end suite exercises for real.
   */
  function fakeDb(row: unknown) {
    const rows = new Map<string, unknown>([[attachmentIdOf(row), row]]);
    return {
      rows,
      db: {
        attachments: {
          get: async (id: string) => rows.get(id),
          put: async (value: { id: string }) => {
            rows.set(value.id, value);
          },
        },
      } as unknown as SecureNotesDatabase,
    };
  }

  function attachmentIdOf(row: unknown): string {
    return (row as { id: string }).id;
  }

  async function fixture() {
    const dek = await importDek(generateDekRaw());
    const attachmentId = "018f0000-0000-7000-8000-00000000eeee";
    const bytes = new Uint8Array([9, 8, 7, 6]) as Bytes;
    const envelope = await encryptObject(
      dek,
      { objectType: "attachment_blob", objectId: attachmentId, revision: 1, keyVersion: 1 },
      bytes,
    );
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (character) =>
      character.charCodeAt(0),
    ) as Bytes;
    return { dek, attachmentId, bytes, envelope, ciphertext };
  }

  it("uploads the stored ciphertext and marks the row synced", async () => {
    const { dek, attachmentId, bytes, envelope, ciphertext } = await fixture();
    const { db, rows } = fakeDb({
      id: attachmentId,
      r2Key: `attachments/${attachmentId}`,
      contentType: "image/png",
      sizeBytes: ciphertext.byteLength,
      name: await encryptObject(
        dek,
        { objectType: "attachment_meta", objectId: attachmentId, revision: 1, keyVersion: 1 },
        utf8("offline.png"),
      ),
      cachedBlob: { arrayBuffer: async () => ciphertext.buffer.slice(0) } as unknown as Blob,
      cachedAt: 1,
      contentIv: envelope.iv,
      plaintextSizeBytes: bytes.byteLength,
      // Chosen when the file was attached, and it has to survive until the upload happens: the queue may only drain
      // days later, on a device that was offline.
      expiresAt: 1_900_000_000_000,
      createdAt: 1,
      syncedAt: null,
    });

    let body: FormData | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        body = init.body as FormData;
        return new Response(
          JSON.stringify({ ok: true, data: { attachment: { id: attachmentId } } }),
          {
            status: 201,
          },
        );
      }),
    );

    const outcome = await pushChange(db, {
      id: 1,
      objectType: "attachment",
      objectId: attachmentId,
      operation: "create",
      baseRevision: null,
      queuedAt: 1,
      attempts: 0,
      nextAttemptAt: null,
    });

    expect(outcome).toBe("ok");
    const metadata = JSON.parse(String(body!.get("metadata")));
    expect(metadata.contentIv).toBe(envelope.iv);
    expect(metadata.sizeBytes).toBe(ciphertext.byteLength);
    expect(metadata.expiresAt).toBe(1_900_000_000_000);

    // The blob is the ciphertext that was stored, not something encrypted again on the way out: a second
    // encryption would bind the bytes to an IV the row does not record.
    const sent = new Uint8Array(await (body!.get("blob") as File).arrayBuffer());
    expect([...sent]).toEqual([...ciphertext]);
    expect(bytesToBase64(sent)).toBe(envelope.ciphertext);

    // And the row is marked confirmed, which is what takes the entry out of the queue.
    expect((rows.get(attachmentId) as { syncedAt: number | null }).syncedAt).not.toBeNull();
  });

  it("keeps the entry queued when the bytes are not on the device", async () => {
    const { attachmentId } = await fixture();
    const { db } = fakeDb({
      id: attachmentId,
      r2Key: `attachments/${attachmentId}`,
      contentType: "image/png",
      sizeBytes: 10,
      name: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "aXY=",
        ciphertext: "Y3Q=",
      },
      cachedBlob: null,
      cachedAt: null,
      contentIv: null,
      plaintextSizeBytes: null,
      createdAt: 1,
      syncedAt: null,
    });

    // Nothing to send: answering "ok" would drop the user's attachment, so the entry waits instead.
    expect(
      await pushChange(db, {
        id: 2,
        objectType: "attachment",
        objectId: attachmentId,
        operation: "create",
        baseRevision: null,
        queuedAt: 1,
        attempts: 0,
        nextAttemptAt: null,
      }),
    ).toBe("retry");
  });
});
