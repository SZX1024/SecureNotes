import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  databaseNameFor,
  openDatabase,
  type SecureNotesDatabase,
  type SyncQueueItem,
} from "../local/schema";
import { enqueueChange } from "../local/sync-queue";
import { applyRemote, applyRemoteChange } from "./apply";
import {
  backoffDelayMs,
  compressQueue,
  deriveSyncState,
  isDue,
  isPaused,
  listLocalConflicts,
  readCursor,
  syncNow,
  writeCursor,
} from "./engine";

/**
 * The sync engine (§16, §17).
 *
 * The rules are tested as rules: what may be compressed, what backoff is, which state the interface
 * shows, and — the one that decides whether a user loses work — that local unsynced edits are never
 * overwritten by a remote change.
 */

let sequence = 0;

async function freshDb(): Promise<{ db: SecureNotesDatabase; close: () => Promise<void> }> {
  const name = `${databaseNameFor(3)}-sync-${(sequence += 1)}`;
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

function item(overrides: Partial<SyncQueueItem> & { id: number }): SyncQueueItem {
  return {
    objectType: "note",
    objectId: "note-1",
    operation: "update",
    baseRevision: 1,
    queuedAt: 1000,
    attempts: 0,
    nextAttemptAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queue compression (§16)", () => {
  it("uploads only the create when the object never reached the server", () => {
    // The create carries the object as it is now, at the revision the payload was encrypted under, so the
    // queued edits are already inside it. Replaying them would send base revisions the server has moved
    // past, which manufactures a conflict out of nothing.
    const compressed = compressQueue([
      item({ id: 1, operation: "create", baseRevision: null, queuedAt: 1000 }),
      item({ id: 2, operation: "update", baseRevision: 1, queuedAt: 2000 }),
      item({ id: 3, operation: "update", baseRevision: 2, queuedAt: 3000 }),
    ]);

    expect(compressed).toHaveLength(1);
    expect(compressed[0]!.operation).toBe("create");
  });

  it("drops a create and delete that never reached the server", () => {
    // The server has never heard of the object; telling it to delete something it does not have would be
    // a 404, and telling it to create something already gone is pointless.
    const compressed = compressQueue([
      item({ id: 1, operation: "create", baseRevision: null }),
      item({ id: 2, operation: "delete" }),
    ]);

    expect(compressed).toEqual([]);
  });

  it("sends only the delete when an existing object was deleted", () => {
    const compressed = compressQueue([
      item({ id: 1, operation: "update", baseRevision: 1 }),
      item({ id: 2, operation: "update", baseRevision: 2 }),
      item({ id: 3, operation: "delete" }),
    ]);

    expect(compressed).toHaveLength(1);
    expect(compressed[0]!.operation).toBe("delete");
  });

  it("keeps every edit of an object the server already has, in order", () => {
    // The revision is inside the ciphertext's AAD, so the server has to advance one step per edit.
    const compressed = compressQueue([
      item({ id: 1, baseRevision: 1, queuedAt: 1000 }),
      item({ id: 2, baseRevision: 2, queuedAt: 2000 }),
      item({ id: 3, baseRevision: 3, queuedAt: 3000 }),
    ]);

    expect(compressed.map((entry) => entry.baseRevision)).toEqual([1, 2, 3]);
  });

  it("handles several objects independently and keeps their order", () => {
    const compressed = compressQueue([
      item({ id: 1, objectId: "a", operation: "create", baseRevision: null }),
      item({ id: 2, objectId: "b", baseRevision: 1 }),
      item({ id: 3, objectId: "a", operation: "update", baseRevision: 1 }),
      item({ id: 4, objectId: "b", baseRevision: 2 }),
    ]);

    expect(compressed.map((entry) => [entry.objectId, entry.operation])).toEqual([
      ["a", "create"],
      ["b", "update"],
      ["b", "update"],
    ]);
  });

  it("discards nothing for an object that is still alive", () => {
    const alive = compressQueue(
      Array.from({ length: 6 }, (_, index) => item({ id: index + 1, baseRevision: index + 1 })),
    );
    expect(alive).toHaveLength(6);
  });
});

describe("retry scheduling (§16)", () => {
  it("backs off exponentially and caps", () => {
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(50)).toBe(300_000);
  });

  it("pauses automatic retry after repeated failures", () => {
    const failing = item({ id: 1, attempts: 5, nextAttemptAt: 10_000 });

    // Still scheduled, but no longer retried by itself: §16 pauses and leaves it to Sync Now.
    expect(isPaused(failing)).toBe(true);
    expect(isDue(failing, 999_999)).toBe(false);
  });

  it("retries when the scheduled time has passed", () => {
    expect(isDue(item({ id: 1, attempts: 1, nextAttemptAt: 5_000 }), 5_000)).toBe(true);
    expect(isDue(item({ id: 1, attempts: 1, nextAttemptAt: 5_000 }), 4_999)).toBe(false);
  });
});

