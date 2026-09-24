import {
  CRYPTO_VERSION,
  decryptObject,
  deriveKek,
  generateDekRaw,
  importDek,
  utf8,
} from "@securenotes/shared";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import {
  createLocalFolder,
  createLocalNote,
  createLocalTag,
  pendingChangesFor,
  readAllLocalNotes,
  readLocalFolderName,
  readLocalNote,
  readLocalTagName,
  updateLocalNote,
  type LocalContext,
} from "./repository";
import { joinNoteDocument, splitNoteDocument } from "./note-document";
import { databaseNameFor, openDatabase, type SecureNotesDatabase } from "../local/schema";
import { NoteSearchIndex, highlightSegments } from "../search";

/**
 * The client data layer and search (§7, §8, §11).
 *
 * The claims being checked are the ones the whole design rests on: that nothing
 * readable is ever written to IndexedDB, that every local change is queued, and
 * that the search index exists only in memory.
 */

let sequence = 0;

async function freshContext(): Promise<LocalContext & { close: () => Promise<void> }> {
  const name = `${databaseNameFor(2)}-data-${(sequence += 1)}`;
  const db = openDatabase(name);
  await db.open();

  const dek = await importDek(generateDekRaw());
  return {
    db,
    dek,
    userId: "user-1",
    keyVersion: 1,
    close: async () => {
      db.close();
      await Dexie.delete(name).catch(() => undefined);
    },
  };
}

/** Every string value stored in the database, for plaintext leak checks. */
async function storedStrings(db: SecureNotesDatabase): Promise<string> {
  const tables = ["notes", "folders", "tags", "attachments", "keyMaterial", "meta", "syncQueue"];
  const parts: string[] = [];
  for (const table of tables) {
    parts.push(JSON.stringify(await db.table(table).toArray()));
  }
  return parts.join("\n");
}

describe("note documents (§9)", () => {
  it("treats the leading heading as the title", () => {
    expect(splitNoteDocument("# Groceries\n\nmilk and eggs")).toEqual({
      title: "Groceries",
      body: "milk and eggs",
    });
    // A note without a heading simply has no title.
    expect(splitNoteDocument("just a body")).toEqual({ title: "", body: "just a body" });
    expect(splitNoteDocument("")).toEqual({ title: "", body: "" });
  });

  it("round-trips a document", () => {
    const markdown = "# Title\n\nBody line\n\n- item";
    expect(joinNoteDocument(splitNoteDocument(markdown))).toBe(markdown);
  });
});

