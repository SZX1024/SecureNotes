import { describe, expect, it } from "vitest";

import { snippetOf } from "./note-snippet";

describe("a note's preview line", () => {
  it("returns the opening words, flattened onto one line", () => {
    expect(snippetOf("# Title\n\nFirst paragraph.\nSecond line.")).toBe(
      "Title First paragraph. Second line.",
    );
  });

  it("strips the furniture that would read as noise in a list", () => {
    expect(snippetOf("## Heading\n\n> a quote\n\n- an item\n\n1. numbered")).toBe(
      "Heading a quote an item numbered",
    );
    expect(snippetOf("Some **bold** and _italic_ and `code`.")).toBe(
      "Some bold and italic and code.",
    );
  });

  it("keeps a link's words and drops its target", () => {
    expect(snippetOf("See [the docs](https://example.com/x) for more.")).toBe(
      "See the docs for more.",
    );
    expect(snippetOf("![a picture](attachment://abc)Text follows.")).toBe("Text follows.");
  });

  it("truncates at a word boundary rather than mid-word", () => {
    const long = `${"word ".repeat(40)}end`;
    const snippet = snippetOf(long);
    expect(snippet.length).toBeLessThanOrEqual(91);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("wor…");
  });

  it("returns an empty string for a note with nothing in it", () => {
    expect(snippetOf("")).toBe("");
    expect(snippetOf("\n\n   \n")).toBe("");
  });
});