describe("sync state (§17)", () => {
  const base = {
    pending: 0,
    syncing: false,
    conflicts: 0,
    online: true,
    authRequired: false,
    paused: false,
  };

  it("reports synced when there is nothing to do", () => {
    expect(deriveSyncState(base)).toBe("synced");
  });

  it("reports each state the interface must show", () => {
    expect(deriveSyncState({ ...base, pending: 3 })).toBe("pending");
    expect(deriveSyncState({ ...base, pending: 3, syncing: true })).toBe("syncing");
    expect(deriveSyncState({ ...base, conflicts: 1 })).toBe("conflict");
    expect(deriveSyncState({ ...base, online: false })).toBe("offline");
    expect(deriveSyncState({ ...base, paused: true })).toBe("sync-error");
    expect(deriveSyncState({ ...base, authRequired: true })).toBe("auth-required");
  });

  it("shows what the user must act on first", () => {
    // An expired session outranks everything: nothing else can be fixed until it is.
    expect(deriveSyncState({ ...base, authRequired: true, conflicts: 2, online: false })).toBe(
      "auth-required",
    );
    // A conflict outranks being offline, because it needs a decision rather than patience.
    expect(deriveSyncState({ ...base, conflicts: 1, online: false })).toBe("conflict");
  });
});

describe("applying remote changes (§16)", () => {
  it("writes a note payload without needing to read it", async () => {
    const { db, close } = await freshDb();

    const outcome = await applyRemoteChange(
      {
        seq: 1,
        objectType: "note",
        objectId: "note-r",
        changeType: "create",
        revision: 4,
        changedAt: 111,
        payload: {
          id: "note-r",
          folderId: null,
          revision: 4,
          payload: {
            crypto_version: 1,
            key_version: 1,
            alg: "AES-256-GCM",
            iv: "AAAAAAAAAAAAAAAA",
            ciphertext: "Y3Q=",
          },
          deletedAt: null,
          pinned: false,
          sortOrder: 0,
          createdAt: 100,
        },
      },
      { db },
    );

    expect(outcome.result).toBe("applied");
    const stored = await db.notes.get("note-r");
    expect(stored?.revision).toBe(4);
    expect((stored?.payload as { ciphertext: string }).ciphertext).toBe("Y3Q=");
    // It came from the server, so it is not pending.
    expect(stored?.syncedAt).toBe(111);
    await close();
  });

  it("refuses to overwrite a note with local edits waiting", async () => {
    const { db, close } = await freshDb();
    await db.notes.put({
      id: "note-local",
      folderId: null,
      revision: 2,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "bG9jYWw=",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 2,
      syncedAt: null,
    });
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-local",
      operation: "update",
      baseRevision: 1,
    });

    const outcome = await applyRemoteChange(
      {
        seq: 5,
        objectType: "note",
        objectId: "note-local",
        changeType: "update",
        revision: 9,
        changedAt: 900,
        payload: {
          payload: {
            crypto_version: 1,
            key_version: 1,
            alg: "AES-256-GCM",
            iv: "AAAAAAAAAAAAAAAA",
            ciphertext: "cmVtb3Rl",
          },
        },
      },
      { db },
    );

    // The local edit is not uploaded yet, so the remote side must not win.
    expect(outcome.result).toBe("conflict");
    const stored = await db.notes.get("note-local");
    expect((stored?.payload as { ciphertext: string }).ciphertext).toBe("bG9jYWw=");
    await close();
  });

  it("treats a remote delete against a locally edited note as a conflict, never as a deletion", async () => {
    const { db, close } = await freshDb();
    await db.notes.put({
      id: "note-del",
      folderId: null,
      revision: 1,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "bWluZQ==",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: 1,
    });
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-del",
      operation: "update",
      baseRevision: 1,
    });

    const outcome = await applyRemoteChange(
      {
        seq: 7,
        objectType: "note",
        objectId: "note-del",
        changeType: "delete",
        revision: 2,
        changedAt: 700,
        payload: null,
      },
      { db },
    );

    expect(outcome.result).toBe("conflict");
    // §16: delete-vs-modify is always a conflict, so the note is still here with its edits.
    expect((await db.notes.get("note-del"))?.deletedAt).toBeNull();
    await close();
  });

  it("records a remote delete as a tombstone when nothing local is pending", async () => {
    const { db, close } = await freshDb();
    await db.notes.put({
      id: "note-gone",
      folderId: null,
      revision: 1,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "eA==",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: 1,
    });

    await applyRemoteChange(
      {
        seq: 8,
        objectType: "note",
        objectId: "note-gone",
        changeType: "delete",
        revision: 2,
        changedAt: 800,
        payload: null,
      },
      { db },
    );

    const stored = await db.notes.get("note-gone");
    expect(stored?.deletedAt).toBe(800);
    await close();
  });

  it("ignores an object type this client does not store", async () => {
    const { db, close } = await freshDb();
    const outcome = await applyRemoteChange(
      {
        seq: 9,
        objectType: "attachment",
        objectId: "att-1",
        changeType: "create",
        revision: null,
        changedAt: 1,
        payload: {},
      },
      { db },
    );
    expect(outcome.result).toBe("ignored");
    await close();
  });
});

