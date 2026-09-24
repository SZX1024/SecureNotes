import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "./rich-text";
import { loadRichTextPreference, saveRichTextPreference, RICH_TEXT_STORAGE_KEY } from "./paste";

/**
 * Rich-text paste conversion (§12, §31).
 *
 * The clipboard is untrusted HTML, so the tests are as much about what must not survive
 * as about the formatting that should.
 */

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("conversion (§12)", () => {
  it("keeps the formatting a user would expect", async () => {
    const markdown = await htmlToMarkdown(
      "<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> text.</p>" +
        "<ul><li>one</li><li>two</li></ul>",
    );

    expect(markdown).toContain("## Title");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("*italic*");
    expect(markdown).toMatch(/^[-*]\s+one$/m);
    expect(markdown).toMatch(/^[-*]\s+two$/m);
  });

  it("converts links and images", async () => {
    const markdown = await htmlToMarkdown(
      '<p><a href="https://example.com">a link</a></p><p><img src="https://example.com/i.png" alt="pic"></p>',
    );

    expect(markdown).toContain("[a link](https://example.com)");
    expect(markdown).toContain("![pic](https://example.com/i.png)");
  });

  it("converts a table, which needs the GFM plugin", async () => {
    const markdown = await htmlToMarkdown(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );

    expect(markdown).toContain("| a | b |");
    expect(markdown).toContain("| 1 | 2 |");
  });

  it("converts code blocks to fences", async () => {
    const markdown = await htmlToMarkdown("<pre><code>const a = 1;</code></pre>");

    expect(markdown).toContain("```");
    expect(markdown).toContain("const a = 1;");
  });

  it("removes script, event handlers and styles before converting", async () => {
    const markdown = await htmlToMarkdown(
      '<p>kept</p><script>alert(1)</script><img src="https://e.example/i.png" onerror="alert(2)">' +
        '<div style="background: url(https://evil.example/track.png)">styled</div>',
    );

    expect(markdown).toContain("kept");
    expect(markdown).not.toMatch(/script|alert|onerror/i);
    expect(markdown).not.toContain("evil.example");
    expect(markdown).not.toContain("url(");
  });

  it("drops a javascript: link rather than carrying it into the note", async () => {
    const markdown = await htmlToMarkdown('<a href="javascript:alert(1)">click</a>');

    expect(markdown).not.toMatch(/javascript:/i);
  });

  it("never returns raw HTML, because a stored script would run when rendered", async () => {
    const markdown = await htmlToMarkdown(
      '<p>text</p><iframe src="https://evil.example"></iframe><svg onload="alert(1)"></svg><math><mtext>x</mtext></math>',
    );

    expect(markdown).not.toMatch(/<[a-z]/i);
    expect(markdown).not.toMatch(/iframe|onload|mtext/i);
  });

  it("handles paste content with no useful markup", async () => {
    expect(await htmlToMarkdown("")).toBe("");
    expect(await htmlToMarkdown("   ")).toBe("");
  });
});

describe("remembering the choice (§12)", () => {
  it("round-trips both answers", () => {
    const storage = memoryStorage();
    saveRichTextPreference(storage, "html");

    expect(storage.values.get(RICH_TEXT_STORAGE_KEY)).toBe("html");
    expect(loadRichTextPreference(storage)).toBe("html");

    saveRichTextPreference(storage, "plain");
    expect(loadRichTextPreference(storage)).toBe("plain");
  });

  it("asks again when nothing valid was stored", () => {
    expect(loadRichTextPreference(memoryStorage())).toBeNull();
    expect(
      loadRichTextPreference(memoryStorage({ [RICH_TEXT_STORAGE_KEY]: "markdown" })),
    ).toBeNull();
  });
});
