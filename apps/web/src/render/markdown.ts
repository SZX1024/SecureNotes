// The stylesheet KaTeX's markup depends on. This module is the lazily loaded render pipeline, so importing it here
// keeps the first load free of it.
import "katex/dist/katex.min.css";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { sanitizeHtml } from "./sanitize";

/**
 * Markdown rendering (§12).
 *
 * One pipeline, used for both directions: the editor parses and serialises with the
 * same remark plugins that render, so what a note round-trips through cannot drift
 * from what it displays.
 *
 * The output of this module is **untrusted HTML** — it is Markdown that may contain
 * arbitrary markup. It is safe only after `sanitizeHtml`, which is why `renderMarkdown`
 * applies it and why the intermediate result is named `unsafeHtml`.
 */

/** Parses Markdown into a syntax tree, keeping the shapes the editor must round-trip. */
export function parseMarkdown(markdown: string) {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown);
}

/**
 * Serialises a tree back to Markdown.
 *
 * Unknown constructs are not dropped: an extension remark does not understand is
 * parsed as ordinary text and serialised back verbatim, which is what §12 requires
 * ("unknown Markdown extensions must be preserved as raw Markdown rather than
 * silently destroyed").
 */
export function serializeMarkdown(markdown: string): string {
  const tree = parseMarkdown(markdown);
  return String(unified().use(remarkGfm).use(remarkMath).use(remarkStringify).stringify(tree));
}

/** Round-trips Markdown and reports whether anything was lost or rewritten. */
export function roundTrip(markdown: string): { output: string; stable: boolean } {
  const output = serializeMarkdown(markdown);
  return { output, stable: output === markdown };
}

/**
 * Renders Markdown to sanitised HTML.
 *
 * KaTeX runs with its default `trust: false`, so `\htmlClass`-style commands and
 * arbitrary HTML inside a formula are not allowed (§12: "Do not allow arbitrary HTML
 * inside formulas"). The generated markup is then sanitised like any other content,
 * because a formula's output is not more trustworthy than the note it sits in.
 */
export function renderMarkdown(markdown: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeKatex, { trust: false, throwOnError: false })
    // Syntax highlighting runs inside this lazily-loaded pipeline, so its cost is
    // paid only when a note is rendered. `detect: false` means an unlabelled block is
    // not guessed at, which keeps the output predictable.
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .processSync(markdown);

  return sanitizeHtml(String(file));
}

/** Whether a code block's language is Mermaid, which is rendered client-side (§12). */
export function isMermaidBlock(className: string | null): boolean {
  return (className ?? "").split(/\s+/).includes("language-mermaid");
}

/**
 * Renders Mermaid blocks inside a container (§12).
 *
 * The pipeline is the one the requirement names — Markdown, Mermaid, SVG, SVG
 * sanitizer, DOM — and the sanitizer step is why this is safe: Mermaid's output is
 * produced by a third-party renderer from note content, so it is treated exactly
 * like untrusted markup rather than inserted directly.
 *
 * A block that fails to render is left as its source text rather than replaced with
 * an error: a broken diagram must not silently delete what the author wrote.
 */
export async function renderMermaidBlocks(container: ParentNode): Promise<number> {
  const blocks = [...container.querySelectorAll("pre > code")].filter((code) =>
    isMermaidBlock(code.getAttribute("class")),
  );
  if (blocks.length === 0) {
    return 0;
  }

  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // `htmlLabels: true` is the default and draws labels inside `<foreignObject>`, which
    // the SVG sanitizer removes because it can embed arbitrary HTML — so the default made
    // every diagram render without its labels. `<text>` labels carry no such risk.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });

  const { sanitizeSvg } = await import("./sanitize");
  let rendered = 0;

  for (const [index, code] of blocks.entries()) {
    const source = code.textContent ?? "";
    try {
      const { svg } = await mermaid.render(`mermaid-${index}-${Date.now()}`, source);
      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-diagram";
      // Sanitised before insertion, never after.
      wrapper.innerHTML = sanitizeSvg(svg);
      code.closest("pre")?.replaceWith(wrapper);
      rendered += 1;
    } catch {
      // Left as-is: the author's source stays visible and copyable.
    }
  }

  return rendered;
}
