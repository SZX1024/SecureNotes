import { describe, expect, it } from "vitest";

import {
  isMermaidBlock,
  renderMarkdown,
  renderMermaidBlocks,
  roundTrip,
  serializeMarkdown,
} from "./markdown";
import { containsActiveContent } from "./sanitize";

/**
 * Markdown rendering and round-tripping (§12, §31).
 *
 * Two things are being checked here. First, that the required Markdown features
 * survive the pipeline. Second — and this is the security-relevant half — that a
 * note full of hostile Markdown produces no active content, because rendering is
 * where Markdown stops being text.
 */

describe("round-trip: unknown extensions are preserved (§12)", () => {
  it("keeps a construct remark does not understand", () => {
    // A directive-ish block that no installed plugin recognises: it must come back
    // as written rather than being dropped.
    const source = ":::note\nSomething custom\n:::\n";
    const { output } = roundTrip(source);

    expect(output).toContain(":::note");
    expect(output).toContain("Something custom");
    expect(output).toContain(":::");
  });

  it("keeps custom syntax readable even when the serializer escapes it", () => {
    // Byte equality is too strong a demand: a serializer may add escapes that are
    // semantically identical (`[value]` becoming `\[value\]`). What must hold is
    // that the content still renders the same and that a second pass is stable.
    for (const source of ["Text with ::marker[value] inside.\n", "# Heading {#custom-id}\n"]) {
      const output = serializeMarkdown(source);
      expect(renderMarkdown(output), source).toBe(renderMarkdown(source));
      expect(serializeMarkdown(output), source).toBe(output);
      expect(output, source).toContain(source.includes("::marker") ? "marker" : "custom-id");
    }
  });

  it("is stable when run twice, so an editor save cannot drift", () => {
    const once = serializeMarkdown("# Title\n\n- [ ] task\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(serializeMarkdown(once)).toBe(once);
  });

  it("preserves ordinary Markdown exactly", () => {
    const source = "# Title\n\nParagraph with **bold** and `code`.\n";
    expect(roundTrip(source).stable).toBe(true);
  });
});

describe("required Markdown features (§12)", () => {
  it("renders headings, emphasis, lists and code", () => {
    const html = renderMarkdown("# Title\n\n**bold** and `code`\n\n- one\n- two\n");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders tables and task lists", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");

    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain('type="checkbox"');
  });

  it("renders code blocks with their language class", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```\n");

    expect(html).toContain("<pre>");
    expect(html).toContain("language-js");
  });

  it("renders LaTeX through KaTeX", () => {
    const html = renderMarkdown(
      "Inline $a^2 + b^2 = c^2$ and display:\n\n$$\n\\int_0^1 x\\,dx\n$$\n",
    );

    // KaTeX emits its own markup, and the TeX source is consumed rather than left
    // behind as text — which is what proves the plugin ran instead of being a no-op.
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("a^2 + b^2");
    expect(html).not.toContain("\\int_0^1");
  });

  it("does not allow arbitrary HTML inside a formula (§12)", () => {
    // KaTeX runs with trust:false, so these must not become markup.
    const html = renderMarkdown(
      "$\\htmlData{foo=bar}{x}$\n\n$\\href{javascript:alert(1)}{click}$\n",
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data-foo");
  });

  it("renders external links with the safe rel and images", () => {
    const html = renderMarkdown(
      "[out](https://example.com)\n\n![alt](https://example.com/i.png)\n",
    );

    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("<img");
    expect(html).toContain('alt="alt"');
  });

  it("keeps inline HTML that is safe and drops what is not", () => {
    const html = renderMarkdown(
      '<p>kept</p>\n\n<script>alert(1)</script>\n\n<div onclick="x()">y</div>\n',
    );

    expect(html).toContain("kept");
    expect(html).not.toMatch(/<script|onclick/i);
  });
});

describe("hostile Markdown produces no active content (§31)", () => {
  it("sanitises markup written directly into a note", () => {
    const vectors = [
      "<img src=x onerror=alert(1)>",
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil.example"></iframe>',
      "<svg onload=alert(1)><script>alert(2)</script></svg>",
      "`<script>alert(1)</script>`",
      "[link](javascript:alert(1))",
      "![img](data:text/html,<script>alert(1)</script>)",
      "<style>body{background:url(https://evil.example)}</style>",
    ];

    for (const vector of vectors) {
      const html = renderMarkdown(vector);
      expect(containsActiveContent(html), vector).toBe(false);
      expect(html, vector).not.toMatch(/<script|<iframe|onerror|onload/i);
    }
  });

  it("shows a fenced code block as text instead of executing it", () => {
    const html = renderMarkdown("```html\n<script>alert(1)</script>\n```\n");

    // Highlighting splits the source into spans, so the assertion is on what the block
    // *says* rather than on a particular escaping: the markup is visible as text and
    // nothing executable exists in the document.
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("code")?.textContent).toContain("<script>");
    expect(container.querySelector("script")).toBeNull();
    expect(containsActiveContent(html)).toBe(false);
  });

  it("cannot fetch a remote image over plain HTTP", () => {
    const html = renderMarkdown("![x](http://evil.example/track.png)\n");

    expect(html).not.toContain("http://evil.example");
  });
});

describe("Mermaid pipeline (§12)", () => {
  it("recognises a mermaid block by its language class", () => {
    expect(isMermaidBlock("language-mermaid")).toBe(true);
    expect(isMermaidBlock("hljs language-mermaid extra")).toBe(true);
    expect(isMermaidBlock("language-js")).toBe(false);
    expect(isMermaidBlock(null)).toBe(false);
  });

  it("renders a diagram and inserts only sanitised SVG", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown('```mermaid\npie title Pets\n  "Dogs" : 3\n```\n');

    const rendered = await renderMermaidBlocks(container);

    expect(rendered).toBe(1);
    const diagram = container.querySelector(".mermaid-diagram");
    expect(diagram?.innerHTML).toContain("<svg");
    expect(containsActiveContent(container.innerHTML)).toBe(false);
  }, 60_000);

  it("leaves a block it cannot render as its own source", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown("```mermaid\nthis is not a diagram at all {{{\n```\n");

    const rendered = await renderMermaidBlocks(container);

    expect(rendered).toBe(0);
    // The author's text survives: a broken diagram must not delete the content.
    expect(container.textContent).toContain("this is not a diagram");
  }, 60_000);

  it("does nothing when there is no mermaid block", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown("```js\nconst a = 1;\n```\n");

    expect(await renderMermaidBlocks(container)).toBe(0);
  });
});
