import { readFileSync } from "node:fs";
import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { WysiwygEditor } from "./WysiwygEditor";

/**
 * Documents the WYSIWYG editor must be able to open (§12).
 *
 * The regression this exists for: `![alt](url)` without a title parses to an mdast node with
 * `title: null`, but Milkdown's image node declares `title` as a string, so the conversion threw
 * and took the whole editor down. My earlier tests only used text and formulas, so a note
 * containing any image was unopenable and nothing caught it. These tests open real documents
 * instead of toy values.
 */
beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = () => undefined;
});

/** Mounts the editor and reports anything it logged as an error. */
async function mount(value: string) {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const { container, unmount } = render(
      <WysiwygEditor value={value} onChange={() => undefined} />,
    );
    await waitFor(() => expect(container.querySelector(".wysiwyg-editor")).toBeTruthy(), {
      timeout: 5000,
    });
    // ProseMirror and Milkdown resolve over several microtask turns.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { container, errors, unmount };
  } finally {
    console.error = original;
  }
}

describe("notes that must open in the visual editor", () => {
  it("opens a note with an image and no title", async () => {
    const { container, errors, unmount } = await mount(
      "Before\n\n![shot](/api/v1/attachments/abc/content)\n\nAfter\n",
    );

    expect(errors).toEqual([]);
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    // The image survives the conversion rather than being dropped with the failure.
    expect(container.querySelector("img")).toBeTruthy();
    unmount();
  });

  it("opens a note with an image with a title, and a link without one", async () => {
    const { container, errors, unmount } = await mount(
      '![a](https://example.com/i.png "a title")\n\n[link](https://example.com)\n',
    );

    expect(errors).toEqual([]);
    expect(container.querySelector("img")).toBeTruthy();
    unmount();
  });

  it("opens a note with no alt text", async () => {
    const { errors, unmount } = await mount("![](https://example.com/i.png)\n");

    expect(errors).toEqual([]);
    unmount();
  });

  it("opens the full feature document without logging an error", async () => {
    const document = readFileSync("../../.sandbox-home/test-doc.md", "utf8");

    const { container, errors, unmount } = await mount(document);

    expect(errors).toEqual([]);
    // A representative sample of the features §12 requires.
    for (const expected of ["文本与结构", "代码", "数学", "安全向量"]) {
      expect(container.textContent, expected).toContain(expected);
    }
    // The formulas are rendered in place, and the Markdown source is still in the document.
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
    unmount();
  }, 30_000);
});
