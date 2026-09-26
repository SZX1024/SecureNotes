/**
 * Open notes (§22).
 *
 * Tabs are a list of note ids, and everything the interface needs to do with them is a function over that list. Kept
 * pure and away from the component for the usual reason: which tab becomes active when one is closed, whether a tab
 * is dirty, and what a stored list is allowed to contain are decisions worth testing without a browser.
 */

export const OPEN_TABS_STORAGE_KEY = "securenotes.openTabs";

/**
 * How many notes may be open at once.
 *
 * A bound rather than a limit anyone will meet: the strip has to stay usable, and an unbounded list restored from
 * storage is a list that grows every session.
 */
export const MAX_OPEN_TABS = 12;

/**
 * The list with `id` added at the end.
 *
 * A note that is already open keeps the place it has: activating a tab is not a reason for it to move, and a strip
 * whose tabs rearrange themselves under the cursor is a strip you cannot learn. The first version of this moved the
 * note to the end — "most recent last" — and that is exactly what it looked like in use.
 *
 * When the list is full the oldest entry goes, which is the one that has been open longest rather than the one least
 * recently looked at: the alternative is a tab disappearing from under someone who was working in it a moment ago.
 */
export function addTab(tabs: readonly string[], id: string): string[] {
  if (tabs.includes(id)) {
    return [...tabs];
  }
  const next = [...tabs, id];
  return next.length > MAX_OPEN_TABS ? next.slice(next.length - MAX_OPEN_TABS) : next;
}

export function removeTab(tabs: readonly string[], id: string): string[] {
  return tabs.filter((entry) => entry !== id);
}

/**
 * Which tab to show when the active one is closed.
 *
 * The one that takes its place in the strip, and the last one when it was at the end: closing a tab should leave the
 * reader next to where they were rather than at the other end of the strip. Null means nothing is left open.
 */
export function neighbourAfterClose(tabs: readonly string[], closing: string): string | null {
  const index = tabs.indexOf(closing);
  if (index < 0) {
    return tabs.at(-1) ?? null;
  }
  const remaining = [...tabs.slice(0, index), ...tabs.slice(index + 1)];
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

export interface DraftText {
  title: string;
  body: string;
}

/**
 * Whether what is on screen differs from what is stored.
 *
 * A tab marks itself when the editor holds something the database does not, because switching away from unsaved work
 * without saying so is how an edit disappears.
 */
export function isDirty(draft: DraftText | null, stored: DraftText | null): boolean {
  if (draft === null) {
    return false;
  }
  if (stored === null) {
    return true;
  }
  return draft.title !== stored.title || draft.body !== stored.body;
}

export interface TabsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * The stored list, filtered to something this build can render.
 *
 * Ids come from a browser profile: a stale entry, a note since deleted for good, or a hand-edited value must not
 * produce a tab that cannot be opened.
 */
export function parseTabs(raw: string | null, known: (id: string) => boolean): string[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || seen.has(entry) || !known(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result.slice(-MAX_OPEN_TABS);
}

export function loadTabs(storage: TabsStorage, known: (id: string) => boolean): string[] {
  return parseTabs(storage.getItem(OPEN_TABS_STORAGE_KEY), known);
}

export function saveTabs(storage: TabsStorage, tabs: readonly string[]): void {
  storage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify(tabs.slice(-MAX_OPEN_TABS)));
}