describe("a sync pass (§16, §17)", () => {
  it("uploads what is queued and pulls what is new", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "n1",
      operation: "create",
      baseRevision: null,
    });
    await enqueueChange(db, {
      objectType: "note",
      objectId: "n2",
      operation: "create",
      baseRevision: null,
    });

    const pushed: string[] = [];
    const outcome = await syncNow({
      db,
      push: async (change) => {
        pushed.push(change.objectId);
        return "ok";
      },
      pull: async (since) => ({
        cursor: since + 1,
        changes:
          since === 0
            ? [
                {
                  seq: 1,
                  objectType: "tag" as const,
                  objectId: "t1",
                  changeType: "create" as const,
                  revision: null,
                  changedAt: 50,
                  payload: {
                    name: {
                      crypto_version: 1,
                      key_version: 1,
                      alg: "AES-256-GCM",
                      iv: "AAAAAAAAAAAAAAAA",
                      ciphertext: "dGFn",
                    },
                  },
                },
              ]
            : [],
        hasMore: false,
      }),
      apply: applyRemote(db),
    });

    expect(pushed.sort()).toEqual(["n1", "n2"]);
    expect(outcome.pushed).toBe(2);
    expect(outcome.pulled).toBe(1);
    expect(outcome.state).toBe("synced");
    // Acknowledged, so nothing is left queued.
    expect(await db.syncQueue.count()).toBe(0);
    expect(await readCursor(db)).toBe(1);
    await close();
  });

  it("keeps a queued entry and schedules a retry when the upload fails", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "n1",
      operation: "update",
      baseRevision: 1,
    });

    const outcome = await syncNow({
      db,
      push: async () => "retry",
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
      now: () => 1_000,
    });

    // The entry stays: it is the only record of the edit.
    expect(await db.syncQueue.count()).toBe(1);
    const queued = await db.syncQueue.toArray();
    expect(queued[0]!.attempts).toBe(1);
    expect(queued[0]!.nextAttemptAt).toBe(3_000);
    expect(outcome.pushed).toBe(0);
    await close();
  });

  it("pauses an object on conflict and leaves its work queued", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "n1",
      operation: "update",
      baseRevision: 1,
    });

    const outcome = await syncNow({
      db,
      push: async () => "conflict",
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    expect(outcome.conflicts).toBe(1);
    expect(outcome.state).toBe("conflict");
    expect(await db.syncQueue.count()).toBe(1);
    // And the object is listed as needing attention.
    const conflicts = await listLocalConflicts(db);
    expect(conflicts).toEqual([
      { objectType: "note", objectId: "n1", reason: "revision", remoteRevision: null },
    ]);
    await close();
  });

  it("stops on an expired session and reports it", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "n1",
      operation: "update",
      baseRevision: 1,
    });
    const pull = vi.fn(async (since: number) => ({ cursor: since, changes: [], hasMore: false }));

    const outcome = await syncNow({
      db,
      push: async () => "auth",
      pull,
      apply: async () => "applied",
    });

    expect(outcome.state).toBe("auth-required");
    expect(outcome.stoppedBy).toBe("auth");
    // Nothing was pulled: every request would fail the same way.
    expect(pull).not.toHaveBeenCalled();
    await close();
  });

  it("walks a multi-batch feed and stores the cursor after each one", async () => {
    const { db, close } = await freshDb();
    let batch = 0;

    const outcome = await syncNow({
      db,
      push: async () => "ok",
      pull: async () => {
        batch += 1;
        return {
          cursor: batch,
          changes:
            batch === 1
              ? [
                  {
                    seq: 1,
                    objectType: "tag" as const,
                    objectId: "t1",
                    changeType: "create" as const,
                    revision: null,
                    changedAt: 1,
                    payload: {
                      name: {
                        crypto_version: 1,
                        key_version: 1,
                        alg: "AES-256-GCM",
                        iv: "AAAAAAAAAAAAAAAA",
                        ciphertext: "YQ==",
                      },
                    },
                  },
                ]
              : [],
          hasMore: batch < 2,
        };
      },
      apply: applyRemote(db),
    });

    expect(outcome.pulled).toBe(1);
    expect(await readCursor(db)).toBe(2);
    await close();
  });

  it("only pulls from the cursor it stored", async () => {
    const { db, close } = await freshDb();
    await writeCursor(db, 42);
    const seen: number[] = [];

    await syncNow({
      db,
      push: async () => "ok",
      pull: async (since) => {
        seen.push(since);
        return { cursor: since, changes: [], hasMore: false };
      },
      apply: async () => "applied",
    });

    expect(seen).toEqual([42]);
    await close();
  });
});

