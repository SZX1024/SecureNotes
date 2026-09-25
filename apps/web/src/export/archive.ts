import { decryptObject, utf8, type Bytes, type CryptoEnvelope } from "@securenotes/shared";

import { attachmentReferencesIn } from "../editor/attachments";
import { createZip, readZip } from "./zip";

/**
 * The export archive (§20).
 *
 * The export is manual, always complete, and deliberately **plaintext**: it is the one artefact that leaves the
 * encryption boundary, which the manifest states so nobody discovers it by surprise. It is a ZIP with the
 * structure defined here, and it is meant to be readable by a person with an unzip tool and a text editor — that
 * is what makes it a backup.
 *
 * Parsing is separated from applying. Everything an import needs is validated here, on plain data, before a
 * single row is written: §20 requires the import to be transactional, and a validator that writes cannot be.
 */

export const EXPORT_FORMAT = "securenotes-export";
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: number;
  /** §20: the archive is outside the encryption boundary, and says so. */
  encryption: "none";
  counts: { notes: number; folders: number; tags: number; attachments: number };
}

export interface ArchiveNote {
  id: string;
  folderId: string | null;
  tagIds: string[];
  pinned: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** The whole document, title heading included. */
  markdown: string;
}

export interface ArchiveFolder {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
}

export interface ArchiveTag {
  id: string;
  name: string;
}

export interface ArchiveAttachment {
  id: string;
  filename: string;
  contentType: string;
  /** The notes whose text refers to it. */
  noteIds: string[];
  bytes: Bytes;
}

export interface ExportArchive {
  manifest: ExportManifest;
  notes: ArchiveNote[];
  folders: ArchiveFolder[];
  tags: ArchiveTag[];
  attachments: ArchiveAttachment[];
}

/** A readable path component: anything that could escape the entry's directory or confuse a tool is removed. */
export function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "-")
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must not reach a path
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * What the archive is built from.
 *
 * The revisions travel with the envelopes because they are part of the AAD: decrypting a payload with the wrong
 * revision fails, and an export that guessed would produce an empty archive rather than an error.
 */
export interface ArchiveSources {
  notes: Array<{
    id: string;
    revision: number;
    folderId: string | null;
    pinned: boolean;
    sortOrder: number;
    createdAt: number;
    updatedAt: number;
    payload: CryptoEnvelope;
  }>;
  folders: Array<{
    id: string;
    revision: number;
    parentId: string | null;
    name: CryptoEnvelope;
    sortOrder: number;
  }>;
  tags: Array<{ id: string; name: CryptoEnvelope }>;
  links: Array<{ noteId: string; tagId: string }>;
}

export interface BuildOptions {
  dek: CryptoKey;
  keyVersion: number;
  now?: number;
  /** Reads and decrypts one attachment. Injected so an archive can be built without a server. */
  readAttachment: (attachmentId: string) => Promise<{
    bytes: Bytes;
    contentType: string;
    filename: string;
  }>;
}

async function decryptText(
  dek: CryptoKey,
  envelope: CryptoEnvelope,
  aad: {
    objectType: "note" | "folder" | "tag";
    objectId: string;
    revision: number;
    keyVersion: number;
  },
): Promise<string> {
  const plaintext = await decryptObject(dek, aad, envelope);
  return new TextDecoder().decode(plaintext);
}

/**
 * Assembles the archive.
 *
 * Attachments are included as their plaintext bytes: the export is the user's own copy of their own work, and a
 * backup they cannot read without this application is not a backup (§20).
 */
