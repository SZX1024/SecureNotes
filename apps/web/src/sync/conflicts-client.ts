import { decryptObject, encryptObject, utf8, type CryptoEnvelope } from "@securenotes/shared";

import { apiRequest } from "../api/client";
import type { SecureNotesDatabase } from "../local/schema";
import { acknowledgeChange } from "../local/sync-queue";
import { clearLocalConflict } from "./engine";
import { threeWayMerge } from "./merge";

/**
 * Resolving a note conflict (§16).
 *
 * The three sides come from three different places, which is worth being explicit about:
 * - **local** is the note as this device has it, decrypted from the local row;
 * - **remote** is the server's current revision, carried by the conflict the server recorded;
 * - **base** is the revision the client based its edit on, read from the note's history.
 *
 * Every choice is re-encrypted before it is uploaded. Keeping the local payload as it stands would be
 * wrong even though it is the same text: the envelope's AAD contains the revision, and the server stores
 * the resolution as `remote_revision + 1`, so an envelope encrypted at any other revision would decrypt
 * on no device. That failure is silent — an undecryptable note is skipped rather than reported.
 */

export interface ConflictSides {
  conflictId: string;
  noteId: string;
  baseRevision: number | null;
  remoteRevision: number;
  /** The server's envelope, kept so choosing the remote side needs no second request. */
  remotePayload: CryptoEnvelope;
  /** Null when the history for that revision has been pruned, which is normal for old conflicts. */
  base: string | null;
  local: string;
  remote: string;
}

export interface ConflictDependencies {
  db: SecureNotesDatabase;
  dek: CryptoKey;
  keyVersion: number;
  userId: string;
}

interface ConflictWire {
  id: string;
  objectId: string;
  baseRevision: number | null;
  /** The revision the remote envelope is stored under, which is also its AAD revision. */
  remoteRevision: number;
  remote: { iv: string; ciphertext: string; crypto_version: number; key_version: number };
  local: { iv: string; ciphertext: string; crypto_version: number; key_version: number };
}

async function decryptAt(
  dek: CryptoKey,
  noteId: string,
  revision: number,
  envelope: CryptoEnvelope,
): Promise<string> {
  const plaintext = await decryptObject(
    dek,
    { objectType: "note", objectId: noteId, revision, keyVersion: envelope.key_version },
    envelope,
  );
  return new TextDecoder().decode(plaintext);
}

/** Reads the open conflict for a note, with all three sides as text. */
export async function loadNoteConflict(
  deps: ConflictDependencies,
  noteId: string,
): Promise<ConflictSides | null> {
  const { conflicts } = await apiRequest<{ conflicts: ConflictWire[] }>("/conflicts");
  const conflict = conflicts.find((entry) => entry.objectId === noteId);
  if (!conflict) {
    return null;
  }

  const localRow = await deps.db.notes.get(noteId);
  if (!localRow) {
    return null;
  }

  let remote: string;
  try {
    remote = await decryptAt(
      deps.dek,
      noteId,
      conflict.remoteRevision,
      conflict.remote as CryptoEnvelope,
    );
  } catch (err) {
    remote = `[Remote note could not be decrypted: ${err instanceof Error ? err.message : String(err)}]`;
  }

  let local: string;
  try {
    local = await decryptAt(
      deps.dek,
      noteId,
      localRow.revision,
      localRow.payload as CryptoEnvelope,
    );
  } catch (err) {
    local = `[Local note could not be decrypted: ${err instanceof Error ? err.message : String(err)}]`;
  }

  let base: string | null = null;
  if (conflict.baseRevision !== null) {
    const { revisions } = await apiRequest<{
      revisions: Array<{ revision: number; payload: CryptoEnvelope }>;
    }>(`/notes/${noteId}/revisions`);
    const ancestor = revisions.find((entry) => entry.revision === conflict.baseRevision);
    if (ancestor) {
      try {
        base = await decryptAt(deps.dek, noteId, ancestor.revision, ancestor.payload);
      } catch {
        base = null;
      }
    }
  }

  return {
    conflictId: conflict.id,
    noteId,
    baseRevision: conflict.baseRevision,
    remoteRevision: conflict.remoteRevision,
    remotePayload: conflict.remote as CryptoEnvelope,
    base,
    local,
    remote,
  };
}

