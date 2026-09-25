import { encryptObject, generateDekRaw, importDek, type Bytes } from "@securenotes/shared";
import { describe, expect, it } from "vitest";

import {
  ArchiveError,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildExportArchive,
  findCollisions,
  parseExportArchive,
  safeFilename,
  type ArchiveSources,
} from "./archive";
import { createZip, readZip } from "./zip";

/**
 * The export archive (§20).
 *
 * The round trip is the point: an export that cannot be read back is not a backup, so the tests build an
 * archive from encrypted rows and parse it again, and check that the notes come out as the text the user wrote.
 * The refusals matter as much — an import has to be able to reject an archive entirely, which is only possible
 * if every reason to reject it is found before anything is written.
 */

const NOTE_ID = "018f0000-0000-7000-8000-00000000000a";
const FOLDER_ID = "018f0000-0000-7000-8000-00000000000b";
const TAG_ID = "018f0000-0000-7000-8000-00000000000c";
const ATTACHMENT_ID = "018f0000-0000-7000-8000-00000000000d";

async function fixture() {
  const dek = await importDek(generateDekRaw());
  const noteText = `# Trip\n\nSee ![map.png](/api/v1/attachments/${ATTACHMENT_ID}/content)\n`;
  const sources: ArchiveSources = {
    notes: [
      {
        id: NOTE_ID,
        revision: 3,
        folderId: FOLDER_ID,
        pinned: true,
        sortOrder: 2,
        createdAt: 100,
        updatedAt: 200,
        payload: await encryptObject(
          dek,
          { objectType: "note", objectId: NOTE_ID, revision: 3, keyVersion: 1 },
          new TextEncoder().encode(noteText) as Bytes,
        ),
      },
    ],
    folders: [
      {
        id: FOLDER_ID,
        revision: 2,
        parentId: null,
        name: await encryptObject(
          dek,
          { objectType: "folder", objectId: FOLDER_ID, revision: 2, keyVersion: 1 },
          new TextEncoder().encode("Travel") as Bytes,
        ),
        sortOrder: 0,
      },
    ],
    tags: [
      {
        id: TAG_ID,
        name: await encryptObject(
          dek,
          { objectType: "tag", objectId: TAG_ID, revision: 1, keyVersion: 1 },
          new TextEncoder().encode("personal") as Bytes,
        ),
      },
    ],
    links: [{ noteId: NOTE_ID, tagId: TAG_ID }],
  };

  return {
    dek,
    sources,
    noteText,
    readAttachment: async () => ({
      bytes: new Uint8Array([1, 2, 3, 4]) as Bytes,
      contentType: "image/png",
      filename: "map.png",
    }),
  };
}

