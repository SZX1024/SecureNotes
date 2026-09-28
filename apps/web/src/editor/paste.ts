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
  /** A file on the clipboard becomes an attachment immediately (§12). */
  | { kind: "attach-file"; file: File }
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
 * Order matters: a file on the clipboard wins over the text representation the same
 * copy also provides, because the file is what the user copied. Any file, not only an
 * image — a copied document or archive is an attachment too.
 */
export function decidePaste(input: PasteInput): PasteDecision {
  for (const item of input.items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          return {
            kind: "reject",
            reason: `Files are limited to ${formatMegabytes(MAX_ATTACHMENT_BYTES)}.`,
          };
        }
        return { kind: "attach-file", file };
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
  { kind: "attach-files"; files: File[] } | { kind: "reject"; reason: string };

/**
 * Decides what a drag-and-drop should do.
 *
 * Any file (§12 as amended), up to the size limit. A drop is rejected as a whole rather
 * than silently partially accepted, so the user is not left wondering which of three
 * files actually arrived.
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

  return { kind: "attach-files", files: files as File[] };
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Where a remembered rich-text decision is kept. Local UI state, never synced. */
export const RICH_TEXT_STORAGE_KEY = "securenotes.rich-text-paste";

export interface PreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function loadRichTextPreference(storage: PreferenceStorage): RichTextPreference {
  const stored = storage.getItem(RICH_TEXT_STORAGE_KEY);
  return stored === "html" || stored === "plain" ? stored : null;
}

export function saveRichTextPreference(
  storage: PreferenceStorage,
  preference: Exclude<RichTextPreference, null>,
): void {
  storage.setItem(RICH_TEXT_STORAGE_KEY, preference);
}