export type ConflictChoice = "local" | "remote" | "merged";

export interface ResolveInput {
  sides: ConflictSides;
  choice: ConflictChoice;
  /** The text the user edited when merging. Required for the merged choice. */
  mergedText?: string;
}

/**
 * The text a choice keeps.
 *
 * A manual merge with no ancestor available treats the whole document as one conflicted region rather
 * than guessing: the markers are what the user resolves, and pretending the file merged cleanly would
 * hide exactly the part that needs attention.
 */
export function textForChoice(input: ResolveInput): string {
  if (input.choice === "local") {
    return input.sides.local;
  }
  if (input.choice === "remote") {
    return input.sides.remote;
  }
  if (input.mergedText !== undefined) {
    return input.mergedText;
  }
  return threeWayMerge(input.sides.base ?? "", input.sides.local, input.sides.remote).text;
}

export interface ResolveOutcome {
  choice: ConflictChoice;
  /** The revision the resolved note now has, on the server and locally. */
  revision: number;
  text: string;
}

/**
 * Applies a choice: uploads it, records it locally, and unpauses the note.
 *
 * The local write and the server write happen in that order so a failure leaves the note editable
 * locally rather than showing a resolution the server never accepted.
 */
export async function resolveNoteConflict(
  deps: ConflictDependencies,
  input: ResolveInput,
): Promise<ResolveOutcome> {
  const { sides } = input;
  const text = textForChoice(input);
  const nextRevision = sides.remoteRevision + 1;

  if (input.choice === "remote") {
    // Nothing to write: the server's revision is already what the user chose.
    await apiRequest(`/conflicts/${sides.conflictId}/resolve`, {
      method: "POST",
      body: { resolution: "remote" },
    });
    const existingRow = await deps.db.notes.get(sides.noteId);
    if (existingRow) {
      // Everything else about the row is preserved: adopting the server's text must not reset the note's
      // folder, its pin or when it was created.
      await deps.db.notes.put({
        ...existingRow,
        revision: sides.remoteRevision,
        payload: sides.remotePayload as never,
        updatedAt: Date.now(),
        syncedAt: Date.now(),
      });
    }
    await finishResolution(deps, sides);
    return { choice: "remote", revision: sides.remoteRevision, text };
  }

  // Re-encrypted at the revision the server will store it under: the revision is part of the AAD, so the
  // text and the revision have to be decided together.
  const envelope = await encryptObject(
    deps.dek,
    {
      objectType: "note",
      objectId: sides.noteId,
      revision: nextRevision,
      keyVersion: deps.keyVersion,
    },
    utf8(text),
  );

  await apiRequest(`/conflicts/${sides.conflictId}/resolve`, {
    method: "POST",
    body: { resolution: input.choice, payload: envelope },
  });

  const existing = await deps.db.notes.get(sides.noteId);
  if (existing) {
    await deps.db.notes.put({
      ...existing,
      revision: nextRevision,
      payload: envelope as never,
      updatedAt: Date.now(),
      // It is on the server as of now, so there is nothing pending for it.
      syncedAt: Date.now(),
    });
  }

  await finishResolution(deps, sides);
  return { choice: input.choice, revision: nextRevision, text };
}

/**
 * Unpauses the note: the marker goes, and so do the queued edits it was holding.
 *
 * Those edits are the local side that has just been decided about; replaying them would conflict again
 * against the resolution.
 */
async function finishResolution(deps: ConflictDependencies, sides: ConflictSides): Promise<void> {
  const queued = await deps.db.syncQueue.where("objectId").equals(sides.noteId).toArray();
  for (const entry of queued) {
    if (entry.objectType === "note" && entry.id !== undefined) {
      await acknowledgeChange(deps.db, entry.id);
    }
  }
  await clearLocalConflict(deps.db, "note", sides.noteId);
}
