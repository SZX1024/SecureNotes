import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_DATABASE_KEY,
  activeDatabaseName,
  activeSchemaVersion,
  openAppDatabase,
  storedDatabaseVersion,
  type StorageLike,
} from "./migrations";
import { SCHEMA_VERSION, openDatabase } from "./schema";
import { bytesToBase64, randomBytes } from "@securenotes/shared";

/**
 * Local database migration (§21).
 *
 * The requirement is unusually strict: "never destroy the last known-good
 * database before migration succeeds". These tests therefore check the failure
 * path as carefully as the happy one — an interrupted migration must leave the
 * old database active and complete.
 */

/** An in-memory `Storage` stand-in, so no global is shared between tests. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** A legacy-style database: version 1 only, as an older build would have left it. */
async function seedVersion1Database(name: string): Promise<void> {
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    notes: "id, folderId, updatedAt, deletedAt, syncedAt",
    folders: "id, parentId, updatedAt, syncedAt",
    tags: "id, updatedAt, syncedAt",
    noteTags: "[noteId+tagId], noteId, tagId",
    attachments: "id, syncedAt",
    syncQueue: "++id, objectId, queuedAt",
    keyMaterial: "id",
    meta: "key",
  });
  await legacy.open();

  await legacy.table("notes").bulkPut([
    {
      id: "note-1",
      folderId: null,
      revision: 1,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "iv",
        ciphertext: "ct",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 2,
      syncedAt: null,
    },
    {
      id: "note-2",
      folderId: null,
      revision: 3,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "iv",
        ciphertext: "ct",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 3,
      updatedAt: 4,
      syncedAt: 4,
    },
  ]);
  await legacy.table("attachments").put({
    id: "att-1",
    r2Key: "attachments/att-1",
    contentType: "image/png",
    sizeBytes: 128,
    name: { crypto_version: 1, key_version: 1, alg: "AES-256-GCM", iv: "iv", ciphertext: "ct" },
    cachedBlob: null,
    createdAt: 1,
    syncedAt: 1,
  });
  await legacy.table("syncQueue").add({
    objectType: "note",
    objectId: "note-1",
    operation: "update",
    baseRevision: 1,
    queuedAt: 5,
    attempts: 0,
    nextAttemptAt: null,
  });
  legacy.close();
}

let sequence = 0;

/**
 * A unique database name per test. IndexedDB state survives between tests in a
 * file and an open connection blocks deletion, so sharing a fixed name would let
 * one failure corrupt every later test.
 */
function freshNames(): { v1: string; target: string } {
  const suffix = `case-${(sequence += 1)}`;
  return { v1: `${suffix}-v1`, target: `${suffix}-v${SCHEMA_VERSION}` };
}

/** Storage pointing at a given database, so the migration works on that one. */
function storageFor(name: string, extra: Record<string, string> = {}): StorageLike {
  return memoryStorage({ [ACTIVE_DATABASE_KEY]: name, ...extra });
}

