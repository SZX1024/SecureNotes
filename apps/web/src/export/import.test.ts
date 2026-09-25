import { decryptObject, generateDekRaw, importDek, utf8, type Bytes } from "@securenotes/shared";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { readLocalNote } from "../data/repository";
import { aadFor } from "../local/aad";
import { databaseNameFor, openDatabase, type SecureNotesDatabase } from "../local/schema";
import type { ExportArchive } from "./archive";
import { applyImport, planImport, type ImportPlan } from "./import";

/**
 * Importing an archive (§20).
 *
 * The requirement is specific: *transactional*, with duplicate ids decided by the user rather than by this code.
 * So the tests come in two halves — what the plan decides, on plain data, and what happens to the database when
 * applying it fails part way through. The second is the acceptance criterion, and it is the one that cannot be
 * argued from reading the code: a rollback has to be observed.
 */

let sequence = 0;

const bytes = (text: string) => utf8(text) as Bytes;

async function freshDb() {
  const name = `${databaseNameFor(4)}-import-${(sequence += 1)}`;
  const db = openDatabase(name);
  await db.open();
  return {
    db,
    close: async () => {
      db.close();
      await Dexie.delete(name).catch(() => undefined);
    },
  };
}

function archiveOf(overrides: Partial<ExportArchive> = {}): ExportArchive {
  return {
    manifest: {
      format: "securenotes-export",
      formatVersion: 1,
      exportedAt: 1_000,
      encryption: "none",
      counts: { notes: 1, folders: 0, tags: 0, attachments: 0 },
    },
    notes: [
      {
        id: "note-1",
        folderId: null,
        tagIds: [],
        pinned: false,
        sortOrder: 0,
        createdAt: 100,
        updatedAt: 200,
        markdown: "# From the archive\n\nbody\n",
      },
    ],
    folders: [],
    tags: [],
    attachments: [],
    ...overrides,
  };
}

const noExisting = { noteIds: [], folderIds: [], tagIds: [] };

describe("planning an import (§20)", () => {
  it("adds everything when nothing collides", () => {
    const plan = planImport({
      archive: archiveOf({
        folders: [{ id: "folder-1", parentId: null, name: "Travel", sortOrder: 0 }],
        tags: [{ id: "tag-1", name: "personal" }],
        notes: [
          {
            id: "note-1",
            folderId: "folder-1",
            tagIds: ["tag-1"],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# A\n",
          },
        ],
      }),
      existing: noExisting,
      existingNotes: [],
      choice: "merge",
      newId: () => "unused",
    });

    expect(plan.counts).toEqual({ created: 3, merged: 0, remapped: 0, unchanged: 0 });
    expect(plan.notes[0]!.tagIds).toEqual(["tag-1"]);
  });

  it("keeps the newer text when a note collides", () => {
    const archive = archiveOf();

    const localIsNewer = planImport({
      archive,
      existing: { ...noExisting, noteIds: ["note-1"] },
      existingNotes: [{ id: "note-1", updatedAt: 900, tagIds: [] }],
      choice: "merge",
      newId: () => "unused",
    });
    // Nothing to change: the local note is newer and carries the same tags.
    expect(localIsNewer.counts.unchanged).toBe(1);
    expect(localIsNewer.notes).toHaveLength(0);

    const archiveIsNewer = planImport({
      archive,
      existing: { ...noExisting, noteIds: ["note-1"] },
      existingNotes: [{ id: "note-1", updatedAt: 100, tagIds: [] }],
      choice: "merge",
      newId: () => "unused",
    });
    // Replaced, and the plan says so rather than doing it silently.
    expect(archiveIsNewer.counts.merged).toBe(1);
    expect(archiveIsNewer.notes[0]!.markdown).toBe("# From the archive\n\nbody\n");
    expect(archiveIsNewer.mergedIds.notes).toEqual(["note-1"]);
  });

  it("unions the tags of a merged note and leaves its text alone", () => {
    const plan = planImport({
      archive: archiveOf({
        tags: [{ id: "tag-1", name: "personal" }],
        notes: [
          {
            id: "note-1",
            folderId: null,
            tagIds: ["tag-1"],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# Older\n",
          },
        ],
      }),
      existing: { ...noExisting, tagIds: ["tag-1"], noteIds: ["note-1"] },
      existingNotes: [{ id: "note-1", updatedAt: 900, tagIds: ["tag-1"] }],
      choice: "merge",
      newId: () => "unused",
    });

    // Nothing changed: the tag was already there and the local text is newer.
    expect(plan.counts.unchanged).toBe(2);
  });

  it("gives colliding objects new ids when remapping, and rewrites the references", () => {
    let counter = 0;
    const plan = planImport({
      archive: archiveOf({
        folders: [{ id: "folder-1", parentId: null, name: "Travel", sortOrder: 0 }],
        tags: [{ id: "tag-1", name: "personal" }],
        attachments: [
          {
            id: "attachment-1",
            filename: "map.png",
            contentType: "image/png",
            noteIds: ["note-1"],
            bytes: bytes("png"),
          },
        ],
        notes: [
          {
            id: "note-1",
            folderId: "folder-1",
            tagIds: ["tag-1"],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# A\n",
          },
        ],
      }),
      existing: { noteIds: ["note-1"], folderIds: ["folder-1"], tagIds: ["tag-1"] },
      existingNotes: [{ id: "note-1", updatedAt: 100, tagIds: [] }],
      choice: "remap",
      newId: () => `new-${(counter += 1)}`,
    });

    expect(plan.counts.remapped).toBe(3);
    const note = plan.notes[0]!;
    // The note's own references follow the objects they point at, or the copy would be filed nowhere.
    expect(note.id).not.toBe("note-1");
    expect(note.folderId).toBe(plan.folders[0]!.id);
    expect(note.tagIds).toEqual([plan.tags[0]!.id]);
    expect(plan.attachments[0]!.noteIds).toEqual([note.id]);
  });
});

