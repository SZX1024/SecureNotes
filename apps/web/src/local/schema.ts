import Dexie, { type EntityTable } from "dexie";
import type { CryptoEnvelope } from "@securenotes/shared";

/**
 * Local database schema (§8, §21).
 *
 * Everything stored here is either ciphertext or metadata the server may also
 * see. The only key material is a *wrapped* DEK — never a plaintext key — and
 * never note plaintext: decrypted content exists only in memory while the app is
 * unlocked (§7).
 *
 * Every version is declared in `SCHEMA_DEFINITIONS`, and a database can be opened
 * *up to* a version. That is what lets the migration runner read an old database
 * without Dexie silently upgrading it in place.
 */

/** Ciphertext of a note, plus the fields sync needs. */
export interface LocalNote {
  id: string;
  folderId: string | null;
  revision: number;
  /** The encrypted Markdown payload; the title lives inside it. */
  payload: CryptoEnvelope;
  deletedAt: number | null;
  /** §10: pinning and manual drag order are per-note organisation. */
  pinned: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** When the server last confirmed this revision; null means never synced. */
  syncedAt: number | null;
}

export interface LocalFolder {
  id: string;
  parentId: string | null;
  depth: number;
  /** The revision the name envelope was encrypted under (§16). */
  revision: number;
  name: CryptoEnvelope;
  deletedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  syncedAt: number | null;
}

export interface LocalTag {
  id: string;
  name: CryptoEnvelope;
  createdAt: number;
  updatedAt: number;
  syncedAt: number | null;
}

export interface LocalNoteTag {
  noteId: string;
  tagId: string;
  syncedAt: number | null;
}

export interface LocalAttachment {
  id: string;
  r2Key: string;
  contentType: string;
  sizeBytes: number;
  name: CryptoEnvelope;
  /**
   * Cached ciphertext, evictable because it can be re-downloaded (§8).
   *
   * It is also what makes an attachment inserted while offline possible: the bytes are encrypted here, held, and
   * uploaded when the network returns.
   */
  cachedBlob: Blob | null;
  cachedAt: number | null;
  /** The IV the cached ciphertext was produced with, needed to upload or decrypt it later. */
  contentIv: string | null;
  plaintextSizeBytes: number | null;
  /**
   * When this file should be removed, or null to keep it.
   *
   * Optional in the type because rows written before temporary attachments existed have no such field, and an
   * attachment that predates the feature is exactly the one that must be kept.
   */
  expiresAt?: number | null;
  createdAt: number;
  syncedAt: number | null;
}

/**
 * The upload queue (§16). Entries are never dropped automatically: an unsynced
 * change is the one thing the app must not lose (§8).
 */
export interface SyncQueueItem {
  id?: number;
  objectType: string;
  objectId: string;
  operation: "create" | "update" | "delete";
  baseRevision: number | null;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number | null;
}

/** The account's wrapped key material, mirroring what the server stores. */
export interface LocalKeyMaterial {
  id: "account";
  userId: string;
  kdfSalt: string;
  keyVersion: number;
  /** DEK wrapped by the KEK, portable across devices. */
  wrappedDek: CryptoEnvelope | null;
  /** DEK wrapped by this device's non-extractable key, for offline unlock. */
  deviceWrappedDek: CryptoEnvelope | null;
  updatedAt: number;
}

/**
 * The device key itself. `CryptoKey` is structured-cloneable, so a
 * non-extractable key can be persisted and still never be read back as bytes.
 */
export interface LocalDeviceKey {
  id: "device";
  key: CryptoKey;
  createdAt: number;
}

export interface LocalMeta {
  key: string;
  value: unknown;
}

export interface SchemaDefinition {
  version: number;
  stores: Record<string, string>;
}

/**
 * The schema, in version order. A new version is appended and never edited, so an
 * old installation always has a definition it can be read with.
 */
