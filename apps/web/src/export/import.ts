import { encryptObject, utf8, type Bytes, type CryptoEnvelope } from "@securenotes/shared";

import { aadFor } from "../local/aad";
import { enqueueChange } from "../local/sync-queue";
import type { SecureNotesDatabase } from "../local/schema";
import { ArchiveError, type ExportArchive } from "./archive";

/**
 * Importing an archive (§20).
 *
 * Two phases, and the split is the requirement: everything is planned on plain data first, then applied inside a
 * single database transaction, so a failure anywhere leaves the database exactly as it was. §20 says the import
 * is transactional, and that is the only way to be sure of it.
 *
 * Duplicate ids are a choice, not a decision this code makes: merging and remapping are both defensible and they
 * produce different histories, so §20 requires the user to pick. Nothing here overwrites unconditionally.
 */

export type ImportChoice = "merge" | "remap";

export interface ExistingIds {
  noteIds: readonly string[];
  folderIds: readonly string[];
  tagIds: readonly string[];
}

export interface ImportCounts {
  created: number;
  merged: number;
  remapped: number;
  unchanged: number;
}

export const EMPTY_IMPORT_COUNTS: ImportCounts = {
  created: 0,
  merged: 0,
  remapped: 0,
  unchanged: 0,
};

export interface PlannedNote {
  /** The id the note will have here. */
  id: string;
  folderId: string | null;
  tagIds: string[];
  pinned: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  markdown: string;
  /** Set when an existing note with this id is being replaced or remapped. */
  replacesId: string | null;
}

export interface PlannedFolder {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
}

export interface PlannedTag {
  id: string;
  name: string;
}

export interface PlannedAttachment {
  id: string;
  filename: string;
  contentType: string;
  bytes: Bytes;
  noteIds: string[];
}

export interface ImportPlan {
  notes: PlannedNote[];
  folders: PlannedFolder[];
  tags: PlannedTag[];
  attachments: PlannedAttachment[];
  counts: ImportCounts;
  /** The ids the plan replaced, per kind, for the report the user reads. */
  mergedIds: { notes: string[]; folders: string[]; tags: string[] };
}

export interface PlanInput {
  archive: ExportArchive;
  existing: ExistingIds;
  /** Existing rows a merge has to reason about: their age decides which version of a note survives. */
  existingNotes: ReadonlyArray<{ id: string; updatedAt: number; tagIds: readonly string[] }>;
  choice: ImportChoice;
  /** Injected so a remap is deterministic under test. */
  newId: () => string;
}

/**
 * Decides what the import will do, and writes nothing.
 *
 * The rules are small on purpose: a merge keeps the newer version of a note and the union of its tags, and a
 * remap gives every colliding object a new id and rewrites what referred to it. Anything else would be this code
 * guessing which of two histories the user meant.
 */
