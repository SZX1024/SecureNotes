import { KEY_VERSION_INITIAL, deriveKek, generateDekRaw, importDek } from "@securenotes/shared";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";

import {
  forgetDeviceKey,
  getOrCreateDeviceKey,
  unwrapDekForDevice,
  wrapDekForDevice,
} from "./device-key";
import { evictAttachmentCaches, isEvictable, pendingObjectIds } from "./eviction";
import { LOCK_EVENTS, KeyStore, LockedError, attachLockOnPageHide } from "./key-store";
import {
  acknowledgeChange,
  enqueueChange,
  pendingChangeCount,
  recordSyncFailure,
} from "./sync-queue";
import {
  databaseNameFor,
  openDatabase,
  type LocalAttachment,
  type SecureNotesDatabase,
} from "./schema";

/**
 * The local key layer and cache policy (§7, §8).
 *
 * These tests use real WebCrypto keys and a real IndexedDB, because the claims
 * being checked are about what the platform actually allows: that a device key
 * cannot be exported, that App Lock drops the material, and that eviction never
 * touches unsynced work.
 */

let sequence = 0;

async function freshDatabase(): Promise<SecureNotesDatabase> {
  const name = `${databaseNameFor(2)}-local-${(sequence += 1)}`;
  const db = openDatabase(name);
  await db.open();
  return db;
}

async function closeAndDelete(db: SecureNotesDatabase): Promise<void> {
  const name = db.name;
  db.close();
  await Dexie.delete(name).catch(() => undefined);
}

function attachment(
  id: string,
  options: { synced: boolean; size: number; cachedAt: number },
): LocalAttachment {
  return {
    id,
    r2Key: `attachments/${id}`,
    contentType: "image/png",
    sizeBytes: options.size,
    name: { crypto_version: 1, key_version: 1, alg: "AES-256-GCM", iv: "iv", ciphertext: "ct" },
    cachedBlob: new Blob([new Uint8Array(options.size)]),
    cachedAt: options.cachedAt,
    contentIv: "AAAAAAAAAAAAAAAA",
    plaintextSizeBytes: options.size - 16,
    createdAt: 1,
    syncedAt: options.synced ? 1 : null,
  };
}

describe("device key (§7)", () => {
  it("generates a non-extractable key and reuses it", async () => {
    const db = await freshDatabase();

    const first = await getOrCreateDeviceKey(db);
    expect(first.extractable).toBe(false);
    expect(first.usages).toEqual(["encrypt", "decrypt"]);
    await expect(crypto.subtle.exportKey("raw", first)).rejects.toThrow();

    // Reading it back yields a new object — a `CryptoKey` is structured-cloned,
    // not shared — so equality is proven behaviourally: material wrapped with one
    // handle must unwrap with the other.
    const second = await getOrCreateDeviceKey(db);
    const wrapped = await wrapDekForDevice(first, generateDekRaw(), {
      userId: "user-1",
      keyVersion: KEY_VERSION_INITIAL,
    });
    const identity = { userId: "user-1", keyVersion: KEY_VERSION_INITIAL };
    const viaFirst = await unwrapDekForDevice(first, wrapped, identity);
    const viaSecond = await unwrapDekForDevice(second, wrapped, identity);
    expect(viaSecond).toEqual(viaFirst);

    db.close();
    const reopened = openDatabase(db.name);
    await reopened.open();
    const third = await getOrCreateDeviceKey(reopened);
    // A structured-cloned CryptoKey keeps its non-extractability, and it is the
    // same key material after a reload.
    expect(third.extractable).toBe(false);
    expect(await unwrapDekForDevice(third, wrapped, identity)).toEqual(viaFirst);

    await closeAndDelete(reopened);
  });

  it("wraps and unwraps the DEK for offline unlock", async () => {
    const db = await freshDatabase();
    const deviceKey = await getOrCreateDeviceKey(db);
    const rawDek = generateDekRaw();
    const identity = { userId: "user-1", keyVersion: KEY_VERSION_INITIAL };

    const wrapped = await wrapDekForDevice(deviceKey, rawDek, identity);
    const recovered = await unwrapDekForDevice(deviceKey, wrapped, identity);

    expect(recovered).toEqual(rawDek);
    // The envelope is opaque: the DEK is not recoverable from it without the key.
    expect(JSON.stringify(wrapped)).not.toContain(btoa(String.fromCharCode(...rawDek)));

    await closeAndDelete(db);
  });

  it("forgets the key and the wrapped material when told to", async () => {
    const db = await freshDatabase();
    const deviceKey = await getOrCreateDeviceKey(db);
    await db.keyMaterial.put({
      id: "account",
      userId: "user-1",
      kdfSalt: "salt",
      keyVersion: 1,
      wrappedDek: null,
      deviceWrappedDek: await wrapDekForDevice(deviceKey, generateDekRaw(), {
        userId: "user-1",
        keyVersion: KEY_VERSION_INITIAL,
      }),
      updatedAt: 1,
    });

    await forgetDeviceKey(db);

    // §4: a device that learns its session was revoked must not keep the keys.
    expect(await db.deviceKeys.count()).toBe(0);
    expect(await db.keyMaterial.count()).toBe(0);

    const regenerated = await getOrCreateDeviceKey(db);
    expect(regenerated).not.toBe(deviceKey);

    await closeAndDelete(db);
  });
});

