/**
 * Note documents.
 *
 * Requirements §9: "Title is part of encrypted Markdown, not a separate field."
 * So a note's plaintext is a single Markdown string, and the title is its leading
 * level-1 heading. Nothing outside the ciphertext knows the title — not the
 * worker, not the local schema, not the search index once it is torn down.
 */

const TITLE_PATTERN = /^#\s+(.*)$/;

export interface NoteDocument {
  title: string;
  /** The Markdown body with the title heading removed. */
  body: string;
}

/** Splits a Markdown document into its title and the rest of the body. */
export function splitNoteDocument(markdown: string): NoteDocument {
  const lines = markdown.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex === -1) {
    return { title: "", body: "" };
  }

  const match = TITLE_PATTERN.exec(lines[firstContentIndex]!);
  if (!match) {
    // No heading: the note simply has no title rather than an invented one.
    return { title: "", body: markdown };
  }

  const title = match[1]!.trim();
  const body = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)]
    .join("\n")
    .replace(/^\n+/, "");

  return { title, body };
}

/** Rebuilds the Markdown with `title` as the leading heading. */
export function joinNoteDocument(document: NoteDocument): string {
  const trimmedTitle = document.title.trim();
  if (trimmedTitle.length === 0) {
    return document.body;
  }
  const body = document.body.replace(/^\n+/, "");
  return body.length === 0 ? `# ${trimmedTitle}\n` : `# ${trimmedTitle}\n\n${body}`;
}

/** The text a search index should treat as a note's body. */
export function searchableBody(document: NoteDocument): string {
  return document.body;
}