export const SCHEMA_DEFINITIONS: readonly SchemaDefinition[] = [
  {
    version: 1,
    stores: {
      notes: "id, folderId, updatedAt, deletedAt, syncedAt",
      folders: "id, parentId, updatedAt, syncedAt",
      tags: "id, updatedAt, syncedAt",
      noteTags: "[noteId+tagId], noteId, tagId",
      attachments: "id, syncedAt",
      syncQueue: "++id, objectId, queuedAt",
      keyMaterial: "id",
      meta: "key",
    },
  },
  {
    // Adds the device key store (§7) and indexes the queue by time so the oldest
    // pending change can be found without a full scan.
    version: 2,
    stores: {
      notes: "id, folderId, updatedAt, deletedAt, syncedAt",
      folders: "id, parentId, updatedAt, syncedAt",
      tags: "id, updatedAt, syncedAt",
      noteTags: "[noteId+tagId], noteId, tagId",
      attachments: "id, syncedAt, cachedAt",
      syncQueue: "++id, objectId, queuedAt, nextAttemptAt",
      keyMaterial: "id",
      deviceKeys: "id",
      meta: "key",
    },
  },
  {
    // Version 3 adds the organisation fields §10 needs on a note (pinning and
    // manual order). The indexes are unchanged: this is a row-shape change, and
    // the migration supplies the defaults for existing rows.
    version: 3,
    stores: {
      notes: "id, folderId, updatedAt, deletedAt, syncedAt",
      folders: "id, parentId, updatedAt, syncedAt",
      tags: "id, updatedAt, syncedAt",
      noteTags: "[noteId+tagId], noteId, tagId",
      attachments: "id, syncedAt, cachedAt",
      syncQueue: "++id, objectId, queuedAt, nextAttemptAt",
      keyMaterial: "id",
      deviceKeys: "id",
      meta: "key",
    },
  },
  {
    // Version 4 gives folders a revision, so a folder move can be compared against the one it was based
    // on instead of overwriting (§16). Like version 3 this is a row-shape change, and the migration
    // supplies the default for existing rows.
    version: 4,
    stores: {
      notes: "id, folderId, updatedAt, deletedAt, syncedAt",
      folders: "id, parentId, updatedAt, syncedAt",
      tags: "id, updatedAt, syncedAt",
      noteTags: "[noteId+tagId], noteId, tagId",
      attachments: "id, syncedAt, cachedAt",
      syncQueue: "++id, objectId, queuedAt, nextAttemptAt",
      keyMaterial: "id",
      deviceKeys: "id",
      meta: "key",
    },
  },
  {
    // Version 5 gives an attachment the IV and plaintext size of its content, so bytes encrypted while offline can
    // be uploaded later and decrypted from the cache without asking the server for anything.
    version: 5,
    stores: {
      notes: "id, folderId, updatedAt, deletedAt, syncedAt",
      folders: "id, parentId, updatedAt, syncedAt",
      tags: "id, updatedAt, syncedAt",
      noteTags: "[noteId+tagId], noteId, tagId",
      attachments: "id, syncedAt, cachedAt",
      syncQueue: "++id, objectId, queuedAt, nextAttemptAt",
      keyMaterial: "id",
      deviceKeys: "id",
      meta: "key",
    },
  },
];

export const SCHEMA_VERSION = SCHEMA_DEFINITIONS[SCHEMA_DEFINITIONS.length - 1]!.version;

/** Database names are versioned so a migration never overwrites the old copy. */
export function databaseNameFor(version: number): string {
  return `securenotes-v${version}`;
}

export class SecureNotesDatabase extends Dexie {
  notes!: EntityTable<LocalNote, "id">;
  folders!: EntityTable<LocalFolder, "id">;
  tags!: EntityTable<LocalTag, "id">;
  noteTags!: EntityTable<LocalNoteTag, "noteId">;
  attachments!: EntityTable<LocalAttachment, "id">;
  syncQueue!: EntityTable<SyncQueueItem, "id">;
  keyMaterial!: EntityTable<LocalKeyMaterial, "id">;
  deviceKeys!: EntityTable<LocalDeviceKey, "id">;
  meta!: EntityTable<LocalMeta, "key">;

  /**
   * @param maxVersion highest schema version to declare.
   *
   * Declaring *fewer* versions than the stored database has is safe and is what
   * the migration runner relies on: verified against Dexie 4, opening such a
   * database exposes only the declared tables and leaves the stored version —
   * and therefore the data — untouched. Dexie only ever upgrades in place when
   * the declared version is higher than the stored one, which this code never
   * does for an existing database.
   */
  constructor(name: string, maxVersion: number = SCHEMA_VERSION) {
    super(name);
    for (const definition of SCHEMA_DEFINITIONS) {
      if (definition.version > maxVersion) {
        break;
      }
      this.version(definition.version).stores(definition.stores);
    }
  }
}

/** Opens the database, declaring at most `maxVersion`. */
export function openDatabase(
  name: string,
  maxVersion: number = SCHEMA_VERSION,
): SecureNotesDatabase {
  return new SecureNotesDatabase(name, maxVersion);
}
