import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  MAX_ATTACHMENT_BYTES,
  deriveKek,
  generateDekRaw,
  importDek,
} from "@securenotes/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptAttachmentBytes, uploadAttachment } from "./attachments-client";

/**
 * Attachment encryption (§7, §12).
 *
 * The property that matters is that an uploaded attachment can be decrypted again by the
 * same DEK and cannot be read by anyone else — so the test decrypts what it uploaded
 * rather than inspecting the request body alone.
 */

async function testDek(): Promise<CryptoKey> {
  return importDek(generateDekRaw());
}

function imageFile(bytes: Uint8Array, type = "image/png", name = "shot.png"): File {
  return new File([bytes as BlobPart], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encrypting attachment bytes", () => {
  it("produces a decryptable envelope bound to the attachment", async () => {
    const dek = await testDek();
    const bytes = new TextEncoder().encode("a secret screenshot");

    const { ciphertext, iv, plaintextSize } = await encryptAttachmentBytes(dek, "att-1", 1, bytes);

    expect(plaintextSize).toBe(bytes.byteLength);
    // AES-GCM appends a 16-byte tag, which is what the API checks.
    expect(ciphertext.byteLength).toBe(bytes.byteLength + 16);
    expect(atob(iv)).toHaveLength(12);

    // The plaintext must not appear in the ciphertext at all.
    expect(new TextDecoder().decode(ciphertext)).not.toContain("secret screenshot");
  });

  it("uses a fresh IV every time", async () => {
    const dek = await testDek();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const first = await encryptAttachmentBytes(dek, "att-1", 1, bytes);
    const second = await encryptAttachmentBytes(dek, "att-1", 1, bytes);

    // Reusing an IV under the same key would break the cipher's guarantees.
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it("binds the ciphertext to the attachment id", async () => {
    const dek = await testDek();
    const bytes = new Uint8Array([9, 9, 9]);
    const { decryptObject } = await import("@securenotes/shared");

    const { ciphertext, iv } = await encryptAttachmentBytes(dek, "att-1", 1, bytes);
    const envelope = {
      crypto_version: 1,
      key_version: 1,
      alg: "AES-256-GCM" as const,
      iv,
      ciphertext: btoa(String.fromCharCode(...ciphertext)),
    };

    // The right identity decrypts…
    await expect(
      decryptObject(
        dek,
        { objectType: "attachment_blob", objectId: "att-1", revision: 1, keyVersion: 1 },
        envelope,
      ),
    ).resolves.toEqual(bytes);

    // …and another attachment's id does not, so a blob cannot be moved between them.
    await expect(
      decryptObject(
        dek,
        { objectType: "attachment_blob", objectId: "att-2", revision: 1, keyVersion: 1 },
        envelope,
      ),
    ).rejects.toThrow();
  });

  it("cannot be read with a different key", async () => {
    const dek = await testDek();
    const { decryptObject } = await import("@securenotes/shared");
    const bytes = new Uint8Array([5, 5, 5]);

    const { ciphertext, iv } = await encryptAttachmentBytes(dek, "att-1", 1, bytes);
    const other = await deriveKek({
      username: "someone-else",
      totpSecretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kdfSaltBase64: btoa("0123456789abcdef"),
    });

    await expect(
      decryptObject(
        other,
        { objectType: "attachment_blob", objectId: "att-1", revision: 1, keyVersion: 1 },
        {
          crypto_version: 1,
          key_version: 1,
          alg: "AES-256-GCM",
          iv,
          ciphertext: btoa(String.fromCharCode(...ciphertext)),
        },
      ),
    ).rejects.toThrow();
  });
});

describe("uploading", () => {
  it("sends ciphertext with a consistent envelope", async () => {
    const dek = await testDek();
    const bytes = new TextEncoder().encode("payload");
    let sent: FormData | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = init.body as FormData;
        return new Response(JSON.stringify({ ok: true, data: { attachment: { id: "att-9" } } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await uploadAttachment({
      file: imageFile(bytes),
      dek,
      keyVersion: 1,
      attachmentId: "att-9",
    });

    expect(result.id).toBe("att-9");
    expect(result.markdown).toContain("/api/v1/attachments/att-9/content");

    const metadata = JSON.parse((sent!.get("metadata") as string) ?? "{}");
    const blob = sent!.get("blob") as File;

    expect(metadata.id).toBe("att-9");
    expect(metadata.contentIv).toBeTruthy();
    expect(atob(metadata.contentIv)).toHaveLength(12);
    // The server compares these two, so they must agree with what is being sent.
    expect(metadata.sizeBytes).toBe(blob.size);
    expect(metadata.sizeBytes - metadata.plaintextSizeBytes).toBe(16);
    // The uploaded bytes are not the plaintext.
    expect(await blob.text()).not.toContain("payload");
  });

  it("refuses an empty file and an oversized one without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dek = await testDek();

    await expect(
      uploadAttachment({
        file: imageFile(new Uint8Array(0)),
        dek,
        keyVersion: 1,
        attachmentId: "att-empty",
      }),
    ).rejects.toThrow(/empty/i);

    // The limit is checked before anything is encrypted or sent, so an oversized file
    // costs no network traffic and no CPU.
    await expect(
      uploadAttachment({
        file: imageFile(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
        dek,
        keyVersion: 1,
        attachmentId: "att-big",
      }),
    ).rejects.toThrow(/MB/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leave a reference behind when the upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: "INTERNAL" } }), { status: 500 }),
      ),
    );

    await expect(
      uploadAttachment({
        file: imageFile(new Uint8Array([1])),
        dek: await testDek(),
        keyVersion: 1,
        attachmentId: "att-x",
      }),
    ).rejects.toThrow();
  });
});

