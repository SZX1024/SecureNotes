import { MAX_ATTACHMENT_BYTES } from "@securenotes/shared";

/**
 * Paste and drop handling (§12).
 *
 * The clipboard is an untrusted input: rich text copied from a web page arrives as
 * HTML that can carry scripts, styles that phone home, and form controls. Nothing
 * here inserts anything — the decisions are separated from the DOM on purpose, so the
 * rules can be tested and the caller cannot invent its own.
 */

/** What the user chose the last time rich text was pasted. */
export type RichTextPreference = "html" | "plain" | null;

export type PasteDecision =
  /** A clipboard image becomes an attachment immediately (§12). */
  | { kind: "attach-image"; file: File }
  | { kind: "ask-rich-text"; html: string; text: string }
  | { kind: "insert-html"; html: string }
  | { kind: "insert-text"; text: string }
  | { kind: "reject"; reason: string };

export interface PasteItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

export interface PasteInput {
  items: readonly PasteItem[];
  html: string | null;
  text: string | null;
  richTextPreference: RichTextPreference;
}

/**
 * Decides what a paste should do.
 *
 * Order matters: an image on the clipboard wins over the text representation a
 * screenshot also provides, because the image is what the user copied.
 */
export function decidePaste(input: PasteInput): PasteDecision {
  for (const item of input.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          return {
            kind: "reject",
            reason: `Images are limited to ${formatMegabytes(MAX_ATTACHMENT_BYTES)}.`,
          };
        }
        return { kind: "attach-image", file };
      }
    }
  }

  const html = input.html?.trim() ?? "";
  const text = input.text ?? "";

  if (html.length > 0) {
    // §12: pasting from a web page asks the user how to handle it, unless they have
    // already answered and the answer is remembered.
    if (input.richTextPreference === "html") {
      // The caller must run this through the sanitizer; the decision only says which
      // path was chosen.
      return { kind: "insert-html", html };
    }
    if (input.richTextPreference === "plain") {
      return { kind: "insert-text", text };
    }
    return { kind: "ask-rich-text", html, text };
  }

  if (text.length > 0) {
    return { kind: "insert-text", text };
  }
  return { kind: "reject", reason: "Nothing to paste." };
}

export type DropDecision =
  { kind: "attach-images"; files: File[] } | { kind: "reject"; reason: string };

/**
 * Decides what a drag-and-drop should do.
 *
 * §12 allows images only, and rejects anything over 20 MB. A mixed drop is rejected
 * as a whole rather than silently partially accepted, so the user is not left
 * wondering which of three files actually arrived.
 */
export function decideDrop(files: readonly { type: string; size: number }[]): DropDecision {
  if (files.length === 0) {
    return { kind: "reject", reason: "Nothing to drop." };
  }

  const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) {
    return {
      kind: "reject",
      reason: `Each file must be under ${formatMegabytes(MAX_ATTACHMENT_BYTES)}.`,
    };
  }

  const notAnImage = files.find((file) => !file.type.startsWith("image/"));
  if (notAnImage) {
    return { kind: "reject", reason: "Only images can be dropped into a note." };
  }

  return { kind: "attach-images", files: files as File[] };
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
