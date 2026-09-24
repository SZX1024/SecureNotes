import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { WysiwygEditor } from "./WysiwygEditor";

/**
 * In-place rendering inside the WYSIWYG editor (§12).
 *
 * ProseMirror needs a DOM to lay out, and jsdom has none, so these tests assert what can be
 * measured here: that the plugin can be registered without breaking the editor, and that a
 * formula produces KaTeX markup once the document is in place. The visual result still needs a
 * browser, and that is stated rather than implied.
 */
beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = () => undefined;
});

describe("editor mount with the inline-render plugin (§12)", () => {
  it("mounts and contains the note's text", async () => {
    const { container } = render(
      <WysiwygEditor value={"Formula $a^2 + b^2 = c^2$ here\n"} onChange={() => undefined} />,
    );

    await waitFor(
      () => {
        expect(container.querySelector(".wysiwyg-editor")).toBeTruthy();
      },
      { timeout: 4000 },
    );

    // The rendered document must contain the note's words either way; the formula may be
    // rendered as KaTeX or still be source depending on whether ProseMirror laid out.
    await waitFor(
      () => {
        const text = container.textContent ?? "";
        expect(text.includes("Formula") || text.includes("katex")).toBe(true);
      },
      { timeout: 4000 },
    );
  });

  it("renders the formula in place while the document keeps the Markdown source", () => {
    // The property that matters: the decoration is presentation only. The rendered KaTeX is
    // in the DOM, and the document still holds the TeX the note is stored as — so nothing
    // generated ever reaches the saved text.
    const { container } = render(
      <WysiwygEditor value={"Formula $a^2 + b^2 = c^2$ here\n"} onChange={() => undefined} />,
    );

    return waitFor(() => expect(container.querySelector(".katex")).toBeTruthy(), {
      timeout: 4000,
    }).then(() => {
      expect(container.textContent).toContain("$a^2 + b^2 = c^2$");
      // The source is hidden by a class, not deleted, so the cursor can reveal it again.
      expect(container.querySelector(".render-source-hidden")).toBeTruthy();
    });
  });
});