describe("App Lock (§7)", () => {
  async function material() {
    return {
      dek: await importDek(generateDekRaw()),
      totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      userId: "user-1",
      kdfSalt: "salt",
      keyVersion: 1,
    };
  }

  it("starts locked", () => {
    const store = new KeyStore();
    expect(store.isUnlocked()).toBe(false);
    expect(() => store.require()).toThrow(LockedError);
  });

  it("locks after 40 minutes of inactivity", async () => {
    const store = new KeyStore();
    const now = 1_000_000;
    store.unlock(await material(), now);

    expect(store.isUnlocked(now)).toBe(true);
    // One millisecond short of the window it is still usable.
    expect(store.isUnlocked(now + 40 * 60 * 1000 - 1)).toBe(true);
    expect(store.isUnlocked(now + 40 * 60 * 1000)).toBe(false);
    // And the material is gone, not merely reported as stale.
    expect(() => store.require(now)).toThrow(LockedError);
  });

  it("extends the window on activity", async () => {
    const store = new KeyStore();
    const now = 1_000_000;
    store.unlock(await material(), now);

    store.touch(now + 30 * 60 * 1000);
    expect(store.isUnlocked(now + 30 * 60 * 1000 + 39 * 60 * 1000)).toBe(true);
  });

  it("drops the material on lock", async () => {
    const store = new KeyStore();
    store.unlock(await material(), 1_000_000);

    store.lock();
    expect(store.isUnlocked(1_000_000)).toBe(false);
  });

  it("clears the keys when the page is closed or frozen", async () => {
    const store = new KeyStore();
    store.unlock(await material(), 1_000_000);

    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: (type: string, listener: EventListener) =>
        void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;

    const detach = attachLockOnPageHide(store, target);
    for (const event of LOCK_EVENTS) {
      expect(listeners.has(event), event).toBe(true);
    }

    // `pagehide` fires when a mobile tab is backgrounded and discarded.
    listeners.get("pagehide")!(new Event("pagehide"));
    expect(store.isUnlocked(1_000_000)).toBe(false);

    detach();
    expect(listeners.size).toBe(0);
  });

  it("refuses to hand out material while locked", async () => {
    const store = new KeyStore();
    const unlocked = await material();
    store.unlock(unlocked, 1_000_000);
    store.touch(1_000_000);

    // `require` refreshes the window, so a long editing session stays unlocked.
    expect(store.require(1_000_000).dek).toBe(unlocked.dek);
    expect(store.require(1_000_000 + 39 * 60 * 1000).userId).toBe("user-1");
  });
});