describe("local writes encrypt before storing (§7)", () => {
  it("stores a note as ciphertext with the plaintext nowhere in the database", async () => {
    const context = await freshContext();

    const note = await createLocalNote(context, {
      id: "note-1",
      title: "Groceries",
      body: "milk and eggs",
    });

    expect(note.revision).toBe(1);
    expect(note.payload.alg).toBe("AES-256-GCM");
    expect(note.payload.crypto_version).toBe(CRYPTO_VERSION);

    const dump = await storedStrings(context.db);
    expect(dump).not.toContain("Groceries");
    expect(dump).not.toContain("milk and eggs");
    // Nor does the title survive in any other row, such as the queue.
    expect(dump).not.toContain("# Groceries");

    await context.close();
  });

  it("round-trips a note through decryption", async () => {
    const context = await freshContext();
    await createLocalNote(context, { id: "note-rt", title: "Title", body: "Body" });

    const stored = await readLocalNote(context, "note-rt");

    expect(stored?.document.title).toBe("Title");
    expect(stored?.document.body).toBe("Body");
    await context.close();
  });

  it("advances the revision and re-binds it through the AAD", async () => {
    const context = await freshContext();
    const first = await createLocalNote(context, { id: "note-rev", title: "First", body: "" });

    const updated = await updateLocalNote(context, {
      id: "note-rev",
      title: "Second",
      body: "more",
    });

    expect(updated.revision).toBe(2);
    expect(updated.payload.key_version).toBe(1);
    expect((await readLocalNote(context, "note-rev"))?.document.title).toBe("Second");

    // The revision-1 ciphertext still decrypts at revision 1…
    await expect(
      decryptObject(
        context.dek,
        { objectType: "note", objectId: "note-rev", revision: 1, keyVersion: 1 },
        first.payload,
      ),
    ).resolves.toBeInstanceOf(Uint8Array);

    // …and cannot be passed off as revision 2, because the revision is bound into
    // the AAD. That is what turns a silent rollback into a decryption failure.
    await expect(
      decryptObject(
        context.dek,
        { objectType: "note", objectId: "note-rev", revision: 2, keyVersion: 1 },
        first.payload,
      ),
    ).rejects.toThrow();

    await context.close();
  });

  it("cannot be decrypted by another note's identity", async () => {
    const context = await freshContext();
    const note = await createLocalNote(context, { id: "note-a", title: "A", body: "" });

    await expect(
      decryptObject(
        context.dek,
        { objectType: "note", objectId: "note-b", revision: 1, keyVersion: 1 },
        note.payload,
      ),
    ).rejects.toThrow();

    await context.close();
  });

  it("encrypts folder and tag names too", async () => {
    const context = await freshContext();
    const folder = await createLocalFolder(context, { id: "folder-1", name: "Private" });
    const tag = await createLocalTag(context, { id: "tag-1", name: "Urgent" });

    const dump = await storedStrings(context.db);
    expect(dump).not.toContain("Private");
    expect(dump).not.toContain("Urgent");

    expect(await readLocalFolderName(context, folder)).toBe("Private");
    expect(await readLocalTagName(context, tag)).toBe("Urgent");
    await context.close();
  });

  it("fails closed when the DEK is not the one that wrote the note", async () => {
    const context = await freshContext();
    await createLocalNote(context, { id: "note-wrong-key", title: "Secret", body: "" });

    const otherKey = await importDek(generateDekRaw());
    await expect(readLocalNote({ ...context, dek: otherKey }, "note-wrong-key")).rejects.toThrow();

    await context.close();
  });

  it("queues every local change (§8, §16)", async () => {
    const context = await freshContext();

    await createLocalNote(context, { id: "note-q", title: "Q", body: "" });
    await updateLocalNote(context, { id: "note-q", title: "Q2", body: "" });
    await createLocalFolder(context, { id: "folder-q", name: "F" });

    const queued = await pendingChangesFor(context.db, "note-q");
    expect(queued.map((item) => item.operation)).toEqual(["create", "update"]);
    expect(queued[1]?.baseRevision).toBe(1);

    // And the rows are unsynced, which is what protects them from eviction.
    const note = await context.db.notes.get("note-q");
    expect(note?.syncedAt).toBeNull();

    await context.close();
  });

  it("skips a row it cannot decrypt instead of failing the whole read", async () => {
    const context = await freshContext();
    await createLocalNote(context, { id: "note-good", title: "Good", body: "" });
    await createLocalNote(context, { id: "note-bad", title: "Bad", body: "" });

    // Corrupt one row the way a partial write would.
    await context.db.notes.update("note-bad", {
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "dGFtcGVyZWQ=",
      },
    });

    const notes = await readAllLocalNotes(context);

    expect(notes.map((entry) => entry.note.id)).toEqual(["note-good"]);
    // The corrupt row is still there: skipping it for search must not delete it.
    expect(await context.db.notes.get("note-bad")).toBeTruthy();

    await context.close();
  });
});

