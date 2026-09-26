/**
 * Keyboard shortcuts and the command palette (§10, §23).
 *
 * Both are pure data so the bindings can be asserted rather than discovered by
 * pressing keys: a shortcut that silently stops working is invisible otherwise.
 *
 * Shortcuts never fire while a text field has focus unless they use a modifier,
 * because a global "n" would otherwise be impossible to type into a note.
 */

export interface Shortcut {
  id: string;
  /** Key values as `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "search", key: "k", ctrlOrMeta: true, description: "Search all notes" },
  { id: "command-palette", key: "p", ctrlOrMeta: true, description: "Command palette" },
  { id: "new-note", key: "n", ctrlOrMeta: true, description: "New note" },
  { id: "save-note", key: "s", ctrlOrMeta: true, description: "Save the current note" },
  { id: "toggle-sidebar", key: "b", ctrlOrMeta: true, description: "Toggle the folder pane" },
  { id: "show-recycle-bin", key: "r", ctrlOrMeta: true, shift: true, description: "Recycle bin" },
  // Ctrl+Shift+Backspace rather than Delete on its own: a bare Delete fires wherever the focus happens to be, and
  // a note disappearing because someone pressed a key while looking at something else is not a shortcut. Not
  // Ctrl+Shift+Delete either — that is the browser's own "clear browsing data", so the page never sees the key.
  {
    id: "delete-note",
    key: "Backspace",
    ctrlOrMeta: true,
    shift: true,
    description: "Move the note to the recycle bin",
  },
  { id: "escape", key: "Escape", description: "Close the palette or search" },
];

export interface ShortcutMatchInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True when the event originated in an input, textarea or contenteditable. */
  fromTextField: boolean;
}

/** The shortcut id an event should trigger, or null. */
export function matchShortcut(input: ShortcutMatchInput): string | null {
  const hasModifier = input.ctrlKey || input.metaKey;

  for (const shortcut of SHORTCUTS) {
    if (shortcut.key.toLowerCase() !== input.key.toLowerCase()) {
      continue;
    }
    if ((shortcut.ctrlOrMeta ?? false) !== hasModifier) {
      continue;
    }
    if ((shortcut.shift ?? false) !== input.shiftKey) {
      continue;
    }
    if ((shortcut.alt ?? false) !== input.altKey) {
      continue;
    }
    // Unmodified keys are dangerous inside a text field; Escape is the exception
    // because it is how a user dismisses an overlay from anywhere.
    if (input.fromTextField && !hasModifier && shortcut.key !== "Escape") {
      return null;
    }
    return shortcut.id;
  }
  return null;
}

/** Renders a shortcut for display, using the platform's modifier convention. */
export function formatShortcut(shortcut: Shortcut, isApple = false): string {
  const parts: string[] = [];
  if (shortcut.ctrlOrMeta) {
    parts.push(isApple ? "⌘" : "Ctrl");
  }
  if (shortcut.shift) {
    parts.push("⇧");
  }
  if (shortcut.alt) {
    parts.push(isApple ? "⌥" : "Alt");
  }
  parts.push(shortcut.key === "Escape" ? "Esc" : shortcut.key.toUpperCase());
  return parts.join(isApple ? "" : "+");
}

export interface Command {
  id: string;
  label: string;
  /** Extra words a fuzzy query may match, e.g. synonyms. */
  keywords?: string;
  run?: () => void;
}

/**
 * Filters commands for the palette.
 *
 * Matching is a prefix-or-substring test over the label and keywords rather than
 * a fuzzy subsequence match: a palette that returns "Delete everything" for
 * "de" is worse than one that returns nothing.
 */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...commands];
  }

  return commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** Builds the palette entries for the current app state. */
export function buildCommands(actions: {
  newNote: () => void;
  search: () => void;
  toggleSidebar: () => void;
  showRecycleBin: () => void;
  lock: () => void;
  signOut: () => void;
  sortBy: (key: string) => void;
  deleteNote: () => void;
}): Command[] {
  return [
    { id: "new-note", label: "New note", keywords: "create write", run: actions.newNote },
    { id: "search", label: "Search notes", keywords: "find filter", run: actions.search },
    {
      id: "delete-note",
      label: "Move this note to the recycle bin",
      keywords: "delete remove trash discard",
      run: actions.deleteNote,
    },
    {
      id: "toggle-sidebar",
      label: "Toggle folder pane",
      keywords: "sidebar layout",
      run: actions.toggleSidebar,
    },
    {
      id: "recycle-bin",
      label: "Open recycle bin",
      keywords: "deleted trash",
      run: actions.showRecycleBin,
    },
    {
      id: "sort-modified",
      label: "Sort by recently modified",
      keywords: "order",
      run: () => actions.sortBy("modified"),
    },
    {
      id: "sort-created",
      label: "Sort by creation time",
      keywords: "order",
      run: () => actions.sortBy("created"),
    },
    {
      id: "sort-title",
      label: "Sort by title",
      keywords: "order",
      run: () => actions.sortBy("title"),
    },
    {
      id: "sort-manual",
      label: "Sort by manual order",
      keywords: "order drag",
      run: () => actions.sortBy("manual"),
    },
    { id: "lock", label: "Lock now", keywords: "app lock", run: actions.lock },
    { id: "sign-out", label: "Sign out", keywords: "logout", run: actions.signOut },
  ];
}
