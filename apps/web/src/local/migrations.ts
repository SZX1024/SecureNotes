import Dexie from "dexie";

import {
  SCHEMA_DEFINITIONS,
  SCHEMA_VERSION,
  databaseNameFor,
  openDatabase,
  type SecureNotesDatabase,
} from "./schema";

/**
 * Versioned local migration (§21).
 *
 * "Preserve the old database while creating/migrating the new schema; switch
 * only after successful migration. Never destroy the last known-good database
 * before migration succeeds."
 *
 * Dexie's own `version().upgrade()` mutates the database in place, which cannot
 * satisfy that: an interrupted upgrade leaves the only copy half-converted. So
 * each migration instead runs into a *new* database, verifies the result, and
 * only then moves the pointer and deletes the previous copy. A failure at any
 * point leaves the old database active and untouched.
 */

/** Where the name of the active database is recorded. */
export const ACTIVE_DATABASE_KEY = "securenotes.activeDatabase";

/** Storage key holding the schema version the active database was built with. */
export const SCHEMA_VERSION_KEY = "securenotes.schemaVersion";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
  /** Rows copied per table, for the verification step and for diagnostics. */
  copied: Record<string, number>;
}

export class LocalMigrationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalMigrationError";
  }
}

function readNumber(storage: StorageLike, key: string): number | null {
  const raw = storage.getItem(key);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads the version a stored database actually has, or null when it does not
 * exist. This is the database's own version, not a note we keep about it: the
 * metadata could be stale after a crash, and migrating from a wrong `fromVersion`
 * would copy the wrong set of tables and then delete the real database.
 *
 * Dexie multiplies its schema version by ten before writing it to IndexedDB —
 * that is how it represents sub-versions such as 1.1 — so the raw value is scaled
 * back down here. Only call this for a database that already exists: opening a
 * missing one creates it.
 */
export async function storedDatabaseVersion(name: string): Promise<number | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const raw = request.result.version;
      request.result.close();
      resolve(Math.max(1, Math.round(raw / 10)));
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * The name a migration writes to: the source name with its version suffix moved
 * forward, so two databases never collide and a partially finished target can
 * always be recognised by name.
 */
export function targetNameFor(sourceName: string, targetVersion: number): string {
  return /-v\d+$/.test(sourceName)
    ? sourceName.replace(/-v\d+$/, `-v${targetVersion}`)
    : `${sourceName}-v${targetVersion}`;
}

/** Reads the schema version recorded for the active database. */
export function activeSchemaVersion(storage: StorageLike): number {
  return readNumber(storage, SCHEMA_VERSION_KEY) ?? 1;
}

/** Reads the active database's name. */
export function activeDatabaseName(storage: StorageLike): string {
  return storage.getItem(ACTIVE_DATABASE_KEY) ?? databaseNameFor(1);
}

/**
 * Transforms one row while moving from `fromVersion` to `fromVersion + 1`.
 *
 * Kept as a pure function per step so a migration is testable without a
 * database, and so a step can never reach into another table by accident.
 */
export type RowTransform = (table: string, row: Record<string, unknown>) => Record<string, unknown>;

/** The transforms applied when upgrading to a given version. */
export const UPGRADES: Readonly<Record<number, RowTransform>> = {
  // 1 -> 2: the device key store is new, and attachments gain a cache timestamp.
  // Existing rows simply gain the new nullable field.
  2: (table, row) => {
    if (table === "attachments") {
      return { cachedAt: null, ...row };
    }
    return row;
  },
  // 2 -> 3: notes gain pinning and manual order. Existing notes are not pinned
  // and keep insertion order, which is what the defaults express.
  3: (table, row) => {
    if (table === "notes") {
      return { pinned: false, sortOrder: 0, ...row };
    }
    return row;
  },
};

/**
 * The tables a version declares, in the order they must be copied (parents before
 * children). Reading this per version is what keeps a migration from touching a
 * table the older database never had — a table added in a later version simply
 * has nothing to carry over.
 */
export function tablesForVersion(version: number): string[] {
  const definition = SCHEMA_DEFINITIONS.find((entry) => entry.version === version);
  return definition ? Object.keys(definition.stores) : [];
}

/** Dependency-ordered copy list: the union of every version's tables. */
const ALL_TABLES = Array.from(
  new Set(SCHEMA_DEFINITIONS.flatMap((definition) => Object.keys(definition.stores))),
);

async function copyTable(
  source: SecureNotesDatabase,
  target: SecureNotesDatabase,
  table: string,
  transform: RowTransform,
): Promise<number> {
  const rows = (await source.table(table).toArray()) as Record<string, unknown>[];
  const transformed = rows.map((row) => transform(table, row));
  if (transformed.length > 0) {
    await target.table(table).bulkPut(transformed);
  }
  return transformed.length;
}

/**
 * Opens the application database, migrating first when the stored schema
 * version is behind. Never destroys the previous database before the new one is
 * complete and verified.
 */
export async function openAppDatabase(
  storage: StorageLike,
  options: { targetVersion?: number } = {},
): Promise<{ db: SecureNotesDatabase; report: MigrationReport }> {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const sourceName = activeDatabaseName(storage);

  // Existence is checked before anything else: `indexedDB.open` creates a
  // database as a side effect, so probing a fresh device would otherwise leave an
  // empty database behind and report it as an installation to migrate.
  const exists = await Dexie.exists(sourceName);
  const stored = exists ? await storedDatabaseVersion(sourceName) : null;

  const targetName = targetNameFor(sourceName, targetVersion);

  if (stored === null) {
    // First run on this device: nothing to carry over, so the target is created
    // directly under its versioned name.
    const db = openDatabase(targetName, targetVersion);
    await db.open();
    storage.setItem(ACTIVE_DATABASE_KEY, targetName);
    storage.setItem(SCHEMA_VERSION_KEY, String(targetVersion));
    return {
      db,
      report: { fromVersion: 0, toVersion: targetVersion, migrated: false, copied: {} },
    };
  }

  if (stored >= targetVersion) {
    const db = openDatabase(sourceName, stored);
    await db.open();
    return {
      db,
      report: { fromVersion: stored, toVersion: stored, migrated: false, copied: {} },
    };
  }

  // The database's own version decides what has to be migrated, not our note.
  const fromVersion = stored;
  // The source is opened *up to its own version*: Dexie then exposes only the
  // tables that version had and leaves the stored database untouched, which is
  // what keeps the last known-good copy intact until the switch succeeds.
  const source = openDatabase(sourceName, fromVersion);
  const target = openDatabase(targetName, targetVersion);

  // Only tables the older schema actually had can carry rows over; tables added
  // by a later version start empty by design.
  const sourceTables = new Set(tablesForVersion(fromVersion));
  const copiedTables = ALL_TABLES.filter((table) => sourceTables.has(table));

  try {
    await source.open();
    await target.open();

    // A leftover target from an interrupted attempt must not be trusted.
    for (const table of ALL_TABLES) {
      await target.table(table).clear();
    }

    // Every applicable step is composed into one transformation and applied in a
    // single pass. Copying once per version would let a later pass write a row
    // that a previous pass had already enriched, silently dropping its defaults.
    const steps: RowTransform[] = [];
    for (let version = fromVersion + 1; version <= targetVersion; version += 1) {
      steps.push(UPGRADES[version] ?? ((_table, row) => row));
    }
    const transform: RowTransform = (table, row) =>
      steps.reduce((current, step) => step(table, current), row);

    const copied: Record<string, number> = {};
    for (const table of copiedTables) {
      copied[table] = await copyTable(source, target, table, transform);
    }

    // Verification: the new database must hold at least everything the old one
    // held. A mismatch aborts the switch, leaving the old database authoritative.
    for (const table of copiedTables) {
      const expected = await source.table(table).count();
      const actual = await target.table(table).count();
      if (actual < expected) {
        throw new LocalMigrationError(
          `migration verification failed for ${table}: copied ${actual} of ${expected}`,
        );
      }
    }

    // Only now is it safe to make the new database the active one.
    storage.setItem(ACTIVE_DATABASE_KEY, targetName);
    storage.setItem(SCHEMA_VERSION_KEY, String(targetVersion));

    source.close();
    await Dexie.delete(sourceName);

    return {
      db: target,
      report: { fromVersion, toVersion: targetVersion, migrated: true, copied },
    };
  } catch (error) {
    // The old database is still active and intact; the half-built new one is
    // discarded so a retry starts from a clean slate.
    target.close();
    await Dexie.delete(targetName).catch(() => undefined);
    source.close();
    // The cause is carried into the message: this error is developer-facing and
    // "migration failed" alone is not actionable.
    const cause = error instanceof Error ? error.message : String(error);
    throw error instanceof LocalMigrationError
      ? error
      : new LocalMigrationError(`local migration to v${targetVersion} failed: ${cause}`, error);
  }
}
