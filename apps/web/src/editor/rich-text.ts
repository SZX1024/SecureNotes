/**
 * Rich-text paste conversion (§12).
 *
 * "Paste from a web page prompts the user for handling. Any HTML path must be sanitized.
 * Provide a safe rich-text conversion path and plain-text path."
 *
 * The order is the security-relevant part: the HTML is **sanitized first**, and only the
 * sanitized DOM is converted. Converting first and sanitizing afterwards would mean
 * trusting the converter to have carried nothing dangerous into the Markdown, and
 * Markdown can express raw HTML — so a `<script>` that survived conversion would be
 * re-introduced by the note itself.
 *
 * The result is Markdown text, which then goes through the normal note path: stored as
 * Markdown and sanitized again when rendered.
 */

export async function htmlToMarkdown(html: string): Promise<string> {
  const [{ sanitizeHtml }, { default: TurndownService }, { gfm }] = await Promise.all([
    import("../render/sanitize"),
    import("turndown"),
    import("turndown-plugin-gfm"),
  ]);

  // Step one: the sanitizer decides what markup exists at all.
  const safeHtml = sanitizeHtml(html);

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  // Tables, strikethrough and task lists are the parts of §12's feature list that only
  // exist in GFM, so the plugin has to be applied before conversion.
  service.use(gfm);

  // No element is passed through verbatim. Turndown's `keep` is what would let raw HTML
  // reach the note, so nothing is kept.
  service.keep([]);

  return service.turndown(safeHtml).trim();
}
