/**
 * The additional authenticated data every envelope is bound to.
 *
 * The four fields are the frozen format (see `requirements.md` §7): the object's type and id, the revision it was
 * encrypted at, and the key version. The binding is what makes a ciphertext unusable anywhere other than where it
 * belongs — a note's payload cannot be replayed as another note's, or as the same note's earlier revision.
 *
 * Declared once, in one place, because it is security-relevant and was previously written out privately in each
 * module that encrypted something. A second copy is a second chance to get the order or the spelling wrong.
 */
export type DataObjectType =
  | "note"
  | "note_revision"
  | "folder"
  | "tag"
  | "note_tag_link"
  | "attachment_meta"
  | "attachment_blob";

export interface ObjectAad {
  objectType: DataObjectType;
  objectId: string;
  revision: number;
  keyVersion: number;
}

export function aadFor(
  objectType: DataObjectType,
  objectId: string,
  revision: number,
  keyVersion: number,
): ObjectAad {
  return { objectType, objectId, revision, keyVersion };
}
