/**
 * Attachment references in note text (§12).
 *
 * An image reference uses the internal attachment id, never the original filename,
 * so renaming a file locally cannot point a note at someone else's attachment, and the
 * id is what the reference counting is keyed on.
 *
 * Removing a reference is a server-side consequence — the count drops and a
 * zero-reference attachment enters asynchronous R2 deletion — so the client's job is
 * to report the difference between the previous and current text accurately.
 */

export const ATTACHMENT_URL_PREFIX = "/api/v1/attachments/";

const REFERENCE_PATTERN = new RegExp(`${ATTACHMENT_URL_PREFIX}([0-9a-fA-F-]{36})/content`, "g");

/** The distinct attachment ids referenced by a piece of Markdown, in order. */
export function attachmentRefsIn(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(REFERENCE_PATTERN)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * The Markdown an inserted attachment produces.
 *
 * The alt text is the filename the user saw, which is presentation only: the
 * reference itself is the id.
 */
export function attachmentMarkdown(id: string, filename: string): string {
  const alt = filename.replace(/[[\]]/g, "").trim();
  return `![${alt}](${ATTACHMENT_URL_PREFIX}${id}/content)`;
}

export interface AttachmentRefDiff {
  added: string[];
  removed: string[];
}

/**
 * Compares the references before and after an edit.
 *
 * Pure, and that matters: this is what decides which attachments gain or lose a
 * reference, and a mistake here either deletes an image that is still in use or keeps
 * one alive forever.
 */
export function diffAttachmentRefs(
  before: readonly string[],
  after: readonly string[],
): AttachmentRefDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: [...afterSet].filter((id) => !beforeSet.has(id)),
    removed: [...beforeSet].filter((id) => !afterSet.has(id)),
  };
}

export interface AttachmentReference {
  id: string;
  /** The alt text the reference carries, which is the filename the user saw when inserting it. */
  label: string;
}

/**
 * The references a note carries, with their labels.
 *
 * The label comes from the Markdown itself rather than from a fetch: the reference already carries the
 * filename as alt text, so a list of attachments needs no request and no decryption to be useful.
 */
export function attachmentReferencesIn(markdown: string): AttachmentReference[] {
  const pattern = new RegExp(
    `!\\[([^\\]]*)\\]\\(${ATTACHMENT_URL_PREFIX}([0-9a-fA-F-]{36})/content\\)`,
    "g",
  );
  const found = new Map<string, string>();

  for (const match of markdown.matchAll(pattern)) {
    const label = (match[1] ?? "").trim();
    const id = match[2]!;
    if (!found.has(id)) {
      found.set(id, label);
    }
  }

  return [...found.entries()].map(([id, label]) => ({ id, label }));
}

/** Whether a filename looks like an image the editor may attach. */
export function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(filename);
}
