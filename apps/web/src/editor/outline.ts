/**
 * Extracts headings from Markdown content to build a table of contents / outline.
 */

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  index: number;
}

export function extractOutline(markdown: string): HeadingItem[] {
  if (!markdown) return [];

  const lines = markdown.split("\n");
  const items: HeadingItem[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (match && match[1] && match[2]) {
      const level = match[1].length;
      const rawText = match[2].trim();
      // Clean inline formatting like bold, italics, links, code
      const text = rawText
        .replace(/[*_~`]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();

      const slug = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
        .replace(/^-+|-+$/g, "");

      items.push({
        id: `heading-${items.length}-${slug}`,
        level,
        text,
        index: i,
      });
    }
  }

  return items;
}