export function planImport(input: PlanInput): ImportPlan {
  const { archive, choice, newId } = input;
  const folderIds = new Set(input.existing.folderIds);
  const tagIds = new Set(input.existing.tagIds);
  const noteIds = new Set(input.existing.noteIds);
  const localNotes = new Map(input.existingNotes.map((note) => [note.id, note]));

  const counts: ImportCounts = { ...EMPTY_IMPORT_COUNTS };
  const mergedIds = { notes: [] as string[], folders: [] as string[], tags: [] as string[] };

  // Folders first: a note's folder has to be resolved before the note is planned.
  const folderRemap = new Map<string, string>();
  const folders: PlannedFolder[] = [];
  for (const folder of archive.folders) {
    const collides = folderIds.has(folder.id);
    if (!collides) {
      folders.push({ ...folder });
      counts.created += 1;
      continue;
    }
    if (choice === "remap") {
      const id = newId();
      folderRemap.set(folder.id, id);
      folders.push({ ...folder, id });
      counts.remapped += 1;
      continue;
    }
    // Merging a folder keeps the one that is already here: its name is the user's current name for it, and the
    // notes filed under it are already filed under it.
    counts.unchanged += 1;
  }

  const tagRemap = new Map<string, string>();
  const tags: PlannedTag[] = [];
  for (const tag of archive.tags) {
    const collides = tagIds.has(tag.id);
    if (!collides) {
      tags.push({ ...tag });
      counts.created += 1;
      continue;
    }
    if (choice === "remap") {
      const id = newId();
      tagRemap.set(tag.id, id);
      tags.push({ ...tag, id });
      counts.remapped += 1;
      continue;
    }
    counts.unchanged += 1;
  }

  const noteRemap = new Map<string, string>();
  const notes: PlannedNote[] = [];
  for (const note of archive.notes) {
    const folderId =
      note.folderId === null ? null : (folderRemap.get(note.folderId) ?? note.folderId);
    const tagIdsAfterRemap = note.tagIds.map((tagId) => tagRemap.get(tagId) ?? tagId);
    const collides = noteIds.has(note.id);

    if (!collides) {
      notes.push({
        id: note.id,
        folderId,
        tagIds: tagIdsAfterRemap,
        pinned: note.pinned,
        sortOrder: note.sortOrder,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        markdown: note.markdown,
        replacesId: null,
      });
      counts.created += 1;
      continue;
    }

    if (choice === "remap") {
      const id = newId();
      noteRemap.set(note.id, id);
      notes.push({
        id,
        folderId,
        tagIds: tagIdsAfterRemap,
        pinned: note.pinned,
        sortOrder: note.sortOrder,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        markdown: note.markdown,
        replacesId: null,
      });
      counts.remapped += 1;
      continue;
    }

    // Merging: the newer text wins, and the tags are the union. A note that has not changed since it was
    // exported is left exactly as it is, which is the common case for an archive imported onto the device it
    // came from.
    const local = localNotes.get(note.id);
    const archiveIsNewer = local !== undefined && note.updatedAt > local.updatedAt;
    const union = [...new Set([...(local?.tagIds ?? []), ...tagIdsAfterRemap])];

    if (!archiveIsNewer) {
      // The local note is kept; only tags it does not carry are added.
      const added = tagIdsAfterRemap.filter((tagId) => !(local?.tagIds ?? []).includes(tagId));
      if (added.length === 0) {
        counts.unchanged += 1;
        continue;
      }
      notes.push({
        id: note.id,
        folderId: null,
        tagIds: union,
        pinned: note.pinned,
        sortOrder: note.sortOrder,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        // Empty text with `replacesId` set means "keep the text that is already here".
        markdown: "",
        replacesId: note.id,
      });
      mergedIds.notes.push(note.id);
      counts.merged += 1;
      continue;
    }

    notes.push({
      id: note.id,
      folderId,
      tagIds: union,
      pinned: note.pinned,
      sortOrder: note.sortOrder,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      markdown: note.markdown,
      replacesId: note.id,
    });
    mergedIds.notes.push(note.id);
    counts.merged += 1;
  }

  const attachments: PlannedAttachment[] = archive.attachments.map((attachment) => ({
    ...attachment,
    // A remapped note is a different note, so what referred to the old id refers to the new one.
    noteIds: attachment.noteIds.map((noteId) => noteRemap.get(noteId) ?? noteId),
  }));

  return { notes, folders, tags, attachments, counts, mergedIds };
}

export interface ApplyInput {
  db: SecureNotesDatabase;
  dek: CryptoKey;
  keyVersion: number;
  plan: ImportPlan;
  now: number;
  /**
   * Uploads one attachment and returns the id it was stored under.
   *
   * The upload happens before the transaction, because a transaction cannot span the network. An upload whose
   * transaction then fails leaves an unreferenced attachment on the server, which is exactly what the reference
   * sweep exists to collect (§8).
   */
  uploadAttachment: (attachment: PlannedAttachment) => Promise<string>;
}

export interface ImportReport extends ImportCounts {
  attachments: number;
}

/**
 * Applies the plan inside one transaction.
 *
 * The work is split in two, and the split is not cosmetic. A Dexie transaction cannot span an `await` of
 * something that is not a Dexie operation: doing the encryption inside the transaction made Dexie commit it
 * before the writes happened — a `PrematureCommitError` in the tests, and in production an import that was not
 * transactional at all, which is the one thing §20 rules out. So every envelope is encrypted and every upload is
 * performed first, and the transaction contains nothing but database writes.
 *
 * Because the transaction covers the rows, the links, the attachment metadata **and** the queued changes, a
 * failure at any point leaves the database as it was: an import that half-queued its work would leave the device
 * disagreeing with itself forever.
 */