describe("local schema migration (§21)", () => {
  it("copies an older database into a new one and only then switches", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);
    await seedVersion1Database(names.v1);

    expect(activeSchemaVersion(storage)).toBe(1);

    const { db, report } = await openAppDatabase(storage);

    expect(report.migrated).toBe(true);
    expect(report.fromVersion).toBe(1);
    expect(report.toVersion).toBe(SCHEMA_VERSION);

    // The data survived, including the queue entry that represents unsynced work.
    expect(await db.notes.count()).toBe(2);
    expect(await db.syncQueue.count()).toBe(1);
    const note = await db.notes.get("note-2");
    expect(note?.revision).toBe(3);
    expect(note?.syncedAt).toBe(4);

    // The new version's transform ran.
    const attachment = await db.attachments.get("att-1");
    expect(attachment?.cachedAt).toBeNull();

    // And the pointer now names the new database.
    expect(activeDatabaseName(storage)).toBe(names.target);
    expect(activeSchemaVersion(storage)).toBe(SCHEMA_VERSION);

    // The previous copy is gone only after the switch succeeded.
    expect(await Dexie.exists(names.v1)).toBe(false);

    db.close();
  });

  it("keeps the old database active and intact when the switch fails", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);
    await seedVersion1Database(names.v1);

    // Fail at the final step: the pointer cannot be written, so the migration
    // never reaches the point where it deletes the previous database.
    const failing: StorageLike = {
      getItem: (key) => storage.getItem(key),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: (key) => storage.removeItem(key),
    };

    await expect(openAppDatabase(failing)).rejects.toThrow();

    // The last known-good database is still the active one, still complete.
    expect(activeSchemaVersion(storage)).toBe(1);
    expect(activeDatabaseName(storage)).toBe(names.v1);
    expect(await Dexie.exists(names.v1)).toBe(true);

    const reopened = openDatabase(names.v1, 1);
    await reopened.open();
    expect(await reopened.notes.count()).toBe(2);
    expect(await reopened.syncQueue.count()).toBe(1);
    reopened.close();
  });

  it("does nothing when the stored version is already current", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);
    const first = await openAppDatabase(storage);
    await first.db.notes.put({
      id: "note-3",
      folderId: null,
      revision: 1,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "iv",
        ciphertext: "ct",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: null,
    });
    first.db.close();

    const second = await openAppDatabase(storage);

    expect(second.report.migrated).toBe(false);
    expect(await second.db.notes.count()).toBe(1);
    second.db.close();
  });

  it("discards a half-built target instead of trusting it", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);
    await seedVersion1Database(names.v1);

    // A previous attempt left a partially populated target behind.
    const stale = openDatabase(names.target);
    await stale.open();
    await stale.notes.put({
      id: "ghost",
      folderId: null,
      revision: 99,
      payload: {
        crypto_version: 1,
        key_version: 1,
        alg: "AES-256-GCM",
        iv: "iv",
        ciphertext: "ct",
      },
      deletedAt: null,
      pinned: false,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      syncedAt: null,
    });
    stale.close();

    const { db } = await openAppDatabase(storage);

    // The ghost row must not survive into the migrated database.
    expect(await db.notes.get("ghost")).toBeUndefined();
    expect(await db.notes.count()).toBe(2);
    db.close();
  });

  it("reads an older version without modifying the stored database", async () => {
    const name = freshNames().target;
    const current = openDatabase(name);
    await current.open();
    await current.deviceKeys.put({ id: "device", key: await makeDeviceKey(), createdAt: 1 });
    expect(current.verno).toBe(SCHEMA_VERSION);
    current.close();

    // Declaring only version 1 must expose the older view and leave the stored
    // database — including tables added in v2 — completely untouched.
    const legacyView = openDatabase(name, 1);
    await legacyView.open();
    expect(legacyView.verno).toBe(1);
    expect(legacyView.tables.map((table) => table.name)).not.toContain("deviceKeys");
    legacyView.close();

    expect(await storedDatabaseVersion(name)).toBe(SCHEMA_VERSION);
    const reopened = openDatabase(name);
    await reopened.open();
    expect(await reopened.deviceKeys.count()).toBe(1);
    reopened.close();

    await Dexie.delete(name);
  });

  it("creates the current version directly on a fresh device", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);

    const { db, report } = await openAppDatabase(storage);

    expect(report.migrated).toBe(false);
    expect(report.fromVersion).toBe(0);
    expect(db.verno).toBe(SCHEMA_VERSION);
    expect(activeDatabaseName(storage)).toBe(names.target);
    db.close();
  });

  it("keeps the wrapped DEK across the migration", async () => {
    const names = freshNames();
    const storage = storageFor(names.v1);
    await seedVersion1Database(names.v1);

    const legacy = openDatabase(names.v1, 1);
    await legacy.open();
    const wrappedDek = {
      crypto_version: 1,
      key_version: 1,
      alg: "AES-256-GCM" as const,
      iv: bytesToBase64(randomBytes(12)),
      ciphertext: bytesToBase64(randomBytes(64)),
    };
    await legacy.keyMaterial.put({
      id: "account",
      userId: "user-1",
      kdfSalt: bytesToBase64(randomBytes(16)),
      keyVersion: 1,
      wrappedDek,
      deviceWrappedDek: null,
      updatedAt: 1,
    });
    legacy.close();

    const { db } = await openAppDatabase(storage);

    // Losing key material in a migration would make every note unreadable.
    const material = await db.keyMaterial.get("account");
    expect(material?.wrappedDek).toEqual(wrappedDek);
    expect(material?.userId).toBe("user-1");
    db.close();
  });
});

/** A real non-extractable device key, for the tables that store one. */
async function makeDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