describe("building an export (§20)", () => {
  it("writes the note's text, its folder, its tags and its attachment", async () => {
    const { dek, sources, readAttachment, noteText } = await fixture();

    const { archive } = await buildExportArchive(sources, {
      dek,
      keyVersion: 1,
      readAttachment,
      now: 42,
    });

    expect(archive.manifest.format).toBe(EXPORT_FORMAT);
    expect(archive.manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(archive.manifest.encryption).toBe("none");
    expect(archive.manifest.exportedAt).toBe(42);
    expect(archive.notes[0]!.markdown).toBe(noteText);
    expect(archive.notes[0]!.tagIds).toEqual([TAG_ID]);
    expect(archive.folders[0]!.name).toBe("Travel");
    expect(archive.tags[0]!.name).toBe("personal");
    // The attachment comes from the note's own text, which is where the reference lives.
    expect(archive.attachments).toHaveLength(1);
    expect(archive.attachments[0]!.noteIds).toEqual([NOTE_ID]);
    expect([...archive.attachments[0]!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("reads back as it was written", async () => {
    const { dek, sources, readAttachment, noteText } = await fixture();
    const { bytes } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });

    const parsed = await parseExportArchive(bytes);

    expect(parsed.notes[0]!.markdown).toBe(noteText);
    expect(parsed.folders[0]!.name).toBe("Travel");
    expect(parsed.tags[0]!.name).toBe("personal");
    // The name comes from the note's own reference, which is the filename the user chose; the attachment's
    // stored name is the fallback.
    expect(parsed.attachments[0]!.filename).toBe("map.png");
    expect([...parsed.attachments[0]!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("produces a ZIP a person can open", async () => {
    const { dek, sources, readAttachment } = await fixture();
    const { bytes } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });

    const entries = [...(await readZip(bytes)).keys()];

    // The structure is documented in the archive itself, so a user with an unzip tool needs nothing else.
    expect(entries).toContain("README.txt");
    expect(entries).toContain("manifest.json");
    expect(entries).toContain(`notes/${NOTE_ID}.md`);
    expect(entries).toContain(`attachments/${ATTACHMENT_ID}/map.png`);
  });

  it("keeps a filename from escaping its directory", async () => {
    // The property rather than a literal: no separators survive, and no leading dot can turn an entry into a
    // hidden file. An output that satisfies both cannot address anything outside its own directory.
    for (const hostile of ["../../etc/passwd", "a/b\\c.png", "..\\..\\windows", "\u0000null"]) {
      const safe = safeFilename(hostile, "fallback");
      expect(safe).not.toMatch(/[/\\]/);
      expect(safe.startsWith(".")).toBe(false);
      expect(safe.length).toBeGreaterThan(0);
    }
    expect(safeFilename("", "fallback")).toBe("fallback");
    expect(safeFilename("map.png", "fallback")).toBe("map.png");
  });
});

describe("refusing an archive (§20)", () => {
  it("rejects something that is not an export", async () => {
    const zip = await createZip([
      { path: "hello.txt", bytes: new TextEncoder().encode("hi") as Bytes },
    ]);

    await expect(parseExportArchive(zip)).rejects.toThrow(/no manifest.json/);
  });

  it("rejects a format it does not know", async () => {
    const zip = await createZip([
      {
        path: "manifest.json",
        bytes: new TextEncoder().encode(JSON.stringify({ format: "something-else" })) as Bytes,
      },
    ]);

    await expect(parseExportArchive(zip)).rejects.toThrow(ArchiveError);
  });

  it("rejects an archive written by a newer version", async () => {
    const zip = await createZip([
      {
        path: "manifest.json",
        bytes: new TextEncoder().encode(
          JSON.stringify({ format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION + 1 }),
        ) as Bytes,
      },
    ]);

    // Silently dropping what it does not understand would be worse than refusing.
    await expect(parseExportArchive(zip)).rejects.toThrow(/newer version/);
  });

  it("rejects a note whose text is missing", async () => {
    const zip = await createZip([
      {
        path: "manifest.json",
        bytes: new TextEncoder().encode(
          JSON.stringify({ format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION }),
        ) as Bytes,
      },
      {
        path: "notes.json",
        bytes: new TextEncoder().encode(JSON.stringify([{ id: NOTE_ID }])) as Bytes,
      },
      { path: "folders.json", bytes: new TextEncoder().encode("[]") as Bytes },
      { path: "tags.json", bytes: new TextEncoder().encode("[]") as Bytes },
      { path: "attachments.json", bytes: new TextEncoder().encode("[]") as Bytes },
    ]);

    await expect(parseExportArchive(zip)).rejects.toThrow(/no text for note/);
  });

  it("rejects a note filed under a folder the archive lacks", async () => {
    const { dek, sources, readAttachment } = await fixture();
    const { bytes } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });
    const files = await readZip(bytes);
    const notes = JSON.parse(new TextDecoder().decode(files.get("notes.json")!));
    notes[0].folderId = "a-folder-that-is-not-here";
    files.set("notes.json", new TextEncoder().encode(JSON.stringify(notes)) as Bytes);
    const broken = await createZip([...files].map(([path, entry]) => ({ path, bytes: entry })));

    // Importing this would produce a note no later step could place.
    await expect(parseExportArchive(broken)).rejects.toThrow(/folder the archive does not contain/);
  });

  it("rejects an attachment that refers to a note the archive lacks", async () => {
    const { dek, sources, readAttachment } = await fixture();
    const { bytes } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });
    const files = await readZip(bytes);
    const attachments = JSON.parse(new TextDecoder().decode(files.get("attachments.json")!));
    attachments[0].noteIds = ["a-note-that-is-not-here"];
    files.set("attachments.json", new TextEncoder().encode(JSON.stringify(attachments)) as Bytes);
    const broken = await createZip([...files].map(([path, entry]) => ({ path, bytes: entry })));

    await expect(parseExportArchive(broken)).rejects.toThrow(
      /refers to a note the archive does not contain/,
    );
  });
});

describe("collisions (§20)", () => {
  it("reports what already exists here, per kind", async () => {
    const { dek, sources, readAttachment } = await fixture();
    const { archive } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });

    const collisions = findCollisions(archive, {
      noteIds: [NOTE_ID],
      folderIds: [],
      tagIds: [TAG_ID],
      attachmentIds: [],
    });

    // Reported rather than resolved: the user chooses between merging and remapping.
    expect(collisions.notes).toEqual([NOTE_ID]);
    expect(collisions.tags).toEqual([TAG_ID]);
    expect(collisions.folders).toEqual([]);
    expect(collisions.attachments).toEqual([]);
  });

  it("reports nothing for an archive that is entirely new", async () => {
    const { dek, sources, readAttachment } = await fixture();
    const { archive } = await buildExportArchive(sources, { dek, keyVersion: 1, readAttachment });

    const collisions = findCollisions(archive, {
      noteIds: [],
      folderIds: [],
      tagIds: [],
      attachmentIds: [],
    });

    expect(collisions).toEqual({ notes: [], folders: [], tags: [], attachments: [] });
  });
});