export async function buildExportArchive(
  sources: ArchiveSources,
  options: BuildOptions,
): Promise<{ bytes: Bytes; archive: ExportArchive }> {
  const notes: ArchiveNote[] = [];
  for (const note of sources.notes) {
    const markdown = await decryptText(options.dek, note.payload, {
      objectType: "note",
      objectId: note.id,
      revision: note.revision,
      keyVersion: options.keyVersion,
    });
    notes.push({
      id: note.id,
      folderId: note.folderId,
      tagIds: sources.links.filter((link) => link.noteId === note.id).map((link) => link.tagId),
      pinned: note.pinned,
      sortOrder: note.sortOrder,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      markdown,
    });
  }

  const folders: ArchiveFolder[] = [];
  for (const folder of sources.folders) {
    folders.push({
      id: folder.id,
      parentId: folder.parentId,
      name: await decryptText(options.dek, folder.name, {
        objectType: "folder",
        objectId: folder.id,
        revision: folder.revision,
        keyVersion: options.keyVersion,
      }),
      sortOrder: folder.sortOrder,
    });
  }

  const tags: ArchiveTag[] = [];
  for (const tag of sources.tags) {
    tags.push({
      id: tag.id,
      // Tags carry no revision of their own on the server, so their names are bound at revision 1.
      name: await decryptText(options.dek, tag.name, {
        objectType: "tag",
        objectId: tag.id,
        revision: 1,
        keyVersion: options.keyVersion,
      }),
    });
  }

  // The notes that refer to each attachment are found in the notes themselves: the reference is part of the
  // text, and there is no separate table to consult. The reference's label is the filename the user saw, which
  // is a better name for the file in a backup than the id the attachment is stored under.
  const referencedBy = new Map<string, { noteIds: string[]; label: string }>();
  for (const note of notes) {
    for (const reference of attachmentReferencesIn(note.markdown)) {
      const existing = referencedBy.get(reference.id);
      referencedBy.set(reference.id, {
        noteIds: [...(existing?.noteIds ?? []), note.id],
        label: reference.label.length > 0 ? reference.label : (existing?.label ?? ""),
      });
    }
  }

  const attachments: ArchiveAttachment[] = [];
  for (const [id, reference] of referencedBy) {
    const read = await options.readAttachment(id);
    attachments.push({
      id,
      // The label the note carries, then what the attachment was uploaded as, and the id only if neither says
      // anything — a backup whose files are named after ids is technically complete and practically useless.
      filename: reference.label.length > 0 ? reference.label : read.filename,
      contentType: read.contentType,
      noteIds: reference.noteIds,
      bytes: read.bytes,
    });
  }

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: options.now ?? Date.now(),
    encryption: "none",
    counts: {
      notes: notes.length,
      folders: folders.length,
      tags: tags.length,
      attachments: attachments.length,
    },
  };

  const archive: ExportArchive = { manifest, notes, folders, tags, attachments };
  return { bytes: await writeArchive(archive), archive };
}

const README = `SecureNotes export
==================

This archive is a plaintext copy of your notes. It is not encrypted: anyone who
can read this file can read your notes, so keep it somewhere you trust.

Structure
---------

  manifest.json      what this archive is, and when it was made
  notes.json         every note's organisation: folder, tags, pinning, timestamps
  folders.json       the folder tree
  tags.json          tag names
  notes/<id>.md      one Markdown file per note
  attachments.json   attachment metadata, including which notes refer to what
  attachments/<id>/<filename>   the attachment itself, as it was uploaded

To read your notes without this application, open the files in notes/. The other
files are the metadata that puts them back together, and are what an import uses.

Only attachments that a note in this archive refers to are included. Their names
are the filenames they were uploaded with.
`;

async function writeArchive(archive: ExportArchive): Promise<Bytes> {
  const entries = [
    { path: "README.txt", bytes: utf8(README) },
    { path: "manifest.json", bytes: utf8(JSON.stringify(archive.manifest, null, 2)) },
    {
      path: "notes.json",
      bytes: utf8(
        JSON.stringify(
          archive.notes.map(({ markdown: _markdown, ...rest }) => rest),
          null,
          2,
        ),
      ),
    },
    { path: "folders.json", bytes: utf8(JSON.stringify(archive.folders, null, 2)) },
    { path: "tags.json", bytes: utf8(JSON.stringify(archive.tags, null, 2)) },
    {
      path: "attachments.json",
      bytes: utf8(
        JSON.stringify(
          archive.attachments.map(({ bytes: _bytes, ...rest }) => rest),
          null,
          2,
        ),
      ),
    },
  ];

  for (const note of archive.notes) {
    entries.push({ path: `notes/${note.id}.md`, bytes: utf8(note.markdown) });
  }
  for (const attachment of archive.attachments) {
    entries.push({
      path: `attachments/${attachment.id}/${safeFilename(attachment.filename, attachment.id)}`,
      bytes: attachment.bytes,
    });
  }

  return createZip(entries);
}

/** A reason to refuse an archive, in words a user can act on. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Reads an archive into plain data, or explains why it cannot be read.
 *
 * Nothing is written: an import must be able to reject an archive entirely, and every reason to reject it is
 * discovered here.
 */
