/**
 * Typography (§22).
 *
 * How large the interface and the notes are set, and how wide a line of prose runs. Kept pure and separate from the
 * dialog that offers it: what a stored preference means, and what it becomes in CSS, are decisions worth testing
 * without a browser.
 *
 * A stored value is treated as a suggestion rather than as the truth. It comes from a browser profile that may be
 * years old, may have been edited by hand, or may be the leftovers of a build that offered different choices, so
 * every field is clamped into the range this build can actually render. A preference that cannot be rendered is
 * worse than a default, because it produces a broken-looking interface the user cannot explain.
 */

export type EditorWidth = "full" | "comfortable";

export interface Typography {
  /** The interface's own size, in pixels. */
  interfaceSize: number;
  /** The size of a note's text, in pixels. */
  noteSize: number;
  /** The line height of prose. */
  lineHeight: number;
  /** How wide a line of prose is allowed to run. */
  editorWidth: EditorWidth;
}

export const TYPOGRAPHY_STORAGE_KEY = "securenotes.typography";

export const INTERFACE_SIZES = [12, 13, 14, 15, 16] as const;
export const NOTE_SIZES = [13, 14, 15, 16, 17, 18, 20] as const;
export const LINE_HEIGHTS = [1.4, 1.55, 1.7, 1.85, 2] as const;
export const EDITOR_WIDTHS: ReadonlyArray<{ value: EditorWidth; label: string }> = [
  { value: "full", label: "Full width" },
  { value: "comfortable", label: "Comfortable" },
];

export const DEFAULT_TYPOGRAPHY: Typography = {
  interfaceSize: 13,
  noteSize: 16,
  lineHeight: 1.7,
  editorWidth: "full",
};

export interface TypographyStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function clamp(value: number, smallest: number, largest: number): number {
  if (!Number.isFinite(value)) {
    return smallest;
  }
  return Math.min(largest, Math.max(smallest, value));
}

/** A stored preference, with anything unrenderable replaced by the default. */
export function parseTypography(raw: string | null): Typography {
  if (raw === null) {
    return DEFAULT_TYPOGRAPHY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_TYPOGRAPHY;
  }

  const candidate = parsed as Partial<Record<keyof Typography, unknown>>;
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" ? value : fallback;

  return {
    interfaceSize: clamp(
      number(candidate.interfaceSize, DEFAULT_TYPOGRAPHY.interfaceSize),
      Math.min(...INTERFACE_SIZES),
      Math.max(...INTERFACE_SIZES),
    ),
    noteSize: clamp(
      number(candidate.noteSize, DEFAULT_TYPOGRAPHY.noteSize),
      Math.min(...NOTE_SIZES),
      Math.max(...NOTE_SIZES),
    ),
    lineHeight: clamp(
      number(candidate.lineHeight, DEFAULT_TYPOGRAPHY.lineHeight),
      Math.min(...LINE_HEIGHTS),
      Math.max(...LINE_HEIGHTS),
    ),
    editorWidth:
      candidate.editorWidth === "comfortable" || candidate.editorWidth === "full"
        ? candidate.editorWidth
        : DEFAULT_TYPOGRAPHY.editorWidth,
  };
}

export function loadTypography(storage: TypographyStorage): Typography {
  return parseTypography(storage.getItem(TYPOGRAPHY_STORAGE_KEY));
}

export function saveTypography(storage: TypographyStorage, typography: Typography): void {
  storage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(typography));
}

/**
 * The preference as CSS custom properties.
 *
 * The interface's smaller sizes are derived rather than separately chosen: a heading and a label that do not move
 * with the body text are how a "larger font" setting ends up looking broken.
 */
export function typographyStyle(typography: Typography): Record<string, string> {
  return {
    "--text-ui": `${typography.interfaceSize}px`,
    "--text-sm": `${typography.interfaceSize - 1}px`,
    "--text-xs": `${typography.interfaceSize - 2}px`,
    "--font-note-size": `${typography.noteSize}px`,
    "--line-prose": String(typography.lineHeight),
  };
}

export interface TypographyRoot {
  style: { setProperty: (name: string, value: string) => void };
  dataset: Record<string, string | undefined>;
}

/** Puts the preference on the document, which is where the stylesheet reads it. */
export function applyTypography(typography: Typography, root: TypographyRoot): void {
  for (const [name, value] of Object.entries(typographyStyle(typography))) {
    root.style.setProperty(name, value);
  }
  root.dataset["editorWidth"] = typography.editorWidth;
}
