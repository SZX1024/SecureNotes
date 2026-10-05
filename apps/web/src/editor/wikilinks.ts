/**
 * WikiLinks (`[[Note Title]]`) parsing and Backlinks computation.
 */

export interface BacklinkItem {
  sourceNoteId: string;
  sourceNoteTitle: string;
  snippet: string;
}

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

/** Extracts all note titles referenced inside `[[...]]` links in the text. */
export function extractWikiLinks(markdown: string): string[] {
  if (!markdown) return [];
  const found = new Set<string>();
  for (const match of markdown.matchAll(WIKILINK_REGEX)) {
    const title = match[1]?.trim();
    if (title && title.length > 0) {
      found.add(title);
    }
  }
  return [...found];
}

/** Replaces `[[Title]]` with interactive anchor tags */
export function transformWikiLinksToHtml(html: string): string {
  return html.replace(WIKILINK_REGEX, (_match, title: string) => {
    const cleanTitle = title.trim();
    return `<a class="wikilink" data-wikilink="${cleanTitle}" title="Go to note: ${cleanTitle}">[[${cleanTitle}]]</a>`;
  });
}

/** Computes backlinks for a given note across all notes */
export function computeBacklinks(
  allNotes: ReadonlyArray<{ id: string; title: string; body: string }>,
  targetNoteId: string,
  targetTitle: string,
): BacklinkItem[] {
  if (!targetTitle || targetTitle.trim().length === 0) return [];

  const targetLower = targetTitle.trim().toLowerCase();
  const results: BacklinkItem[] = [];

  for (const note of allNotes) {
    if (note.id === targetNoteId) continue;
    const links = extractWikiLinks(note.body);
    const mentions = links.some((l) => l.toLowerCase() === targetLower);
    if (mentions) {
      // Find a snippet containing the mention
      const lines = note.body.split("\n");
      const matchedLine = lines.find((line) => line.toLowerCase().includes(`[[${targetLower}]]`));
      const snippet = matchedLine ? matchedLine.trim().slice(0, 100) : note.body.slice(0, 100);
      results.push({
        sourceNoteId: note.id,
        sourceNoteTitle: note.title.length > 0 ? note.title : "Untitled",
        snippet,
      });
    }
  }

  return results;
}