export async function parseExportArchive(bytes: Bytes): Promise<ExportArchive> {
  let files: Map<string, Bytes>;
  try {
    files = await readZip(bytes);
  } catch (error) {
    throw new ArchiveError(
      error instanceof Error ? error.message : "the archive could not be read",
    );
  }

  const decoder = new TextDecoder();
  const json = <T>(path: string): T => {
    const entry = files.get(path);
    if (!entry) {
      throw new ArchiveError(`the archive has no ${path}`);
    }
    try {
      return JSON.parse(decoder.decode(entry)) as T;
    } catch {
      throw new ArchiveError(`${path} is not valid JSON`);
    }
  };

  const manifest = json<ExportManifest>("manifest.json");
  if (manifest.format !== EXPORT_FORMAT) {
    throw new ArchiveError("this is not a SecureNotes export");
  }
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion > EXPORT_FORMAT_VERSION) {
    // A newer archive could carry writes this version would silently drop, which is worse than refusing it.
    throw new ArchiveError(
      `the archive was written by a newer version of the application (format ${manifest.formatVersion})`,
    );
  }

  const noteMeta = json<Array<Omit<ArchiveNote, "markdown">>>("notes.json");
  const folders = json<ArchiveFolder[]>("folders.json");
  const tags = json<ArchiveTag[]>("tags.json");
  const attachmentMeta = json<Array<Omit<ArchiveAttachment, "bytes">>>("attachments.json");

  const notes: ArchiveNote[] = [];
  for (const meta of noteMeta) {
    const entry = files.get(`notes/${meta.id}.md`);
    if (!entry) {
      // A note without its text is not a note; importing the metadata alone would produce an empty document.
      throw new ArchiveError(`the archive has no text for note ${meta.id}`);
    }
    notes.push({ ...meta, markdown: decoder.decode(entry) });
  }

  const attachments: ArchiveAttachment[] = [];
  for (const meta of attachmentMeta) {
    const prefix = `attachments/${meta.id}/`;
    const path = [...files.keys()].find((candidate) => candidate.startsWith(prefix));
    if (!path) {
      throw new ArchiveError(`the archive has no content for attachment ${meta.id}`);
    }
    attachments.push({ ...meta, bytes: files.get(path)! });
  }

  return validateArchive({ manifest, notes, folders, tags, attachments });
}

/**
 * Checks the archive against itself.
 *
 * These are the failures that make an import impossible rather than merely awkward: a note filed under a folder
 * the archive does not contain, or a tag that is not there, would import into a broken state no later step could
 * repair.
 */
export function validateArchive(archive: ExportArchive): ExportArchive {
  const folderIds = new Set(archive.folders.map((folder) => folder.id));
  const tagIds = new Set(archive.tags.map((tag) => tag.id));
  const noteIds = new Set(archive.notes.map((note) => note.id));

  for (const note of archive.notes) {
    if (note.folderId !== null && !folderIds.has(note.folderId)) {
      throw new ArchiveError(
        `note ${note.id} is filed under a folder the archive does not contain`,
      );
    }
    for (const tagId of note.tagIds) {
      if (!tagIds.has(tagId)) {
        throw new ArchiveError(`note ${note.id} carries a tag the archive does not contain`);
      }
    }
  }
  for (const folder of archive.folders) {
    if (folder.parentId !== null && !folderIds.has(folder.parentId)) {
      throw new ArchiveError(`folder ${folder.id} is inside a folder the archive does not contain`);
    }
  }
  for (const attachment of archive.attachments) {
    for (const noteId of attachment.noteIds) {
      if (!noteIds.has(noteId)) {
        throw new ArchiveError(
          `attachment ${attachment.id} refers to a note the archive does not contain`,
        );
      }
    }
  }

  return archive;
}

export interface ArchiveCollisions {
  notes: string[];
  folders: string[];
  tags: string[];
  attachments: string[];
}

export interface ExistingIds {
  noteIds: readonly string[];
  folderIds: readonly string[];
  tagIds: readonly string[];
  attachmentIds: readonly string[];
}

/**
 * What already exists here, so the user can choose.
 *
 * §20: duplicate ids require a choice between merging and remapping, so collisions are reported rather than
 * resolved. Overwriting without asking is the one answer the requirement rules out.
 */
export function findCollisions(archive: ExportArchive, existing: ExistingIds): ArchiveCollisions {
  const ids = (list: readonly string[]) => new Set(list);

  const noteIds = ids(existing.noteIds);
  const folderIds = ids(existing.folderIds);
  const tagIds = ids(existing.tagIds);
  const attachmentIds = ids(existing.attachmentIds);

  return {
    notes: archive.notes.filter((note) => noteIds.has(note.id)).map((note) => note.id),
    folders: archive.folders
      .filter((folder) => folderIds.has(folder.id))
      .map((folder) => folder.id),
    tags: archive.tags.filter((tag) => tagIds.has(tag.id)).map((tag) => tag.id),
    // An attachment's content is immutable, so an id that is already here refers to the same bytes. It is still
    // reported, because the user is choosing what happens to their archive, not to a guess about it.
    attachments: archive.attachments
      .filter((attachment) => attachmentIds.has(attachment.id))
      .map((attachment) => attachment.id),
  };
}

/** The ids in a collision report, for a caller that only needs the count. */
export function collisionCount(collisions: ArchiveCollisions): number {
  return (
    collisions.notes.length +
    collisions.folders.length +
    collisions.tags.length +
    collisions.attachments.length
  );
}