export async function applyImport(input: ApplyInput): Promise<ImportReport> {
  const { db, dek, keyVersion, plan, now } = input;

  const uploadedIds = new Map<string, string>();
  for (const attachment of plan.attachments) {
    uploadedIds.set(attachment.id, await input.uploadAttachment(attachment));
  }

  type Write = () => Promise<unknown>;
  const writes: Write[] = [];

  for (const folder of plan.folders) {
    const parent = folder.parentId === null ? null : await db.folders.get(folder.parentId);
    const name = await encryptObject(
      dek,
      aadFor("folder", folder.id, 1, keyVersion),
      utf8(folder.name),
    );
    writes.push(async () => {
      await db.folders.put({
        id: folder.id,
        parentId: folder.parentId,
        // The tree's depth rule, applied as the row is written: a placeholder would make a nested folder look
        // like a root until something else recomputed it.
        depth: parent ? parent.depth + 1 : 1,
        revision: 1,
        name,
        deletedAt: null,
        sortOrder: folder.sortOrder,
        createdAt: now,
        updatedAt: now,
        syncedAt: null,
      });
      await enqueueChange(db, {
        objectType: "folder",
        objectId: folder.id,
        operation: "create",
        baseRevision: null,
      });
    });
  }

  for (const tag of plan.tags) {
    const name = await encryptObject(dek, aadFor("tag", tag.id, 1, keyVersion), utf8(tag.name));
    writes.push(async () => {
      await db.tags.put({ id: tag.id, name, createdAt: now, updatedAt: now, syncedAt: null });
      await enqueueChange(db, {
        objectType: "tag",
        objectId: tag.id,
        operation: "create",
        baseRevision: null,
      });
    });
  }

  for (const note of plan.notes) {
    const existing = await db.notes.get(note.id);
    // `markdown: ""` with `replacesId` set means the text already here is the one to keep.
    const keepLocalText = note.markdown === "" && note.replacesId !== null;
    const revision = keepLocalText ? existing!.revision : existing ? existing.revision + 1 : 1;
    const payload = keepLocalText
      ? (existing!.payload as CryptoEnvelope)
      : await encryptObject(
          dek,
          aadFor("note", note.id, revision, keyVersion),
          utf8(note.markdown),
        );
    const row = {
      id: note.id,
      folderId: note.folderId ?? existing?.folderId ?? null,
      revision,
      payload,
      deletedAt: null,
      pinned: note.pinned,
      sortOrder: note.sortOrder,
      createdAt: existing?.createdAt ?? note.createdAt,
      updatedAt: now,
      syncedAt: null,
    };
    const baseRevision = existing ? existing.revision : null;

    writes.push(async () => {
      await db.notes.put(row);
      await enqueueChange(db, {
        objectType: "note",
        objectId: note.id,
        operation: existing ? "update" : "create",
        baseRevision,
      });
      await db.noteTags.where("noteId").equals(note.id).delete();
      for (const tagId of note.tagIds) {
        await db.noteTags.put({ noteId: note.id, tagId, syncedAt: null });
      }
      // The set is uploaded as a whole, which is how the tag endpoint works.
      await enqueueChange(db, {
        objectType: "note_tag_link",
        objectId: note.id,
        operation: "update",
        baseRevision: null,
      });
    });
  }

  for (const attachment of plan.attachments) {
    const id = uploadedIds.get(attachment.id)!;
    const name = await encryptObject(
      dek,
      aadFor("attachment_meta", id, 1, keyVersion),
      utf8(attachment.filename),
    );
    writes.push(async () => {
      await db.attachments.put({
        id,
        r2Key: `attachments/${id}`,
        contentType: attachment.contentType,
        // The encrypted size is what the server counts; the exact number is confirmed when the upload lands.
        sizeBytes: attachment.bytes.byteLength,
        name,
        cachedBlob: null,
        cachedAt: null,
        createdAt: now,
        // The upload has already happened, so the row begins as confirmed.
        syncedAt: now,
      });
      // The note's own text carries the reference, so the link is queued rather than written as a second source
      // of truth.
      for (const noteId of attachment.noteIds) {
        await enqueueChange(db, {
          objectType: "note_attachment",
          objectId: noteId,
          operation: "update",
          baseRevision: null,
        });
      }
    });
  }

  await db.transaction(
    "rw",
    [db.notes, db.folders, db.tags, db.noteTags, db.attachments, db.syncQueue],
    async () => {
      for (const write of writes) {
        await write();
      }
    },
  );

  return {
    ...plan.counts,
    attachments: plan.attachments.length,
  };
}

/** A plan that changes nothing, for an archive with nothing in it. */
export function isEmptyPlan(plan: ImportPlan): boolean {
  return plan.notes.length === 0 && plan.folders.length === 0 && plan.tags.length === 0;
}

/** Reads a plan's ids, so a caller can check what it is about to write. */
export function planNoteIds(plan: ImportPlan): string[] {
  return plan.notes.map((note) => note.id);
}

export { ArchiveError };
