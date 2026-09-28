import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_RETENTION_MS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_TAGS_PER_NOTE,
} from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { attachmentQuotaProblem } from "../src/services/attachments";
import { purgeExpiredAttachments, purgeExpiredRecycleBin } from "../src/services/maintenance";
import {
  apiDownload,
  apiMultipart,
  authedRequest,
  createAccount,
  errorCode,
  loginOnce,
  resetRateLimits,
  testEnv,
  type CookieJar,
  type TestAccount,
} from "./support";

/**
 * Tags and attachments (§9, §10, §14).
 *
 * The behaviour that matters: set semantics for tags with a hard cap, tag
 * deletion touching relationships only, the upload ceiling being impossible to
 * understate, reference counting staying exact, and the R2 object only going away
 * after it is unreferenced.
 */

let account: TestAccount;
let jar: CookieJar;

const NAME = {
  crypto_version: 1,
  key_version: 1,
  alg: "AES-256-GCM" as const,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "Zm9v",
};

async function createTag(id: string) {
  return authedRequest<{ ok: true; data: { tag: { id: string } } }>("/tags", jar, {
    method: "POST",
    body: { id, name: NAME },
  });
}

async function createNote(id: string) {
  return authedRequest("/notes", jar, {
    method: "POST",
    body: { id, folderId: null, payload: NAME },
  });
}

/** Uploads an encrypted blob the way the client does: multipart/form-data. */
async function uploadAttachment(
  id: string,
  options: {
    bytes?: number;
    contentType?: string;
    declaredSize?: number;
    contentIv?: string;
    plaintextSizeBytes?: number;
    expiresAt?: number;
  } = {},
) {
  const bytes = new Uint8Array(options.bytes ?? 32).fill(7);
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      id,
      name: NAME,
      contentType: options.contentType ?? "image/png",
      sizeBytes: options.declaredSize ?? bytes.byteLength,
      // The content envelope (§7): a real IV and the plaintext size the ciphertext
      // was produced from, which the API checks against the tag length.
      contentIv: options.contentIv ?? "AAAAAAAAAAAAAAAA",
      plaintextSizeBytes:
        options.plaintextSizeBytes ?? (options.declaredSize ?? bytes.byteLength) - 16,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    }),
  );
  form.set("blob", new File([bytes], "blob.bin", { type: "application/octet-stream" }));

  const response = await apiMultipart("/attachments", form, jar);
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

beforeAll(async () => {
  account = await createAccount();
  jar = (await loginOnce(account)).jar;
});

beforeEach(resetRateLimits);

