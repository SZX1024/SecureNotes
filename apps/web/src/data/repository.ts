import { decryptObject, encryptObject, utf8 } from "@securenotes/shared";

import { enqueueChange } from "../local/sync-queue";
import type {
  LocalFolder,
  LocalNote,
  LocalTag,
  SecureNotesDatabase,
  SyncQueueItem,
} from "../local/schema";
import { joinNoteDocument, splitNoteDocument, type NoteDocument } from "./note-document";

/**
 * The local write path.
 *
 * Two rules are enforced here, and they are the reason this module exists rather
 * than letting components touch Dexie directly:
 *
 * 1. **nothing is stored in the clear** — every payload is encrypted with the DEK
 *    under an AAD that binds its object type, id and revision, so a row cannot be
 *    moved to another note or rolled back to an older revision without the
 *    decryption failing;
 * 2. **every change is queued** — a local write that is not in the sync queue is
 *    a change the server will never hear about, so the two always happen together.
 */

export interface LocalContext {
  db: SecureNotesDatabase;
  /** The DEK, imported non-extractable. Never persisted in this form. */
  dek: CryptoKey;
  userId: string;
  keyVersion: number;
}

function aadFor(
  objectType: "note" | "folder" | "tag",
  objectId: string,
  revision: number,
  keyVersion: number,
) {
  return { objectType, objectId, revision, keyVersion } as const;
}

export interface StoredNote {
  note: LocalNote;
  document: NoteDocument;
}

/**
 * Writes a new note: encrypted locally, then queued for upload.
 *
 * The note starts at revision 1 with `syncedAt: null`, which is what makes it
 * "unsynced" for the eviction policy — such a row can never be dropped (§8).
 */
export async function createLocalNote(
  context: LocalContext,
  input: { id: string; folderId?: string | null; title: string; body: string; nowMs?: number },
): Promise<LocalNote> {
  const now = input.nowMs ?? Date.now();
  const markdown =
    input.title.trim().length > 0 ? `# ${input.title.trim()}\n\n${input.body}` : input.body;
  const revision = 1;

  const payload = await encryptObject(
    context.dek,
    aadFor("note", input.id, revision, context.keyVersion),
    utf8(markdown),
  );

  const note: LocalNote = {
    id: input.id,
    folderId: input.folderId ?? null,
    revision,
    payload,
    deletedAt: null,
    pinned: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  };

  await context.db.notes.put(note);
  await enqueueChange(context.db, {
    objectType: "note",
    objectId: input.id,
    operation: "create",
    baseRevision: null,
  });

  return note;
}

/**
 * Saves an edit as a new revision.
 *
 * The revision number is part of the AAD, so the ciphertext of revision 2 cannot
 * be swapped in for revision 1: the binding is what makes a silent rollback
 * detectable rather than invisible.
 */
export async function updateLocalNote(
  context: LocalContext,
  input: { id: string; title: string; body: string; nowMs?: number },
): Promise<LocalNote> {
  const existing = await context.db.notes.get(input.id);
  if (!existing) {
    throw new Error(`note ${input.id} is not in the local database`);
  }

  const now = input.nowMs ?? Date.now();
  const revision = existing.revision + 1;
  const markdown =
    input.title.trim().length > 0 ? `# ${input.title.trim()}\n\n${input.body}` : input.body;

  const payload = await encryptObject(
    context.dek,
    aadFor("note", input.id, revision, context.keyVersion),
    utf8(markdown),
  );

  const updated: LocalNote = {
    ...existing,
    revision,
    payload,
    updatedAt: now,
  };

  await context.db.notes.put(updated);
  await enqueueChange(context.db, {
    objectType: "note",
    objectId: input.id,
    operation: "update",
    baseRevision: existing.revision,
  });

  return updated;
}

/**
 * Changes a note's organisation without touching its text: its folder, its pin, its manual order.
 *
 * The payload is **re-encrypted** even though the text is unchanged. The revision is part of the
 * envelope's AAD and every accepted write advances it, so a row whose revision moved while its payload
 * stayed put would decrypt on the device that wrote it and on no other — silently, because an
 * undecryptable row is skipped. Re-encrypting at the new revision is what keeps the two in step.
 */