describe("applying an import (§20)", () => {
  it("writes the rows, the links and the queued changes", async () => {
    const { db, close } = await freshDb();
    const dek = await importDek(generateDekRaw());
    const plan = planImport({
      archive: archiveOf({
        tags: [{ id: "tag-1", name: "personal" }],
        notes: [
          {
            id: "note-1",
            folderId: null,
            tagIds: ["tag-1"],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# Imported\n\nbody\n",
          },
        ],
        attachments: [
          {
            id: "attachment-1",
            filename: "map.png",
            contentType: "image/png",
            noteIds: ["note-1"],
            bytes: bytes("png-bytes"),
          },
        ],
      }),
      existing: noExisting,
      existingNotes: [],
      choice: "merge",
      newId: () => "unused",
    });

    const report = await applyImport({
      db,
      dek,
      keyVersion: 1,
      plan,
      now: 5_000,
      uploadAttachment: async (attachment) => `uploaded-${attachment.id}`,
    });

    expect(report.created).toBe(2);
    expect(report.attachments).toBe(1);
    // The attachment row is recorded under the id the upload reported, with its name encrypted for this device.
    expect(await db.attachments.get("uploaded-attachment-1")).toBeTruthy();
    const stored = await readLocalNote({ db, dek, userId: "u", keyVersion: 1 }, "note-1");
    expect(stored?.document.title).toBe("Imported");
    expect(stored?.note.revision).toBe(1);
    expect(await db.noteTags.where("noteId").equals("note-1").count()).toBe(1);
    // Everything is queued: an imported note that never uploads exists on one device only.
    const queued = await db.syncQueue.toArray();
    expect(queued.map((entry) => entry.objectType).sort()).toEqual([
      "note",
      "note_attachment",
      "note_tag_link",
      "tag",
    ]);
    await close();
  });

  it("rolls the whole import back when a write fails part way through", async () => {
    const { db, close } = await freshDb();
    const dek = await importDek(generateDekRaw());
    const plan = planImport({
      archive: archiveOf({
        notes: [
          {
            id: "note-1",
            folderId: null,
            tagIds: [],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# First\n",
          },
          {
            id: "note-2",
            folderId: null,
            tagIds: [],
            pinned: false,
            sortOrder: 0,
            createdAt: 100,
            updatedAt: 200,
            markdown: "# Second\n",
          },
        ],
      }),
      existing: noExisting,
      existingNotes: [],
      choice: "merge",
      newId: () => "unused",
    });

    // A database whose second note write fails, which is the situation the requirement is about: an import that
    // stops in the middle must leave nothing behind, not half an archive.
    let writes = 0;
    const failing = new Proxy(db, {
      get: (target, property, receiver) => {
        if (property !== "notes") {
          return Reflect.get(target, property, receiver);
        }
        const table = target.notes;
        return new Proxy(table, {
          get: (tableTarget, tableProperty, tableReceiver) => {
            if (tableProperty !== "put") {
              return Reflect.get(tableTarget, tableProperty, tableReceiver);
            }
            return async (value: unknown) => {
              writes += 1;
              if (writes === 2) {
                throw new Error("the disk is full");
              }
              return tableTarget.put(value as never);
            };
          },
        });
      },
    }) as SecureNotesDatabase;

    await expect(
      applyImport({
        db: failing,
        dek,
        keyVersion: 1,
        plan,
        now: 5_000,
        uploadAttachment: async () => "unused",
      }),
    ).rejects.toThrow(/disk is full/);

    // Nothing from the archive is here, and nothing is queued to be uploaded: the transaction undid both.
    expect(await db.notes.count()).toBe(0);
    expect(await db.noteTags.count()).toBe(0);
    expect(await db.syncQueue.count()).toBe(0);
    await close();
  });

  it("writes nothing when an attachment cannot be uploaded", async () => {
    const { db, close } = await freshDb();
    const dek = await importDek(generateDekRaw());
    const plan: ImportPlan = {
      notes: [],
      folders: [],
      tags: [],
      attachments: [
        {
          id: "attachment-1",
          filename: "a.png",
          contentType: "image/png",
          noteIds: [],
          bytes: bytes("x"),
        },
      ],
      counts: { created: 0, merged: 0, remapped: 0, unchanged: 0 },
      mergedIds: { notes: [], folders: [], tags: [] },
    };

    await expect(
      applyImport({
        db,
        dek,
        keyVersion: 1,
        plan,
        now: 5_000,
        uploadAttachment: async () => {
          throw new Error("the server refused the upload");
        },
      }),
    ).rejects.toThrow(/refused the upload/);

    // The upload happens before the transaction, so a failure there never reaches the database.
    expect(await db.attachments.count()).toBe(0);
    await close();
  });

  it("replaces the text of a merged note at a new revision, and queues it against the old one", async () => {
    const { db, close } = await freshDb();
    const dek = await importDek(generateDekRaw());
    // A note that is already here, older than the archive's copy.
    await db.notes.put({
      id: "note-1",
      folderId: null,
      revision: 3,
      payload: await (
        await import("@securenotes/shared")
      ).encryptObject(
        dek,
        { objectType: "note", objectId: "note-1", revision: 3, keyVersion: 1 },
        utf8("# Local and old\n"),
      ),
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 100,
      updatedAt: 100,
      syncedAt: 100,
    });

    const plan = planImport({
      archive: archiveOf(),
      existing: { ...noExisting, noteIds: ["note-1"] },
      existingNotes: [{ id: "note-1", updatedAt: 100, tagIds: [] }],
      choice: "merge",
      newId: () => "unused",
    });

    await applyImport({
      db,
      dek,
      keyVersion: 1,
      plan,
      now: 6_000,
      uploadAttachment: async () => "unused",
    });

    const row = await db.notes.get("note-1");
    // The revision moved, so the payload had to be re-encrypted at the new one — otherwise no other device could
    // decrypt it, silently.
    expect(row?.revision).toBe(4);
    const decrypted = await decryptObject(dek, aadFor("note", "note-1", 4, 1), row!.payload);
    expect(new TextDecoder().decode(decrypted)).toBe("# From the archive\n\nbody\n");

    const queued = await db.syncQueue.where("objectId").equals("note-1").toArray();
    const noteEntry = queued.find((entry) => entry.objectType === "note");
    expect(noteEntry?.operation).toBe("update");
    expect(noteEntry?.baseRevision).toBe(3);
    await close();
  });
});

afterEach(() => {
  // Each test names its own database, so nothing leaks between them.
});
