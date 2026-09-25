import { attachmentRefsIn } from "../editor/attachments";
import { decryptAttachmentName } from "../data/attachments-client";
import type { SecureNotesDatabase } from "../local/schema";
import type { ArchiveSources } from "./archive";

/**
 * Gathering what an export contains (§20).
 *
 * The export is manual and always complete, so there is nothing to choose here — only the work of reading the
 * local rows and deciding which attachments the archive has to carry.
 */

/** §20: remind the user to back up after this long without an export. */
export const EXPORT_REMINDER_DAYS = 30;

/**
 * Whether to remind the user to export.
 *
 * A device that has never exported is reminded from the start: the only copy of the notes is the one this
 * browser holds, and the encryption means nobody else can hand it back.
 */
export function shouldRemindExport(
  lastExportAt: number | null,
  now: number,
  days: number = EXPORT_REMINDER_DAYS,
): boolean {
  if (lastExportAt === null) {
    return true;
  }
  return now - lastExportAt >= days * 24 * 60 * 60 * 1000;
}

/** How long ago the last export was, in whole days, or null when there has never been one. */
export function daysSinceExport(lastExportAt: number | null, now: number): number | null {
  return lastExportAt === null ? null : Math.floor((now - lastExportAt) / (24 * 60 * 60 * 1000));
}

/**
 * The attachments an export must carry: those the exported notes actually refer to.
 *
 * Taken from the notes rather than from the attachment table, because that table can list an attachment no note
 * mentions any more, and carrying those would put content into a backup that the user has already deleted.
 */
export function attachmentIdsForExport(notes: readonly { markdown: string }[]): string[] {
  const found = new Set<string>();
  for (const note of notes) {
    for (const attachmentId of attachmentRefsIn(note.markdown)) {
      found.add(attachmentId);
    }
  }
  return [...found];
}

/**
 * Reads every local row an export needs.
 *
 * Deleted notes are left out: the recycle bin is a working state rather than part of a backup, and restoring it
 * on another device would resurrect notes the user threw away.
 */
export async function collectExportSources(db: SecureNotesDatabase): Promise<ArchiveSources> {
  const notes = (await db.notes.toArray()).filter((note) => note.deletedAt === null);

  return {
    notes: notes.map((note) => ({
      id: note.id,
      revision: note.revision,
      folderId: note.folderId,
      pinned: note.pinned,
      sortOrder: note.sortOrder,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      payload: note.payload,
    })),
    folders: (await db.folders.toArray()).map((folder) => ({
      id: folder.id,
      revision: folder.revision,
      parentId: folder.parentId,
      name: folder.name,
      sortOrder: folder.sortOrder,
    })),
    tags: (await db.tags.toArray()).map((tag) => ({ id: tag.id, name: tag.name })),
    links: (await db.noteTags.toArray()).map((link) => ({
      noteId: link.noteId,
      tagId: link.tagId,
    })),
  };
}

/** A filename for the download, so the user can tell one backup from another. */
export function exportFileName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `securenotes-export-${stamp}.zip`;
}

/** Where the time of the last export is kept. It is the only thing an export leaves behind. */
export const LAST_EXPORT_KEY = "lastExportAt";

/**
 * The filenames of the attachments this device knows about.
 *
 * Read from the local rows, whose names are envelopes, so the archive can put a file back under the name the user
 * gave it. An attachment whose name cannot be read is left out of the map and the caller falls back to its id.
 */
export async function readLocalAttachmentNames(context: {
  db: SecureNotesDatabase;
  dek: CryptoKey;
  keyVersion: number;
}): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const row of await context.db.attachments.toArray()) {
    try {
      names.set(
        row.id,
        await decryptAttachmentName(context.dek, row.id, context.keyVersion, row.name),
      );
    } catch {
      // Left unset: an unreadable name must not stop the export.
    }
  }
  return names;
}
