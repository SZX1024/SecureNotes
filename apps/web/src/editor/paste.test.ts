import { MAX_ATTACHMENT_BYTES } from "@securenotes/shared";
import { describe, expect, it } from "vitest";

import { decideDrop, decidePaste, formatMegabytes, type PasteItem } from "./paste";

/**
 * Paste and drop decisions (§12).
 *
 * The clipboard is the most hostile input the editor accepts, so these are the rules
 * that decide what happens to it — and they are asserted separately from the DOM so
 * no caller can quietly invent its own policy.
 */

function imageItem(type = "image/png", size = 1024): PasteItem & { size: number } {
  const file = new File([new Uint8Array(size)], "shot.png", { type });
  return { kind: "file", type, getAsFile: () => file, size };
}

/** A file of any type on the clipboard. */
function fileItem(type: string): PasteItem {
  return {
    kind: "file",
    type,
    getAsFile: () => new File([new Uint8Array([1, 2, 3])], "archive.zip", { type }),
  };
}

describe("paste (§12)", () => {
  it("turns a clipboard image into an attachment", () => {
    const decision = decidePaste({
      items: [imageItem()],
      html: null,
      text: null,
      richTextPreference: null,
    });

    expect(decision.kind).toBe("attach-file");
  });

  it("turns any pasted file into an attachment, not only a picture", () => {
    const decision = decidePaste({
      items: [fileItem("application/zip")],
      html: null,
      text: null,
      richTextPreference: null,
    });

    expect(decision.kind).toBe("attach-file");
  });

  it("attaches a file whose type the clipboard does not report", () => {
    // An extensionless file arrives with an empty type, and it is still a file.
    const decision = decidePaste({
      items: [fileItem("")],
      html: null,
      text: null,
      richTextPreference: null,
    });

    expect(decision.kind).toBe("attach-file");
  });

  it("prefers the image when the clipboard also carries text", () => {
    // A screenshot puts both an image and a text representation on the clipboard; the
    // image is what the user copied.
    const decision = decidePaste({
      items: [imageItem()],
      html: "<p>something</p>",
      text: "something",
      richTextPreference: null,
    });

    expect(decision.kind).toBe("attach-file");
  });

  it("rejects an image over the limit", () => {
    const decision = decidePaste({
      items: [imageItem("image/png", MAX_ATTACHMENT_BYTES + 1)],
      html: null,
      text: null,
      richTextPreference: null,
    });

    expect(decision.kind).toBe("reject");
    expect(decision.kind === "reject" && decision.reason).toContain("MB");
  });

  it("asks before converting rich text from a web page", () => {
    const decision = decidePaste({
      items: [],
      html: "<p>copied <b>rich</b></p>",
      text: "copied rich",
      richTextPreference: null,
    });

    expect(decision.kind).toBe("ask-rich-text");
    expect(decision.kind === "ask-rich-text" && decision.text).toBe("copied rich");
  });

  it("honours a remembered choice instead of asking again", () => {
    const base = { items: [], html: "<p>rich</p>", text: "rich" };

    expect(decidePaste({ ...base, richTextPreference: "html" }).kind).toBe("insert-html");
    expect(decidePaste({ ...base, richTextPreference: "plain" }).kind).toBe("insert-text");
  });

  it("inserts plain text when there is no markup", () => {
    const decision = decidePaste({
      items: [],
      html: null,
      text: "just text",
      richTextPreference: null,
    });

    expect(decision.kind).toBe("insert-text");
  });

  it("treats empty markup as plain text", () => {
    const decision = decidePaste({
      items: [],
      html: "   ",
      text: "text",
      richTextPreference: null,
    });

    expect(decision.kind).toBe("insert-text");
  });

  it("rejects an empty clipboard", () => {
    expect(decidePaste({ items: [], html: null, text: null, richTextPreference: null }).kind).toBe(
      "reject",
    );
    expect(decidePaste({ items: [], html: "", text: "", richTextPreference: null }).kind).toBe(
      "reject",
    );
  });
});

describe("drop (§12 as amended: any file, with a size limit)", () => {
  it("accepts images", () => {
    const decision = decideDrop([
      { type: "image/png", size: 1000 },
      { type: "image/jpeg", size: 2000 },
    ]);

    expect(decision.kind).toBe("attach-files");
    expect(decision.kind === "attach-files" && decision.files).toHaveLength(2);
  });

  it("accepts files that are not images", () => {
    const decision = decideDrop([
      { type: "application/pdf", size: 10 },
      { type: "", size: 10 },
      { type: "application/zip", size: 10 },
    ]);

    expect(decision.kind).toBe("attach-files");
    expect(decision.kind === "attach-files" && decision.files).toHaveLength(3);
  });

  it("rejects a mixed drop that contains one file over the limit, as a whole", () => {
    // Silently accepting one of two files would leave the user unsure what arrived.
    const decision = decideDrop([
      { type: "text/plain", size: 10 },
      { type: "application/zip", size: MAX_ATTACHMENT_BYTES + 1 },
    ]);

    expect(decision.kind).toBe("reject");
  });

  it("rejects a file over the limit", () => {
    const decision = decideDrop([{ type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 }]);

    expect(decision.kind).toBe("reject");
    expect(decision.kind === "reject" && decision.reason).toContain("MB");
  });

  it("accepts a file exactly at the limit", () => {
    expect(decideDrop([{ type: "application/zip", size: MAX_ATTACHMENT_BYTES }]).kind).toBe(
      "attach-files",
    );
  });

  it("rejects an empty drop", () => {
    expect(decideDrop([]).kind).toBe("reject");
  });

  it("formats the limit for the user", () => {
    expect(formatMegabytes(MAX_ATTACHMENT_BYTES)).toBe("60 MB");
  });
});