describe("search (§11)", () => {
  const notes = [
    {
      id: "1",
      title: "Groceries",
      body: "milk, eggs and bread",
      tags: ["shopping"],
      folderName: "Home",
      attachmentNames: ["receipt.png"],
      updatedAt: 3,
      createdAt: 1,
      pinned: false,
    },
    {
      id: "2",
      title: "Project plan",
      body: "milestones and risks",
      tags: ["work"],
      folderName: "Work",
      attachmentNames: [],
      updatedAt: 2,
      createdAt: 2,
      pinned: true,
    },
  ];

  it("finds notes by title, body, tag, folder and attachment name", () => {
    const index = new NoteSearchIndex();
    index.build(notes);

    for (const [query, expected] of [
      ["groceries", "1"],
      ["eggs", "1"],
      ["shopping", "1"],
      ["Home", "1"],
      ["receipt", "1"],
      ["milestones", "2"],
      ["work", "2"],
    ] as const) {
      expect(
        index.search(query).map((hit) => hit.id),
        query,
      ).toContain(expected);
    }
  });

  it("tolerates typos and matches prefixes", () => {
    const index = new NoteSearchIndex();
    index.build(notes);

    // Fuzzy: a one-character typo still finds the note.
    expect(index.search("grocries").map((hit) => hit.id)).toContain("1");
    // Prefix: an unfinished word matches.
    expect(index.search("milest").map((hit) => hit.id)).toContain("2");
  });

  it("ranks a title match above a body match", () => {
    const index = new NoteSearchIndex();
    index.build([
      { ...notes[0]!, id: "title-match", title: "milestones", body: "" },
      { ...notes[0]!, id: "body-match", title: "", body: "milestones appear here" },
    ]);

    expect(index.search("milestones")[0]?.id).toBe("title-match");
  });

  it("reports which field matched", () => {
    const index = new NoteSearchIndex();
    index.build(notes);

    const hit = index.search("eggs")[0]!;
    expect(hit.matchedFields).toContain("body");
  });

  it("returns nothing for an empty query and honours the limit", () => {
    const index = new NoteSearchIndex();
    index.build(notes);

    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("milk", { limit: 1 })).toHaveLength(1);
  });

  it("supports incremental updates and removals", () => {
    const index = new NoteSearchIndex();
    index.build(notes);
    expect(index.size).toBe(2);

    index.upsert({ ...notes[0]!, id: "3", title: "New note", body: "fresh" });
    expect(index.search("fresh").map((hit) => hit.id)).toContain("3");
    expect(index.size).toBe(3);

    index.upsert({ ...notes[0]!, id: "3", title: "Renamed", body: "changed" });
    expect(index.size).toBe(3);
    expect(index.search("fresh")).toHaveLength(0);

    index.remove("3");
    expect(index.size).toBe(2);
    expect(index.search("changed")).toHaveLength(0);
  });

  it("discards every plaintext term on clear", () => {
    const index = new NoteSearchIndex();
    index.build(notes);
    expect(index.search("groceries")).toHaveLength(1);

    index.clear();

    expect(index.isBuilt).toBe(false);
    expect(index.size).toBe(0);
    expect(index.search("groceries")).toEqual([]);
  });

  it("never writes an index to the database", async () => {
    const context = await freshContext();
    await createLocalNote(context, { id: "note-index", title: "Sensitive", body: "keyword-xyz" });

    const index = new NoteSearchIndex();
    const stored = await readAllLocalNotes(context);
    index.build(
      stored.map((entry) => ({
        id: entry.note.id,
        title: entry.document.title,
        body: entry.document.body,
        tags: [],
        folderName: null,
        attachmentNames: [],
        updatedAt: entry.note.updatedAt,
        createdAt: entry.note.createdAt,
        pinned: false,
      })),
    );
    expect(index.search("keyword-xyz")).toHaveLength(1);

    // Building the index must not have persisted anything: the plaintext terms
    // exist only in memory (§11).
    const dump = await storedStrings(context.db);
    expect(dump).not.toContain("keyword-xyz");
    expect(dump).not.toContain("Sensitive");

    await context.close();
  });
});

describe("highlighting (§11)", () => {
  it("marks the matching segments without producing markup", () => {
    const segments = highlightSegments("milk and eggs", "eggs");

    expect(segments).toEqual([
      { text: "milk and ", highlighted: false },
      { text: "eggs", highlighted: true },
    ]);
  });

  it("is case-insensitive and handles several terms", () => {
    const segments = highlightSegments("Milk and EGGS", "milk eggs");

    expect(
      segments.filter((segment) => segment.highlighted).map((segment) => segment.text),
    ).toEqual(["Milk", "EGGS"]);
  });

  it("treats markup in the query as text, never as a pattern", () => {
    // A query is user input; it must not be compiled into a regex that can match
    // everything or inject markup.
    const segments = highlightSegments("a<b>c", "<b>");
    expect(segments.every((segment) => typeof segment.text === "string")).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe("a<b>c");

    const wildcard = highlightSegments("anything", ".*");
    expect(wildcard).toEqual([{ text: "anything", highlighted: false }]);
  });

  it("returns the text unchanged for an empty query", () => {
    expect(highlightSegments("unchanged", "")).toEqual([{ text: "unchanged", highlighted: false }]);
  });
});

describe("deriving the KEK on the client (§6)", () => {
  it("produces a non-extractable key from the delivered material", async () => {
    const kek = await deriveKek({
      username: "alice",
      totpSecretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kdfSaltBase64: btoa("0123456789abcdef"),
    });

    expect(kek.extractable).toBe(false);
    // The KEK is only ever used to wrap and unwrap the DEK.
    expect(kek.usages).toEqual(["encrypt", "decrypt"]);
    expect(utf8("x")).toBeInstanceOf(Uint8Array);
  });
});