export async function updateLocalNoteMetadata(
  context: LocalContext,
  input: {
    id: string;
    folderId?: string | null;
    pinned?: boolean;
    sortOrder?: number;
    nowMs?: number;
  },
): Promise<LocalNote> {
  const existing = await context.db.notes.get(input.id);
  if (!existing) {
    throw new Error(`note ${input.id} is not in the local database`);
  }

  const stored = await readLocalNote(context, input.id);
  if (!stored) {
    throw new Error(`note ${input.id} could not be decrypted`);
  }

  const now = input.nowMs ?? Date.now();
  const revision = existing.revision + 1;
  const markdown = joinNoteDocument(stored.document);

  const payload = await encryptObject(
    context.dek,
    aadFor("note", input.id, revision, context.keyVersion),
    utf8(markdown),
  );

  const updated: LocalNote = {
    ...existing,
    revision,
    payload,
    folderId: input.folderId === undefined ? existing.folderId : input.folderId,
    pinned: input.pinned ?? existing.pinned,
    sortOrder: input.sortOrder ?? existing.sortOrder,
    updatedAt: now,
  };

  await context.db.notes.put(updated);
  await enqueueChange(context.db, {
    objectType: "note",
    objectId: input.id,
    operation: "update",
    baseRevision: existing.revision,
  });

  return updated;
}

/** Reads and decrypts a note. Throws when the AAD does not match the row. */
export async function readLocalNote(context: LocalContext, id: string): Promise<StoredNote | null> {
  const note = await context.db.notes.get(id);
  if (!note) {
    return null;
  }

  const plaintext = await decryptObject(
    context.dek,
    aadFor("note", note.id, note.revision, note.payload.key_version),
    note.payload,
  );

  return { note, document: splitNoteDocument(new TextDecoder().decode(plaintext)) };
}

/** Every decrypted note, for building the search index after unlock (§11). */
export async function readAllLocalNotes(context: LocalContext): Promise<StoredNote[]> {
  const notes = await context.db.notes.toArray();
  const stored: StoredNote[] = [];

  for (const note of notes) {
    try {
      const plaintext = await decryptObject(
        context.dek,
        aadFor("note", note.id, note.revision, note.payload.key_version),
        note.payload,
      );
      stored.push({ note, document: splitNoteDocument(new TextDecoder().decode(plaintext)) });
    } catch {
      // A row that cannot be decrypted is skipped rather than breaking the whole
      // index: one corrupt record must not make every other note unopenable.
    }
  }

  return stored;
}

export async function createLocalFolder(
  context: LocalContext,
  input: { id: string; parentId?: string | null; name: string; nowMs?: number },
): Promise<LocalFolder> {
  const now = input.nowMs ?? Date.now();
  const revision = 1;

  const name = await encryptObject(
    context.dek,
    aadFor("folder", input.id, revision, context.keyVersion),
    utf8(input.name),
  );

  const existingDepth = input.parentId
    ? ((await context.db.folders.get(input.parentId))?.depth ?? 0)
    : 0;
  const folder: LocalFolder = {
    id: input.id,
    parentId: input.parentId ?? null,
    depth: existingDepth + 1,
    revision: 1,
    name,
    deletedAt: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  };

  await context.db.folders.put(folder);
  await enqueueChange(context.db, {
    objectType: "folder",
    objectId: input.id,
    operation: "create",
    baseRevision: null,
  });

  return folder;
}

/**
 * Renames or moves a folder.
 *
 * The name is re-encrypted at the new revision for the same reason a note's payload is: the revision is
 * inside the AAD, so a name envelope may only be stored under the revision it was encrypted at.
 */
export async function updateLocalFolder(
  context: LocalContext,
  input: {
    id: string;
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
    nowMs?: number;
  },
): Promise<LocalFolder> {
  const existing = await context.db.folders.get(input.id);
  if (!existing) {
    throw new Error(`folder ${input.id} is not in the local database`);
  }

  const now = input.nowMs ?? Date.now();
  const revision = existing.revision + 1;

  // Re-encrypted at the new revision either way: the revision is inside the AAD, so a name envelope may only
  // be stored under the revision it was encrypted at, and a rename is not the only thing that moves it.
  const plaintextName = input.name ?? (await readLocalFolderName(context, existing));
  const name = await encryptObject(
    context.dek,
    aadFor("folder", input.id, revision, context.keyVersion),
    utf8(plaintextName),
  );

  const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
  const parent = parentId === null ? null : await context.db.folders.get(parentId);
  const updated: LocalFolder = {
    ...existing,
    revision,
    name,
    parentId,
    depth: parent ? parent.depth + 1 : 1,
    sortOrder: input.sortOrder ?? existing.sortOrder,
    updatedAt: now,
  };

  await context.db.folders.put(updated);
  await enqueueChange(context.db, {
    objectType: "folder",
    objectId: input.id,
    operation: "update",
    baseRevision: existing.revision,
  });

  return updated;
}

/**
 * Deletes a folder locally.
 *
 * Its notes are not touched: the server refuses to delete a folder that still holds anything (RESTRICT),
 * so the local side must not pretend otherwise. A caller moves them out first.
 */
