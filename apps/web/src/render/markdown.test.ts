import katex from "katex";
import { describe, expect, it } from "vitest";

import {
  isMermaidBlock,
  renderMarkdown,
  renderMermaidBlocks,
  roundTrip,
  serializeMarkdown,
} from "./markdown";
import { containsActiveContent, sanitizeCss } from "./sanitize";

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

  it("renders a display formula as display, and inline math inline", () => {
    // The two are not the same rendering: display mode is centred, larger, and builds a different structure, and
    // KaTeX decides which from the node the parser produced. Block syntax reaching the inline renderer — or the
    // reverse — is a formula that renders and is wrong.
    const display = renderMarkdown(String.raw`$$
\frac{a}{b}
$$`);
    expect(display).toContain("katex-display");

    const inline = renderMarkdown(String.raw`The value $\frac{a}{b}$ in a sentence.`);
    expect(inline).toContain('class="katex"');
    expect(inline).not.toContain("katex-display");
  });

  it("keeps every inline style property KaTeX emits", () => {
    // Written against KaTeX's own output, not against this application's pipeline. The first version of this test
    // rendered through `renderMarkdown` — which sanitises — and then asked the sanitiser about the properties it found,
    // so it could only ever see the properties that had already survived. It passed while six of KaTeX's properties
    // were being dropped, including the `top` offsets that stack a limit above an integral. A test that reads its
    // expectations from the thing it is testing is not a test.
    const sources: ReadonlyArray<readonly [string, boolean]> = [
      [String.raw`\int_0^1 x^2\,dx`, true],
      [String.raw`\frac{a}{b}`, true],
      [String.raw`\sqrt{x^2+y^2}`, true],
      [String.raw`\sum_{i=1}^{n} i`, true],
      [String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`, true],
      [String.raw`\lim_{x \to 0} \frac{\sin x}{x}`, true],
      [String.raw`\overline{AB}`, true],
      [String.raw`E = mc^2`, false],
      [String.raw`\vec{v} \cdot \vec{w}`, false],
      [String.raw`\hat{H}\psi = E\psi`, false],
    ];

    const samples = new Map<string, string>();
    for (const [tex, display] of sources) {
      const html = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        trust: false,
      });
      for (const match of html.matchAll(/style="([^"]*)"/g)) {
        for (const declaration of (match[1] ?? "").split(";")) {
          const [rawName, ...rest] = declaration.split(":");
          const name = (rawName ?? "").trim();
          const value = rest.join(":").trim();
          // A declaration with no value is not a declaration: the markup contains attributes that merely look like
          // one, and a property list built from those would be testing the parser rather than the sanitiser.
          if (value !== "" && /^[a-z-]+$/.test(name) && !samples.has(name)) {
            samples.set(name, value);
          }
        }
      }
    }

    expect(samples.size).toBeGreaterThan(8);
    for (const [name, value] of samples) {
      expect(
        sanitizeCss(`${name}: ${value}`),
        `KaTeX's "${name}: ${value}" must survive the sanitiser or the formula loses its layout`,
      ).not.toBe("");
    }
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
      expect(html, vector).not.toMatch(/<script|onerror|onload/i);
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

describe("embeds are isolated rather than removed (§12)", () => {
  it("keeps an HTTPS iframe with the enforced sandbox", () => {
    const html = renderMarkdown('<iframe src="https://player.example/v"></iframe>');

    // §12 permits arbitrary HTTPS embeds, so the element stays — the sandbox is what stops
    // it reaching this origin.
    expect(html).toContain("<iframe");
    expect(html).toContain("sandbox=");
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(containsActiveContent(html)).toBe(false);
  });

  it("removes an embed that is not HTTPS", () => {
    expect(renderMarkdown('<iframe src="http://player.example/v"></iframe>')).not.toContain(
      "<iframe",
    );
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