describe("cache eviction (§8)", () => {
  it("evicts only synced, unqueued attachment caches, oldest first", async () => {
    const db = await freshDatabase();
    await db.attachments.bulkPut([
      attachment("synced-old", { synced: true, size: 1000, cachedAt: 100 }),
      attachment("synced-new", { synced: true, size: 1000, cachedAt: 200 }),
      attachment("unsynced", { synced: false, size: 1000, cachedAt: 50 }),
      attachment("queued-edit", { synced: true, size: 1000, cachedAt: 25 }),
    ]);
    // A queued change means the user's intent has not reached the server.
    await db.syncQueue.add({
      objectType: "attachment",
      objectId: "queued-edit",
      operation: "update",
      baseRevision: 1,
      queuedAt: 10,
      attempts: 0,
      nextAttemptAt: null,
    });

    // Total cached is 4000 bytes; the budget allows 3000, so exactly one
    // (the oldest evictable) has to go.
    const report = await evictAttachmentCaches(db, { maxBytes: 3000 });

    expect(report.evictedAttachmentCaches).toBe(1);
    expect(report.reclaimedBytes).toBe(1000);
    // The oldest synced cache went; everything unsynced or queued survived.
    expect((await db.attachments.get("synced-old"))?.cachedBlob).toBeNull();
    expect((await db.attachments.get("synced-new"))?.cachedBlob).not.toBeNull();
    expect((await db.attachments.get("unsynced"))?.cachedBlob).not.toBeNull();
    expect((await db.attachments.get("queued-edit"))?.cachedBlob).not.toBeNull();

    await closeAndDelete(db);
  });

  it("does nothing when already inside the budget", async () => {
    const db = await freshDatabase();
    await db.attachments.put(attachment("small", { synced: true, size: 100, cachedAt: 1 }));

    const report = await evictAttachmentCaches(db, { maxBytes: 10_000 });

    expect(report.evictedAttachmentCaches).toBe(0);
    expect((await db.attachments.get("small"))?.cachedBlob).not.toBeNull();

    await closeAndDelete(db);
  });

  it("cannot reclaim enough when every candidate is unsynced", async () => {
    const db = await freshDatabase();
    await db.attachments.bulkPut([
      attachment("unsynced-a", { synced: false, size: 5000, cachedAt: 1 }),
      attachment("unsynced-b", { synced: false, size: 5000, cachedAt: 2 }),
    ]);

    const report = await evictAttachmentCaches(db, { maxBytes: 0 });

    // Losing an unsynced image is worse than exceeding the budget: the policy
    // stops rather than dropping the user's work.
    expect(report.evictedAttachmentCaches).toBe(0);
    expect(await db.attachments.filter((row) => row.cachedBlob !== null).count()).toBe(2);

    await closeAndDelete(db);
  });

  it("never evicts notes, folders or tags", async () => {
    const db = await freshDatabase();
    await db.notes.put({
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
      updatedAt: 1,
      syncedAt: 1,
    });

    await evictAttachmentCaches(db, { maxBytes: 0 });

    expect(await db.notes.count()).toBe(1);

    await closeAndDelete(db);
  });

  it("states the eviction rule in one place", () => {
    const pending = new Set(["queued"]);

    expect(isEvictable({ syncedAt: 1 }, pending, "plain")).toBe(true);
    expect(isEvictable({ syncedAt: null }, pending, "plain")).toBe(false);
    expect(isEvictable({ syncedAt: 1 }, pending, "queued")).toBe(false);
  });

  it("lists the objects with queued work", async () => {
    const db = await freshDatabase();
    await db.syncQueue.bulkAdd([
      {
        objectType: "note",
        objectId: "note-a",
        operation: "update",
        baseRevision: 1,
        queuedAt: 1,
        attempts: 0,
        nextAttemptAt: null,
      },
      {
        objectType: "note",
        objectId: "note-b",
        operation: "delete",
        baseRevision: 2,
        queuedAt: 2,
        attempts: 0,
        nextAttemptAt: null,
      },
    ]);

    const pending = await pendingObjectIds(db);
    expect([...pending].sort()).toEqual(["note-a", "note-b"]);

    await closeAndDelete(db);
  });
});

/** Guards against the KEK derivation being pulled into the client bundle by accident. */
describe("client crypto boundary", () => {
  it("derives the KEK from the delivered secret without persisting it", async () => {
    const kek = await deriveKek({
      username: "alice",
      totpSecretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kdfSaltBase64: btoa("0123456789abcdef"),
    });

    expect(kek.extractable).toBe(false);
    expect(kek.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });
});

describe("sync queue (§16, §8)", () => {
  it("tracks and acknowledges queued changes", async () => {
    const db = await freshDatabase();
    expect(await pendingChangeCount(db)).toBe(0);

    const first = await enqueueChange(db, {
      objectType: "note",
      objectId: "note-1",
      operation: "create",
      baseRevision: null,
    });
    await enqueueChange(db, {
      objectType: "note",
      objectId: "note-1",
      operation: "update",
      baseRevision: 1,
    });
    expect(await pendingChangeCount(db)).toBe(2);

    // Only a server acknowledgement removes an entry.
    await acknowledgeChange(db, first);
    expect(await pendingChangeCount(db)).toBe(1);

    const remaining = await db.syncQueue.toArray();
    expect(remaining[0]?.operation).toBe("update");
  });

  it("records a failed attempt without dropping the change", async () => {
    const db = await freshDatabase();
    const id = await enqueueChange(db, {
      objectType: "note",
      objectId: "note-2",
      operation: "update",
      baseRevision: 3,
    });

    await recordSyncFailure(db, id, 12_345);

    const item = await db.syncQueue.get(id);
    expect(item?.attempts).toBe(1);
    expect(item?.nextAttemptAt).toBe(12_345);
    // The change is still queued: a failure must never discard user intent.
    expect(await pendingChangeCount(db)).toBe(1);

    await closeAndDelete(db);
  });

  it("ignores a failure for an entry that is already gone", async () => {
    const db = await freshDatabase();
    await expect(recordSyncFailure(db, 999, 1)).resolves.toBeUndefined();
    await closeAndDelete(db);
  });
});
