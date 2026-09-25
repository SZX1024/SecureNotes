import {
  decryptObject,
  encryptObject,
  generateDekRaw,
  importDek,
  utf8,
  type CryptoEnvelope,
} from "@securenotes/shared";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import { databaseNameFor, openDatabase } from "../local/schema";
import { enqueueChange } from "../local/sync-queue";
import { loadNoteConflict, resolveNoteConflict, textForChoice } from "./conflicts-client";
import { LOCAL_MARKER, REMOTE_MARKER } from "./merge";
import { SYNC_CONFLICT_PREFIX } from "./engine";

/**
 * Resolving a conflict (§16).
 *
 * The assertion that matters most is on the revision: the resolution is stored as `remote_revision + 1`,
 * and the revision is inside the envelope's AAD, so a payload encrypted at any other revision decrypts on
 * no device — silently, because an undecryptable note is skipped. The tests decrypt what they upload at
 * the new revision and confirm the old one no longer fits.
 */

let sequence = 0;

const USER_ID = "user-1";
const NOTE_ID = "note-1";
const KEY_VERSION = 1;

async function fixture() {
  const name = `${databaseNameFor(3)}-conflicts-${(sequence += 1)}`;
  const db = openDatabase(name);
  await db.open();
  const dek = await importDek(generateDekRaw());

  const envelopeAt = (revision: number, text: string) =>
    encryptObject(
      dek,
      { objectType: "note", objectId: NOTE_ID, revision, keyVersion: KEY_VERSION },
      utf8(text),
    );

  return {
    db,
    dek,
    envelopeAt,
    close: async () => {
      db.close();
      await Dexie.delete(name).catch(() => undefined);
    },
  };
}

/** The server as these tests see it: a conflict between revision 1 and revision 2. */
function stubApi(input: {
  remoteRevision: number;
  remote: unknown;
  local: unknown;
  baseRevision: number | null;
  revisions?: Array<{ revision: number; payload: unknown }>;
}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url: String(url), body });

      if (String(url).includes("/conflicts") && (init.method ?? "GET") === "GET") {
        return Response.json({
          ok: true,
          data: {
            conflicts: [
              {
                id: "conflict-1",
                objectId: NOTE_ID,
                baseRevision: input.baseRevision,
                remoteRevision: input.remoteRevision,
                local: input.local,
                remote: input.remote,
              },
            ],
          },
        });
      }
      if (String(url).includes("/revisions")) {
        return Response.json({ ok: true, data: { revisions: input.revisions ?? [] } });
      }
      if (String(url).includes("/resolve")) {
        return Response.json({ ok: true, data: { conflict: { id: "conflict-1" } } });
      }
      return Response.json({ ok: true, data: {} });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading a conflict (§16)", () => {
  it("returns all three sides as text", async () => {
    const { db, dek, envelopeAt, close } = await fixture();
    await db.notes.put({
      id: NOTE_ID,
      folderId: "folder-1",
      revision: 3,
      payload: (await envelopeAt(3, "local text")) as never,
      deletedAt: null,
      pinned: true,
      sortOrder: 7,
      createdAt: 100,
      updatedAt: 200,
      syncedAt: null,
    });
    stubApi({
      remoteRevision: 2,
      remote: await envelopeAt(2, "remote text"),
      local: {},
      baseRevision: 1,
      revisions: [{ revision: 1, payload: await envelopeAt(1, "base text") }],
    });

    const sides = await loadNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      NOTE_ID,
    );

    expect(sides?.base).toBe("base text");
    expect(sides?.local).toBe("local text");
    expect(sides?.remote).toBe("remote text");
    expect(sides?.remoteRevision).toBe(2);
    await close();
  });

  it("reports no base when that revision has been pruned", async () => {
    const { db, dek, envelopeAt, close } = await fixture();
    await db.notes.put({
      id: NOTE_ID,
      folderId: null,
      revision: 3,
      payload: (await envelopeAt(3, "local")) as never,
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: null,
    });
    stubApi({
      remoteRevision: 2,
      remote: await envelopeAt(2, "remote"),
      local: {},
      baseRevision: 1,
      revisions: [],
    });

    const sides = await loadNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      NOTE_ID,
    );

    // A pruned ancestor is normal; the merge treats everything as conflicted rather than guessing.
    expect(sides?.base).toBeNull();
    await close();
  });
});

