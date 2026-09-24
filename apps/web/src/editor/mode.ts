/**
 * Which editor mode to start in (§12).
 *
 * Its own module, with no editor imports, for two reasons that turned out to be the
 * same reason: a component file may only export components (or fast refresh cannot
 * work), and importing this decision from the file that imports CodeMirror would pull
 * CodeMirror into the first paint — the opposite of what the lazy loading is for.
 */

export type EditorMode = "wysiwyg" | "source";

/** The default mode for a device (§12: mobile defaults to WYSIWYG). */
export function defaultEditorMode(
  viewportWidth: number,
  hasCoarsePointer: boolean,
  stored?: EditorMode | null,
): EditorMode {
  if (stored === "wysiwyg" || stored === "source") {
    return stored;
  }
  // A coarse pointer means touch, and a narrow viewport means a phone: both are the
  // mobile case the requirement names.
  return hasCoarsePointer || viewportWidth < 768 ? "wysiwyg" : "source";
}

/** Where a remembered mode is kept. Local UI state, never synced. */
export const EDITOR_MODE_STORAGE_KEY = "securenotes.editor-mode";

export interface ModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function loadEditorMode(storage: ModeStorage): EditorMode | null {
  const stored = storage.getItem(EDITOR_MODE_STORAGE_KEY);
  return stored === "wysiwyg" || stored === "source" ? stored : null;
}

export function saveEditorMode(storage: ModeStorage, mode: EditorMode): void {
  storage.setItem(EDITOR_MODE_STORAGE_KEY, mode);
}