describe("upload order (§16)", () => {
  it("uploads a tag before the link that points at it", async () => {
    const { db, close } = await freshDb();
    // The link is queued first, which is what a user does: create the tag panel entry, then tick it. The
    // server has a foreign key, so the tag has to exist first or the link is answered with a 500.
    await enqueueChange(db, {
      objectType: "note_tag_link",
      objectId: "note-1",
      operation: "update",
      baseRevision: null,
    });
    await enqueueChange(db, {
      objectType: "tag",
      objectId: "tag-1",
      operation: "create",
      baseRevision: null,
    });

    const order: string[] = [];
    await syncNow({
      db,
      push: async (change) => {
        order.push(change.objectType);
        return "ok";
      },
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    expect(order).toEqual(["tag", "note_tag_link"]);
    await close();
  });

  it("uploads a folder before the note that sits in it", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-1",
      operation: "create",
      baseRevision: null,
    });
    await enqueueChange(db, {
      objectType: "folder",
      objectId: "folder-1",
      operation: "create",
      baseRevision: null,
    });

    const order: string[] = [];
    await syncNow({
      db,
      push: async (change) => {
        order.push(change.objectType);
        return "ok";
      },
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    expect(order).toEqual(["folder", "note"]);
    await close();
  });
});

describe("work that has to wait (§16)", () => {
  it("holds a link back while its note has not been created, and says when to try again", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-1",
      operation: "create",
      baseRevision: null,
    });
    await enqueueChange(db, {
      objectType: "note_attachment",
      objectId: "note-1",
      operation: "update",
      baseRevision: null,
    });

    const pushed: string[] = [];
    const outcome = await syncNow({
      db,
      push: async (change) => {
        pushed.push(change.objectType);
        return "ok";
      },
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    // The note goes; the link waits, because a link for a note the server has never heard of is a 404.
    expect(pushed).toEqual(["note"]);
    // And the wait is scheduled: without a time to wake up, the link waits for an unrelated edit instead.
    expect(outcome.nextRetryAt).not.toBeNull();
    await close();
  });

  it("sends the link once the note's create is gone", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note_attachment",
      objectId: "note-1",
      operation: "update",
      baseRevision: null,
    });

    const pushed: string[] = [];
    await syncNow({
      db,
      push: async (change) => {
        pushed.push(change.objectType);
        return "ok";
      },
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    expect(pushed).toEqual(["note_attachment"]);
    await close();
  });

  it("reports when a transient failure will be retried", async () => {
    const { db, close } = await freshDb();
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-1",
      operation: "update",
      baseRevision: 1,
    });

    const outcome = await syncNow({
      db,
      push: async () => "retry",
      pull: async (since) => ({ cursor: since, changes: [], hasMore: false }),
      apply: async () => "applied",
    });

    // A scheduled retry with nobody to honour it is just a delay, so the pass reports the time.
    expect(outcome.nextRetryAt).not.toBeNull();
    expect(outcome.nextRetryAt!).toBeGreaterThan(Date.now());
    await close();
  });
});