export async function deleteLocalFolder(context: LocalContext, id: string): Promise<void> {
  await context.db.folders.delete(id);
  await enqueueChange(context.db, {
    objectType: "folder",
    objectId: id,
    operation: "delete",
    baseRevision: null,
  });
}

export async function readLocalFolderName(
  context: LocalContext,
  folder: LocalFolder,
): Promise<string> {
  // Bound to the folder's own revision: the AAD includes it, so decrypting with any other number would
  // fail — which is what makes a stale name envelope detectable rather than silently wrong.
  const plaintext = await decryptObject(
    context.dek,
    aadFor("folder", folder.id, folder.revision, folder.name.key_version),
    folder.name,
  );
  return new TextDecoder().decode(plaintext);
}

export async function createLocalTag(
  context: LocalContext,
  input: { id: string; name: string; nowMs?: number },
): Promise<LocalTag> {
  const now = input.nowMs ?? Date.now();
  const name = await encryptObject(
    context.dek,
    aadFor("tag", input.id, 1, context.keyVersion),
    utf8(input.name),
  );

  const tag: LocalTag = {
    id: input.id,
    name,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  };

  await context.db.tags.put(tag);
  await enqueueChange(context.db, {
    objectType: "tag",
    objectId: input.id,
    operation: "create",
    baseRevision: null,
  });

  return tag;
}

export async function readLocalTagName(context: LocalContext, tag: LocalTag): Promise<string> {
  const plaintext = await decryptObject(
    context.dek,
    aadFor("tag", tag.id, 1, tag.name.key_version),
    tag.name,
  );
  return new TextDecoder().decode(plaintext);
}

/** Renames a tag. Its links are untouched: they point at the id, which does not change. */
export async function renameLocalTag(
  context: LocalContext,
  input: { id: string; name: string; nowMs?: number },
): Promise<LocalTag> {
  const existing = await context.db.tags.get(input.id);
  if (!existing) {
    throw new Error(`tag ${input.id} is not in the local database`);
  }

  const now = input.nowMs ?? Date.now();
  const updated: LocalTag = {
    ...existing,
    // Tags carry no revision of their own on the server, so the name stays bound at revision 1 — the value
    // it was encrypted with.
    name: await encryptObject(
      context.dek,
      aadFor("tag", input.id, 1, context.keyVersion),
      utf8(input.name),
    ),
    updatedAt: now,
  };

  await context.db.tags.put(updated);
  await enqueueChange(context.db, {
    objectType: "tag",
    objectId: input.id,
    operation: "update",
    baseRevision: null,
  });

  return updated;
}

/**
 * Deletes a tag locally.
 *
 * Its links go with it — the relationship is what is being removed, never the notes themselves (§9). The
 * server does the same on its side.
 */
export async function deleteLocalTag(context: LocalContext, id: string): Promise<void> {
  await context.db.noteTags.where("tagId").equals(id).delete();
  await context.db.tags.delete(id);
  await enqueueChange(context.db, {
    objectType: "tag",
    objectId: id,
    operation: "delete",
    baseRevision: null,
  });
}

/**
 * Replaces the set of tags a note carries.
 *
 * Set semantics, and the queued change names **the note** rather than each link: the server's tag endpoint
 * replaces the whole set, so one entry per note is idempotent under retry, whereas per-link entries would
 * have to be replayed in order to mean anything.
 */
export async function setLocalNoteTags(
  context: LocalContext,
  input: { noteId: string; tagIds: readonly string[]; nowMs?: number },
): Promise<void> {
  await context.db.transaction("rw", context.db.noteTags, async () => {
    await context.db.noteTags.where("noteId").equals(input.noteId).delete();
    for (const tagId of new Set(input.tagIds)) {
      await context.db.noteTags.put({ noteId: input.noteId, tagId, syncedAt: null });
    }
  });

  await enqueueChange(context.db, {
    objectType: "note_tag_link",
    objectId: input.noteId,
    operation: "update",
    baseRevision: null,
  });
}

/** The tag ids a note carries, for the interface and for the sync payload. */
export async function readLocalNoteTags(context: LocalContext, noteId: string): Promise<string[]> {
  const links = await context.db.noteTags.where("noteId").equals(noteId).toArray();
  return links.map((link) => link.tagId);
}

/**
 * Queued changes for one object, oldest first.
 *
 * Used by the sync layer (P7) and by the eviction policy: an object with a
 * pending entry must never be evicted, however old its `syncedAt` looks.
 */
export async function pendingChangesFor(
  db: SecureNotesDatabase,
  objectId: string,
): Promise<SyncQueueItem[]> {
  return db.syncQueue.where("objectId").equals(objectId).sortBy("queuedAt");
}

/** Bytes of a decrypted note body, for the index's memory accounting. */
export function documentLength(document: NoteDocument): number {
  return document.title.length + document.body.length;
}