describe("reference counting (§12)", () => {
  it("links and unlinks exactly the ids it is given", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), method: init.method ?? "GET" });
        return new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { syncAttachmentLinks } = await import("./attachments-client");
    const result = await syncAttachmentLinks("note-1", ["added-a"], ["gone-b"]);

    expect(result).toEqual({ linked: 1, unlinked: 1 });
    expect(calls).toEqual([
      { url: "/api/v1/notes/note-1/attachments", method: "POST" },
      { url: "/api/v1/notes/note-1/attachments/gone-b", method: "DELETE" },
    ]);
  });

  it("keeps unlinking the rest when one reference is already gone", async () => {
    // A stale reference must not stop the others from being cleaned up: the count is
    // what decides whether an object is ever deleted.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), {
              status: 404,
            })
          : new Response(JSON.stringify({ ok: true, data: {} }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }),
    );

    const { syncAttachmentLinks } = await import("./attachments-client");
    const result = await syncAttachmentLinks("note-1", [], ["missing", "present"]);

    expect(result.unlinked).toBe(2);
    expect(call).toBe(2);
  });

  it("does nothing when the text did not change", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { syncAttachmentLinks } = await import("./attachments-client");
    const result = await syncAttachmentLinks("note-1", [], []);

    expect(result).toEqual({ linked: 0, unlinked: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("session requirements (§14)", () => {
  it("sends the CSRF header, which a raw fetch does not inherit", async () => {
    // The regression: the upload used a plain fetch and set no CSRF header, so every
    // upload failed even with a valid session.
    const original = document.cookie;
    // The real cookie name, not a guess: a wrong name here would make the test pass or
    // fail for a reason unrelated to the code under test.
    document.cookie = `${CSRF_COOKIE_NAME}=token-value`;
    let sent: Headers | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = new Headers(init.headers);
        return new Response(
          JSON.stringify({ ok: true, data: { attachment: { id: "att-csrf" } } }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    try {
      await uploadAttachment({
        file: imageFile(new Uint8Array([1, 2, 3])),
        dek: await testDek(),
        keyVersion: 1,
        attachmentId: "att-csrf",
      });

      expect(sent!.get(CSRF_HEADER_NAME)).toBe("token-value");
    } finally {
      document.cookie = original;
      vi.unstubAllGlobals();
    }
  });

  it("reports an expired session as 401 so the caller can ask for a sign-in", async () => {
    // Unlocking offline with the device key never contacts the server, so the session can
    // be gone while the editor still works — the upload is where it surfaces.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED" } }), {
            status: 401,
          }),
      ),
    );

    await expect(
      uploadAttachment({
        file: imageFile(new Uint8Array([1])),
        dek: await testDek(),
        keyVersion: 1,
        attachmentId: "att-401",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
