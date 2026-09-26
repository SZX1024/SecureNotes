/**
 * A note's opening words, for the note list (§22).
 *
 * The list showed a title and a date, which is enough to identify a note you already had in mind and not enough to
 * recognise one you had forgotten. The first line or so of the body is what makes a list scannable.
 *
 * Markdown's own furniture is stripped rather than shown: a row that begins "## " reads as a row that begins with
 * noise, and the heading level is not what anyone is looking for in a preview.
 */

const SNIPPET_LIMIT = 90;

export function snippetOf(body: string, limit = SNIPPET_LIMIT): string {
  const flattened = body
    .replace(/```[\s\S]*?```/g, " ") // fenced code: its first line is rarely the gist
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images: a path is not a sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links: keep the words, drop the target
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= limit) {
    return flattened;
  }
  // Cut at a word boundary: a preview that ends mid-word looks like a rendering fault.
  const cut = flattened.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