describe("choosing a side (§16)", () => {
  it("keeps the local text, re-encrypted at the revision the server will store", async () => {
    const { db, dek, envelopeAt, close } = await fixture();
    await db.notes.put({
      id: NOTE_ID,
      folderId: "folder-keep",
      revision: 3,
      payload: (await envelopeAt(3, "local text")) as never,
      deletedAt: null,
      pinned: true,
      sortOrder: 4,
      createdAt: 100,
      updatedAt: 200,
      syncedAt: null,
    });
    await enqueueChange(db, {
      objectType: "note",
      objectId: NOTE_ID,
      operation: "update",
      baseRevision: 2,
    });
    await db.meta.put({
      key: `${SYNC_CONFLICT_PREFIX}note:${NOTE_ID}`,
      value: { reason: "revision" },
    });
    const calls = stubApi({
      remoteRevision: 2,
      remote: await envelopeAt(2, "remote text"),
      local: {},
      baseRevision: 1,
    });

    const sides = await loadNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      NOTE_ID,
    );
    const outcome = await resolveNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      { sides: sides!, choice: "local" },
    );

    expect(outcome.revision).toBe(3);

    // The uploaded payload decrypts at revision 3…
    const resolveCall = calls.find((call) => call.url.includes("/resolve"))!;
    const uploaded = (
      resolveCall.body as {
        payload: CryptoEnvelope;
      }
    ).payload;
    await expect(
      decryptObject(
        dek,
        { objectType: "note", objectId: NOTE_ID, revision: 3, keyVersion: KEY_VERSION },
        uploaded,
      ),
    ).resolves.toEqual(utf8("local text"));

    // …and no longer at the revision it was previously stored under.
    await expect(
      decryptObject(
        dek,
        { objectType: "note", objectId: NOTE_ID, revision: 2, keyVersion: KEY_VERSION },
        uploaded,
      ),
    ).rejects.toThrow();

    const row = await db.notes.get(NOTE_ID);
    expect(row?.revision).toBe(3);
    // The note's other properties survive the resolution.
    expect(row?.folderId).toBe("folder-keep");
    expect(row?.pinned).toBe(true);
    expect(row?.sortOrder).toBe(4);
    expect(row?.createdAt).toBe(100);
    // Its queued edits are gone: they were the local side that has just been decided about.
    expect(await db.syncQueue.count()).toBe(0);
    // And the conflict marker is cleared, so the note is no longer paused.
    expect(await db.meta.get(`${SYNC_CONFLICT_PREFIX}note:${NOTE_ID}`)).toBeUndefined();
    await close();
  });

  it("takes the remote side without writing anything", async () => {
    const { db, dek, envelopeAt, close } = await fixture();
    await db.notes.put({
      id: NOTE_ID,
      folderId: "folder-1",
      revision: 3,
      payload: (await envelopeAt(3, "local text")) as never,
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 2,
      syncedAt: null,
    });
    const calls = stubApi({
      remoteRevision: 2,
      remote: await envelopeAt(2, "remote text"),
      local: {},
      baseRevision: 1,
    });

    const sides = await loadNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      NOTE_ID,
    );
    const outcome = await resolveNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      { sides: sides!, choice: "remote" },
    );

    expect(outcome.revision).toBe(2);
    const resolveCall = calls.find((call) => call.url.includes("/resolve"))!;
    expect(resolveCall.body).toEqual({ resolution: "remote" });

    // Locally the note becomes the remote revision, decryptable because the envelope is the server's own.
    const row = await db.notes.get(NOTE_ID);
    expect(row?.revision).toBe(2);
    expect(row?.folderId).toBe("folder-1");
    await expect(
      decryptObject(
        dek,
        { objectType: "note", objectId: NOTE_ID, revision: 2, keyVersion: KEY_VERSION },
        row!.payload,
      ),
    ).resolves.toEqual(utf8("remote text"));
    await close();
  });

  it("merges both sides and uploads the result", async () => {
    const { db, dek, envelopeAt, close } = await fixture();
    // Both sides edit the *same* line, which is the case that must not be decided for the user.
    await db.notes.put({
      id: NOTE_ID,
      folderId: null,
      revision: 4,
      payload: (await envelopeAt(4, "# Local\n\none\n")) as never,
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: null,
    });
    const calls = stubApi({
      remoteRevision: 2,
      remote: await envelopeAt(2, "# Remote\n\none\n"),
      local: {},
      baseRevision: 1,
      revisions: [{ revision: 1, payload: await envelopeAt(1, "# Title\n\none\n") }],
    });

    const sides = await loadNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      NOTE_ID,
    );
    // Both sides changed the same line, so the suggested merge keeps both versions visible.
    const suggested = textForChoice({ sides: sides!, choice: "merged" });
    expect(suggested).toContain(LOCAL_MARKER);
    expect(suggested).toContain(REMOTE_MARKER);

    const outcome = await resolveNoteConflict(
      { db, dek, keyVersion: KEY_VERSION, userId: USER_ID },
      { sides: sides!, choice: "merged", mergedText: "# Local and Remote\n\none\n" },
    );

    expect(outcome.revision).toBe(3);
    const resolveCall = calls.find((call) => call.url.includes("/resolve"))!;
    expect((resolveCall.body as { resolution: string }).resolution).toBe("merged");
    await expect(
      decryptObject(
        dek,
        { objectType: "note", objectId: NOTE_ID, revision: 3, keyVersion: KEY_VERSION },
        (resolveCall.body as { payload: never }).payload,
      ),
    ).resolves.toEqual(utf8("# Local and Remote\n\none\n"));
    await close();
  });

  it("suggests the local text when only the other side changed", async () => {
    const sides = {
      conflictId: "c",
      noteId: NOTE_ID,
      baseRevision: 1,
      remoteRevision: 2,
      remotePayload: {} as never,
      base: "same\n",
      local: "same\n",
      remote: "same\nchanged\n",
    };

    // No overlap: the merge is clean, and nothing is marked.
    expect(textForChoice({ sides, choice: "merged" })).toBe("same\nchanged\n");
  });
});