describe("tags (§9, §10)", () => {
  it("creates, lists, renames and deletes a tag", async () => {
    const created = await createTag("tag-a");
    expect(created.status).toBe(201);

    const listed = await authedRequest<{
      ok: true;
      data: { tags: Array<{ id: string }>; maxPerNote: number };
    }>("/tags", jar);
    expect(listed.body.data.tags.map((tag) => tag.id)).toContain("tag-a");
    expect(listed.body.data.maxPerNote).toBe(MAX_TAGS_PER_NOTE);

    const renamed = await authedRequest("/tags/tag-a", jar, {
      method: "PATCH",
      body: { name: { ...NAME, ciphertext: "bmV3" } },
    });
    expect(renamed.status).toBe(200);
    const stored = await testEnv.DB.prepare(
      "SELECT name_ciphertext AS ct FROM tags WHERE id = 'tag-a'",
    ).first<string>("ct");
    expect(stored).toBe("bmV3");

    const deleted = await authedRequest("/tags/tag-a", jar, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });

  it("replaces a note's tag set and enforces the cap", async () => {
    await createNote("tag-note");
    const ids = Array.from({ length: MAX_TAGS_PER_NOTE + 2 }, (_, index) => `tag-set-${index}`);
    for (const id of ids.slice(0, MAX_TAGS_PER_NOTE + 2)) {
      await createTag(id);
    }

    const tooMany = await authedRequest("/notes/tag-note/tags", jar, {
      method: "PUT",
      body: { tagIds: ids.slice(0, MAX_TAGS_PER_NOTE + 1) },
    });
    expect(tooMany.status).toBe(400);
    expect(errorCode(tooMany.body)).toBe("VALIDATION_FAILED");

    const atLimit = await authedRequest<{ ok: true; data: { tagIds: string[] } }>(
      "/notes/tag-note/tags",
      jar,
      { method: "PUT", body: { tagIds: ids.slice(0, MAX_TAGS_PER_NOTE) } },
    );
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.data.tagIds).toHaveLength(MAX_TAGS_PER_NOTE);

    // Set semantics: a smaller set replaces the previous one.
    const replaced = await authedRequest<{ ok: true; data: { tagIds: string[] } }>(
      "/notes/tag-note/tags",
      jar,
      { method: "PUT", body: { tagIds: ["tag-set-0"] } },
    );
    expect(replaced.body.data.tagIds).toEqual(["tag-set-0"]);
    const rows = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM note_tags WHERE note_id = 'tag-note'",
    ).first<number>("c");
    expect(rows).toBe(1);
  });

  it("deleting a tag removes relationships only (§9)", async () => {
    await createNote("tag-note-2");
    await createTag("tag-relations");
    await authedRequest("/notes/tag-note-2/tags", jar, {
      method: "PUT",
      body: { tagIds: ["tag-relations"] },
    });

    const deleted = await authedRequest<{ ok: true; data: { relationships: number } }>(
      "/tags/tag-relations",
      jar,
      { method: "DELETE" },
    );

    expect(deleted.body.data.relationships).toBe(1);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM note_tags WHERE tag_id = 'tag-relations'",
      ).first<number>("c"),
    ).toBe(0);
    // The note itself is untouched.
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM notes WHERE id = 'tag-note-2'",
      ).first<number>("c"),
    ).toBe(1);
  });

  it("refuses to attach another account's tag", async () => {
    const otherUser = "00000000-0000-7000-8000-000000000903";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at) VALUES (?1, 'tag-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO tags (id, user_id, name_iv, name_ciphertext, crypto_version, key_version, created_at, updated_at)
       VALUES ('tag-other', ?1, ?2, ?3, 1, 1, ?4, ?4)`,
    )
      .bind(otherUser, NAME.iv, NAME.ciphertext, Date.now())
      .run();

    await createNote("tag-note-3");
    const response = await authedRequest("/notes/tag-note-3/tags", jar, {
      method: "PUT",
      body: { tagIds: ["tag-other"] },
    });

    expect(response.status).toBe(404);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM note_tags WHERE tag_id = 'tag-other'",
      ).first<number>("c"),
    ).toBe(0);
  });
});

describe("attachments (§9, §14)", () => {
  it("stores an encrypted image and serves it back", async () => {
    const uploaded = await uploadAttachment("att-1");
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);

    const metadata = await authedRequest<{
      ok: true;
      data: { attachment: { sizeBytes: number; refCount: number } };
    }>("/attachments/att-1", jar);
    expect(metadata.body.data.attachment.sizeBytes).toBe(32);
    expect(metadata.body.data.attachment.refCount).toBe(0);

    const content = await apiDownload("/attachments/att-1/content", jar);
    expect(content.status).toBe(200);
    expect(content.headers.get("cache-control")).toBe("no-store");
    expect((await content.arrayBuffer()).byteLength).toBe(32);

    // The worker stored the bytes verbatim: it cannot decrypt them anyway.
    const object = await testEnv.ATTACHMENTS.get("attachments/att-1");
    expect(object).not.toBeNull();
  });

  it("rejects a declared size that disagrees with the upload", async () => {
    // Understating the size is how the 20 MB limit would be bypassed.
    const response = await uploadAttachment("att-lie", { bytes: 64, declaredSize: 10 });
    expect(response.status).toBe(400);
    expect(await testEnv.ATTACHMENTS.get("attachments/att-lie")).toBeNull();
  });

  it("accepts a file that is not an image (§9 as amended)", async () => {
    const response = await uploadAttachment("att-pdf", { contentType: "application/pdf" });
    expect(response.status).toBe(201);
  });

  it("rejects something that is not a media type at all", async () => {
    // The stored value is echoed back in a response header, so it must not be able to
    // carry one of its own.
    const plain = await uploadAttachment("att-not-a-type", { contentType: "plaintext" });
    expect(plain.status).toBe(415);

    const injected = await uploadAttachment("att-injected", {
      contentType: "text/plain\r\nX-Injected: 1",
    });
    expect(injected.status).toBe(415);
  });

  it("rejects an upload over the 60 MB ceiling", async () => {
    const response = await uploadAttachment("att-too-big", { bytes: MAX_ATTACHMENT_BYTES + 1 });
    expect(response.status).toBe(413);
  });

  it("keeps a temporary attachment only until its time is up (§9 as amended)", async () => {
    const expiry = Date.now() + 60_000;
    const uploaded = await uploadAttachment("att-temp", { expiresAt: expiry });
    expect(uploaded.status).toBe(201);
    // The expiry travels back, so a client can say when the file goes.
    expect(
      (uploaded.body as { data: { attachment: { expiresAt: number | null } } }).data.attachment
        .expiresAt,
    ).toBe(expiry);

    // Referenced, so the sweep has to remove the reference before the row can go.
    await createNote("att-temp-note");
    await authedRequest("/notes/att-temp-note/attachments", jar, {
      method: "POST",
      body: { attachmentId: "att-temp" },
    });
    expect(await testEnv.ATTACHMENTS.get("attachments/att-temp")).not.toBeNull();

    // A permanent attachment and one that has not expired yet are both left alone.
    await uploadAttachment("att-keep");
    await uploadAttachment("att-later", { expiresAt: Date.now() + 3_600_000 });

    // The clock is moved rather than waited on.
    await testEnv.DB.prepare("UPDATE attachments SET expires_at = ?1 WHERE id = 'att-temp'")
      .bind(Date.now() - 1000)
      .run();

    const purged = await purgeExpiredAttachments(testEnv, Date.now());
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await testEnv.ATTACHMENTS.get("attachments/att-temp")).toBeNull();
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM attachments WHERE id = 'att-temp'",
      ).first<number>("c"),
    ).toBe(0);
    // The reference had to go first: `note_attachments` restricts the delete.
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM note_attachments WHERE attachment_id = 'att-temp'",
      ).first<number>("c"),
    ).toBe(0);
    for (const kept of ["att-keep", "att-later"]) {
      expect(
        await testEnv.DB.prepare("SELECT count(*) AS c FROM attachments WHERE id = ?1")
          .bind(kept)
          .first<number>("c"),
      ).toBe(1);
    }
    // Other devices are told, exactly as they are for a deletion that was asked for.
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM sync_changes WHERE object_id = 'att-temp' AND change_type = 'delete'",
      ).first<number>("c"),
    ).toBe(1);
  });

  it("refuses an expiry in the past and one beyond the ceiling", async () => {
    const past = await uploadAttachment("att-past", { expiresAt: Date.now() - 1000 });
    expect(past.status).toBe(400);
    const far = await uploadAttachment("att-far", {
      expiresAt: Date.now() + MAX_ATTACHMENT_RETENTION_MS + 1000,
    });
    expect(far.status).toBe(400);
    expect(await testEnv.ATTACHMENTS.get("attachments/att-past")).toBeNull();
  });

  it("weighs an upload against what the account already stores (§9 as amended)", async () => {
    // The boundary, as a function: filling a database to five gigabytes would test the same arithmetic slowly.
    expect(attachmentQuotaProblem(0, MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(
      attachmentQuotaProblem(
        MAX_ATTACHMENT_TOTAL_BYTES - MAX_ATTACHMENT_BYTES,
        MAX_ATTACHMENT_BYTES,
      ),
    ).toBeNull();
    const problem = attachmentQuotaProblem(
      MAX_ATTACHMENT_TOTAL_BYTES - MAX_ATTACHMENT_BYTES + 1,
      MAX_ATTACHMENT_BYTES,
    );
    expect(problem).toContain("5 GB");
  });

  it("reports what the account stores, and refuses an upload that would exceed it", async () => {
    const usage = await authedRequest<{
      ok: true;
      data: { usedBytes: number; limitBytes: number };
    }>("/attachments/usage", jar);
    expect(usage.body.data.limitBytes).toBe(MAX_ATTACHMENT_TOTAL_BYTES);
    const before = usage.body.data.usedBytes;

    // Filled directly: the point is the arithmetic against the stored total, not the transfer of five gigabytes.
    // The account is looked up by name because this database holds every account the suite creates.
    const userId = await testEnv.DB.prepare("SELECT id FROM users WHERE username = ?1")
      .bind(account.username)
      .first<string>("id");
    const bulk = Array.from({ length: 86 }, (_, index) =>
      testEnv.DB.prepare(
        `INSERT INTO attachments
           (id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version, content_type, size_bytes, ref_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', '', 1, 1, 'image/png', ?4, 0, 0, 0)`,
      ).bind(`att-bulk-${index}`, userId, `bulk/${index}`, MAX_ATTACHMENT_BYTES),
    );
    await testEnv.DB.batch(bulk);

    const filled = await authedRequest<{ ok: true; data: { usedBytes: number } }>(
      "/attachments/usage",
      jar,
    );
    expect(filled.body.data.usedBytes).toBe(before + 86 * MAX_ATTACHMENT_BYTES);

    const refused = await uploadAttachment("att-over-quota");
    expect(refused.status).toBe(413);
    // The refusal happens before the object is written, so nothing is left behind to clean up.
    expect(await testEnv.ATTACHMENTS.get("attachments/att-over-quota")).toBeNull();

    await testEnv.DB.prepare("DELETE FROM attachments WHERE id LIKE 'att-bulk-%'").run();
    const restored = await authedRequest<{ ok: true; data: { usedBytes: number } }>(
      "/attachments/usage",
      jar,
    );
    expect(restored.body.data.usedBytes).toBe(before);
  });

  it("counts references and only enqueues deletion at zero (§9)", async () => {
    await uploadAttachment("att-refs");
    await createNote("att-note-1");
    await createNote("att-note-2");

    for (const noteId of ["att-note-1", "att-note-2"]) {
      const linked = await authedRequest("/notes/" + noteId + "/attachments", jar, {
        method: "POST",
        body: { attachmentId: "att-refs" },
      });
      expect(linked.status).toBe(200);
    }

    const linked = await testEnv.DB.prepare(
      "SELECT ref_count AS c FROM attachments WHERE id = 'att-refs'",
    ).first<number>("c");
    expect(linked).toBe(2);

    const first = await authedRequest<{
      ok: true;
      data: { refCount: number; deletionEnqueued: boolean };
    }>("/notes/att-note-1/attachments/att-refs", jar, { method: "DELETE" });
    expect(first.body.data.refCount).toBe(1);
    expect(first.body.data.deletionEnqueued).toBe(false);
    // Still referenced by the other note, so the object stays.
    expect(await testEnv.ATTACHMENTS.get("attachments/att-refs")).not.toBeNull();

    const second = await authedRequest<{
      ok: true;
      data: { refCount: number; deletionEnqueued: boolean };
    }>("/notes/att-note-2/attachments/att-refs", jar, { method: "DELETE" });
    expect(second.body.data.refCount).toBe(0);
    expect(second.body.data.deletionEnqueued).toBe(true);

    // The deletion is asynchronous: enqueued, not performed inline (§9).
    expect(await testEnv.ATTACHMENTS.get("attachments/att-refs")).not.toBeNull();

    const purged = await purgeExpiredAttachments(testEnv, Date.now());
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await testEnv.ATTACHMENTS.get("attachments/att-refs")).toBeNull();
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM attachments WHERE id = 'att-refs'",
      ).first<number>("c"),
    ).toBe(0);

    // Idempotent: a second sweep has nothing left to do.
    expect(await purgeExpiredAttachments(testEnv, Date.now())).toBe(0);
  });

  it("refuses to link another account's attachment", async () => {
    const otherUser = "00000000-0000-7000-8000-000000000904";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at) VALUES (?1, 'att-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO attachments (id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version, content_type, size_bytes, ref_count, created_at, updated_at)
       VALUES ('att-other', ?1, 'attachments/att-other', ?2, ?3, 1, 1, 'image/png', 10, 0, ?4, ?4)`,
    )
      .bind(otherUser, NAME.iv, NAME.ciphertext, Date.now())
      .run();
    await createNote("att-note-3");

    const response = await authedRequest("/notes/att-note-3/attachments", jar, {
      method: "POST",
      body: { attachmentId: "att-other" },
    });
    expect(response.status).toBe(404);
  });
});

describe("retention sweeps (§19)", () => {
  it("permanently deletes only notes past the recycle-bin window", async () => {
    await createNote("bin-old");
    await createNote("bin-fresh");
    await authedRequest("/notes/bin-old", jar, { method: "DELETE" });
    await authedRequest("/notes/bin-fresh", jar, { method: "DELETE" });

    // Backdate one of them past the 30-day retention window.
    await testEnv.DB.prepare("UPDATE notes SET deleted_at = ?2 WHERE id = ?1")
      .bind("bin-old", Date.now() - 40 * 24 * 60 * 60 * 1000)
      .run();

    const purged = await purgeExpiredRecycleBin(testEnv, Date.now());

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM notes WHERE id = 'bin-old'",
      ).first<number>("c"),
    ).toBe(0);
    // The fresh one is still recoverable, which is the whole point of the window.
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS c FROM notes WHERE id = 'bin-fresh'",
      ).first<number>("c"),
    ).toBe(1);
  });
});

describe("attachment content envelope (§7, §12)", () => {
  it("records the IV the bytes were encrypted with", async () => {
    const uploaded = await uploadAttachment("att-env-1", { contentIv: "BBBBBBBBBBBBBBBB" });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);

    const row = await testEnv.DB.prepare(
      "SELECT content_iv, plaintext_size_bytes, size_bytes FROM attachments WHERE id = 'att-env-1'",
    ).first<{ content_iv: string; plaintext_size_bytes: number; size_bytes: number }>();

    // Without the IV the uploaded bytes could never be decrypted again.
    expect(row?.content_iv).toBe("BBBBBBBBBBBBBBBB");
    expect(row?.plaintext_size_bytes).toBe(16);
    expect(row?.size_bytes).toBe(32);
  });

  it("refuses an upload with no content IV", async () => {
    const uploaded = await uploadAttachment("att-env-2", { contentIv: "" });

    expect(uploaded.status).toBe(400);
  });

  it("refuses a plaintext size that contradicts the ciphertext size", async () => {
    // Claiming 32 bytes of plaintext for 32 bytes of ciphertext is an inconsistent
    // envelope: AES-GCM output is always 16 bytes longer.
    const uploaded = await uploadAttachment("att-env-3", { plaintextSizeBytes: 32 });

    expect(uploaded.status).toBe(400);
  });

  it("still refuses a declared size that does not match the upload", async () => {
    // Under-declaring remains a way around the size limit, so it stays rejected.
    const uploaded = await uploadAttachment("att-env-4", { declaredSize: 24 });

    expect(uploaded.status).not.toBe(201);
  });

  it("returns a format marker unchanged, which is what keeps an animation animated", async () => {
    // The property under test is the byte round trip: anything that re-encoded the
    // content would drop the marker below and an animated image would go still.
    const gif = new Uint8Array([
      ...new TextEncoder().encode("GIF89a"),
      ...new Uint8Array(2),
      0x21,
      0xff,
      0x0b,
      ...new TextEncoder().encode("NETSCAPE2.0"),
      0x03,
      0x01,
      0x00,
      0x00,
      0x00,
      ...new Uint8Array(2),
    ]);

    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        id: "att-env-gif",
        name: NAME,
        contentType: "image/gif",
        sizeBytes: gif.byteLength,
        contentIv: "CCCCCCCCCCCCCCCC",
        plaintextSizeBytes: gif.byteLength - 16,
      }),
    );
    form.set("blob", new File([gif], "blob.bin", { type: "application/octet-stream" }));
    const upload = await apiMultipart("/attachments", form, jar);
    expect(upload.status, await upload.text()).toBe(201);

    const content = await apiDownload("/attachments/att-env-gif/content", jar);
    expect(content.status).toBe(200);
    const served = new Uint8Array(await content.arrayBuffer());

    expect([...served]).toEqual([...gif]);
    expect(new TextDecoder().decode(served.slice(0, 6))).toBe("GIF89a");
    expect(new TextDecoder().decode(served)).toContain("NETSCAPE2.0");
  });
});

describe("the attachment wire shape", () => {
  it("carries what a client needs to decrypt the content", async () => {
    const id = "018f0000-0000-7000-8000-0000000000aa";
    await uploadAttachment(id);

    const response = await authedRequest<{
      ok: true;
      data: {
        attachment: {
          contentIv: string;
          cryptoVersion: number;
          keyVersion: number;
          contentType: string;
        };
      };
    }>(`/attachments/${id}`, jar);

    // The content response is bare ciphertext, so the IV and the versions can only come from the metadata.
    // Without them no device can assemble the envelope, and every image in a note is a broken picture.
    expect(response.body.data.attachment.contentIv).toBe("AAAAAAAAAAAAAAAA");
    expect(response.body.data.attachment.cryptoVersion).toBeGreaterThanOrEqual(1);
    expect(response.body.data.attachment.keyVersion).toBeGreaterThanOrEqual(1);
    expect(response.body.data.attachment.contentType).toBe("image/png");
  });
});
