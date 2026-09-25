import { encryptObject, generateDekRaw, importDek, type Bytes } from "@securenotes/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAttachment } from "./attachment-content";
import {
  ATTACHMENT_CONTENT_PATTERN,
  attachmentIdsInHtml,
  createAttachmentUrls,
  rewriteAttachmentUrls,
} from "./attachment-content";

vi.mock("../api/client", () => ({
  apiRequest: vi.fn(),
}));

/**
 * Showing an attachment (§7, §12).
 *
 * The property that matters is that what the browser is handed is the *decrypted* image: the server returns
 * ciphertext, so an <img> pointing at the endpoint is a broken image, and a rewrite that produces a URL for
 * something that cannot be rendered would be just as broken while looking correct in the markup.
 */

const ID = "018f0000-0000-7000-8000-00000000aaaa";
const OTHER = "018f0000-0000-7000-8000-00000000bbbb";

async function fixture() {
  const dek = await importDek(generateDekRaw());
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]) as Bytes;
  const envelope = await encryptObject(
    dek,
    { objectType: "attachment_blob", objectId: ID, revision: 1, keyVersion: 1 },
    bytes,
  );
  return { dek, bytes, envelope };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finding references", () => {
  it("collects the attachment ids an HTML fragment refers to", () => {
    const html = `<img src="/api/v1/attachments/${ID}/content"><a href="/api/v1/attachments/${OTHER}/content">x</a>`;

    expect(attachmentIdsInHtml(html).sort()).toEqual([ID, OTHER].sort());
  });

  it("ignores anything that is not an attachment", () => {
    expect(attachmentIdsInHtml('<img src="https://example.com/a.png">')).toEqual([]);
  });

  it("does not carry state between calls", () => {
    // The pattern has the global flag, so a stale lastIndex would silently skip matches on the second call.
    const html = `<img src="/api/v1/attachments/${ID}/content">`;

    expect(attachmentIdsInHtml(html)).toHaveLength(1);
    expect(attachmentIdsInHtml(html)).toHaveLength(1);
    expect(ATTACHMENT_CONTENT_PATTERN.lastIndex).toBe(0);
  });
});

describe("rewriting references", () => {
  it("replaces only what it can display", () => {
    const html = `<img src="/api/v1/attachments/${ID}/content"><img src="/api/v1/attachments/${OTHER}/content">`;

    const rewritten = rewriteAttachmentUrls(html, (id) => (id === ID ? "blob:abc" : null));

    expect(rewritten).toContain('src="blob:abc"');
    // The unread one keeps its address, so the reference is still there to retry.
    expect(rewritten).toContain(`/api/v1/attachments/${OTHER}/content`);
  });
});

describe("resolving content", () => {
  it("hands the browser the decrypted bytes, not the ciphertext", async () => {
    const { dek, bytes, envelope } = await fixture();
    const created: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return "blob:one";
      },
      revokeObjectURL: () => undefined,
    });

    const urls = createAttachmentUrls({
      dek,
      keyVersion: 1,
      // The reader is expected to hand back plaintext: it is the seam that decrypts.
      readAttachment: async () => ({ bytes, contentType: "image/png" }),
    });

    await urls.load([ID]);

    expect(urls.get(ID)).toBe("blob:one");
    // The blob is the plaintext: a test that only saw a blob URL would not notice a ciphertext being shown.
    const shown = new Uint8Array(await created[0]!.arrayBuffer());
    expect([...shown]).toEqual([...bytes]);
    // And explicitly not the ciphertext, which is what the server stores.
    expect([...shown]).not.toEqual([
      ...Uint8Array.from(atob(envelope.ciphertext), (character) => character.charCodeAt(0)),
    ]);
    expect(created[0]!.type).toBe("image/png");
    urls.dispose();
  });

  it("reads each attachment once, however often it is asked for", async () => {
    const { dek, bytes } = await fixture();
    const reader = vi.fn(async () => ({ bytes, contentType: "image/png" }));
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:one",
      revokeObjectURL: () => undefined,
    });
    const urls = createAttachmentUrls({ dek, keyVersion: 1, readAttachment: reader });

    await urls.load([ID, ID]);
    await urls.load([ID]);

    expect(reader).toHaveBeenCalledTimes(1);
    urls.dispose();
  });

  it("leaves an unreadable attachment unread rather than throwing", async () => {
    const { dek } = await fixture();
    const urls = createAttachmentUrls({
      dek,
      keyVersion: 1,
      readAttachment: async () => {
        throw new Error("the attachment could not be decrypted");
      },
    });

    // A note with one bad image must still show the rest, and the caller must not have to guard every call.
    await expect(urls.load([ID])).resolves.toBeUndefined();
    expect(urls.get(ID)).toBeNull();
    urls.dispose();
  });

  it("releases its object URLs", async () => {
    const { dek, bytes } = await fixture();
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:one",
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    const urls = createAttachmentUrls({
      dek,
      keyVersion: 1,
      readAttachment: async () => ({ bytes, contentType: "image/png" }),
    });

    await urls.load([ID]);
    urls.dispose();

    // An object URL pins its bytes until it is revoked, so leaving them behind leaks one image per note.
    expect(revoked).toEqual(["blob:one"]);
    expect(urls.get(ID)).toBeNull();
  });
});

describe("assembling the envelope", () => {
  it("binds the content to the attachment's own AAD", async () => {
    const { dek, bytes, envelope } = await fixture();
    // The AAD includes the id, so content encrypted for another attachment must not decrypt under this one.
    const decrypt = async (objectId: string) =>
      import("@securenotes/shared").then(({ decryptObject }) =>
        decryptObject(
          dek,
          { objectType: "attachment_blob", objectId, revision: 1, keyVersion: 1 },
          envelope,
        ),
      );

    await expect(decrypt(ID)).resolves.toEqual(bytes);
    await expect(decrypt(OTHER)).rejects.toThrow();
  });

  it("assembles the envelope from the metadata's IV and the content response", async () => {
    const { dek, bytes, envelope } = await fixture();
    const { apiRequest } = await import("../api/client");
    vi.mocked(apiRequest).mockResolvedValue({
      attachment: {
        contentIv: envelope.iv,
        contentType: "image/png",
        cryptoVersion: 1,
        keyVersion: 1,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            Uint8Array.from(atob(envelope.ciphertext), (character) => character.charCodeAt(0)),
            {
              status: 200,
            },
          ),
      ),
    );

    // The IV is not in the content response, so this is where a missing field shows up: without it the
    // envelope cannot be assembled and every attachment is unreadable.
    await expect(fetchAttachment(dek, 1, ID)).resolves.toEqual({ bytes, contentType: "image/png" });
    vi.unstubAllGlobals();
  });
});
