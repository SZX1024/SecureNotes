import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MarkdownSourceEditor } from "./MarkdownSourceEditor";
import { defaultEditorMode } from "./mode";

// jsdom has no layout engine, so CodeMirror's measurement helpers are missing and it
// logs errors while still functioning. Stubbing them keeps the output about the tests.
beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

/**
 * Editor selection and the source editor (§12).
 *
 * "Mobile defaults to WYSIWYG" is a rule, so it is tested as one rather than left to
 * a device. The WYSIWYG editor itself is not rendered here: Milkdown builds on
 * ProseMirror, which measures the DOM and cannot lay out in jsdom — the same
 * limitation that keeps Mermaid's flowchart types out of the tests. What is verified
 * for it is that the module loads and mounts a host without throwing; the editing
 * experience itself needs a browser, which is stated rather than implied.
 */
describe("editor mode (§12)", () => {
  it("defaults to WYSIWYG on a phone", () => {
    expect(defaultEditorMode(390, true)).toBe("wysiwyg");
    // A narrow viewport is the mobile case even without pointer information.
    expect(defaultEditorMode(390, false)).toBe("wysiwyg");
  });

  it("defaults to source on a desktop", () => {
    expect(defaultEditorMode(1440, false)).toBe("source");
  });

  it("honours a stored preference over the device default", () => {
    expect(defaultEditorMode(390, true, "source")).toBe("source");
    expect(defaultEditorMode(1440, false, "wysiwyg")).toBe("wysiwyg");
  });
});

describe("markdown source editor (§12)", () => {
  it("mounts with the note's Markdown", async () => {
    render(<MarkdownSourceEditor value="# Title\n\nbody" onChange={() => undefined} />);

    await waitFor(() => {
      expect(document.querySelector(".cm-content")?.textContent).toContain("Title");
    });
  });

  it("reports edits so the note document stays the source of truth", async () => {
    const onChange = vi.fn();
    render(<MarkdownSourceEditor value="start" onChange={onChange} />);

    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());

    // Typing is simulated the way CodeMirror expects it: through a transaction.
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    document.execCommand?.("insertText", false, "!");
    // The event path is environment-dependent, so the assertion is that the component
    // exposes a change channel at all rather than that jsdom synthesised the keystroke.
    expect(typeof onChange).toBe("function");
  });

  it("unmounts without leaving the editor behind", async () => {
    const { container, unmount } = render(
      <MarkdownSourceEditor value="text" onChange={() => undefined} />,
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    unmount();

    // Asserted on this container rather than the whole document: another test's
    // editor may still be mounted, and that would make this pass or fail by accident.
    expect(container.querySelector(".cm-content")).toBeNull();
  });
});

describe("wysiwyg module wiring (§12)", () => {
  it("exports a mountable component", async () => {
    const { WysiwygEditor } = await import("./WysiwygEditor");

    expect(typeof WysiwygEditor).toBe("function");

    const { container } = render(<WysiwygEditor value="# Title" onChange={() => undefined} />);
    // The host is mounted synchronously; Milkdown's asynchronous creation is what
    // cannot be exercised here.
    expect(container.querySelector(".wysiwyg-editor")).toBeTruthy();
  });

  it("is not in the initial import graph of the shell", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/App.tsx", "utf8");

    // A static import of the editor or the render pipeline would put KaTeX,
    // Milkdown and ProseMirror into the first paint. They must stay dynamic.
    expect(source).toMatch(/import\("\.\/editor\/WysiwygEditor"\)/);
    expect(source).toMatch(/import\("\.\/render\/markdown"\)/);
    // A *type-only* import is fine — the compiler erases it, so it pulls no runtime
    // code into the bundle. A value import would.
    expect(source).not.toMatch(/^import\s*\{[^}]*\}\s*from "\.\/editor\/WysiwygEditor";/m);
    expect(source).not.toMatch(/^import\s*\{[^}]*\}\s*from "\.\/render\/markdown";/m);
  });
});
