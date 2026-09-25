import { describe, expect, it } from "vitest";

import { canCompress, createZip, crc32, readZip } from "./zip";

/**
 * The archive format (§20).
 *
 * Two properties matter. The bytes have to come back exactly as they went in — an import validates what it
 * finds, and a reader that mangles a note would have it rejected for the wrong reason. And the file has to be a
 * real ZIP, understood by tools that have never heard of this application, because that is the whole point of
 * exporting to one.
 */

const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

describe("CRC-32", () => {
  it("matches the value the format is defined against", () => {
    // The check value every implementation is tested with.
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
  });

  it("reports zero for nothing", () => {
    expect(crc32(bytes(""))).toBe(0);
  });
});

describe("writing and reading", () => {
  it("returns every entry unchanged", async () => {
    const archive = await createZip([
      { path: "manifest.json", bytes: bytes('{"format":"securenotes-export"}') },
      { path: "notes/a.md", bytes: bytes("# A\n\nbody\n") },
    ]);

    const files = await readZip(archive);

    expect([...files.keys()].sort()).toEqual(["manifest.json", "notes/a.md"]);
    expect(new TextDecoder().decode(files.get("notes/a.md")!)).toBe("# A\n\nbody\n");
  });

  it("keeps names that need UTF-8", async () => {
    const archive = await createZip([{ path: "attachments/中文-文件名.png", bytes: bytes("x") }]);

    const files = await readZip(archive);

    // A title or a filename with non-ASCII characters is ordinary, and the flag that says so is what keeps it
    // readable instead of mojibake.
    expect([...files.keys()]).toEqual(["attachments/中文-文件名.png"]);
  });

  it("round-trips binary content byte for byte", async () => {
    const raw = new Uint8Array(1024);
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = (index * 7) % 256;
    }

    const files = await readZip(
      await createZip([{ path: "blob.bin", bytes: raw as Uint8Array<ArrayBuffer> }]),
    );

    expect([...files.get("blob.bin")!]).toEqual([...raw]);
  });

  it("handles an empty archive", async () => {
    // A fresh account exports nothing, and that is not an error.
    expect((await readZip(await createZip([]))).size).toBe(0);
  });

  it("rejects something that is not an archive", async () => {
    await expect(readZip(bytes("not a zip at all"))).rejects.toThrow(/not a ZIP file/);
  });

  it("carries its entry count in the index", async () => {
    const archive = await createZip([
      { path: "a", bytes: bytes("1") },
      { path: "b", bytes: bytes("2") },
      { path: "c", bytes: bytes("3") },
    ]);

    // The end-of-central-directory record is the last thing in the file, and the count is part of it.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const endOffset = archive.byteLength - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 10, true)).toBe(3);
    expect(await readZip(archive)).toHaveLength(3);
  });
});

describe("compression", () => {
  it("reads back an archive it stored", async () => {
    // Store is always available, so it is the path that must work everywhere.
    const archive = await createZip([{ path: "a.txt", bytes: bytes("stored") }], {
      compress: false,
    });

    const files = await readZip(archive);

    expect(new TextDecoder().decode(files.get("a.txt")!)).toBe("stored");
  });

  it("reads back an archive it deflated, when the platform can", async () => {
    if (!canCompress()) {
      // Not a silent skip: the stored path above covers the format here.
      expect(typeof CompressionStream).toBe("undefined");
      return;
    }
    const archive = await createZip([{ path: "a.txt", bytes: bytes("deflated ".repeat(200)) }]);

    const files = await readZip(archive);

    // 1800 bytes of repetitive text: compressing is worth doing for the exports a user backs up.
    expect(archive.byteLength).toBeLessThan(1800);
    expect(new TextDecoder().decode(files.get("a.txt")!)).toBe("deflated ".repeat(200));
  });
});
