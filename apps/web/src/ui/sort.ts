/**
 * Note list ordering and the "recently opened" list (§10).
 *
 * Sorting is a pure function so the rules are testable and the UI cannot invent
 * its own: "recently modified", "creation time", "title" and manual drag order
 * are the four §10 names, and pinning is a separate axis that applies to all of
 * them.
 */

export type SortKey = "modified" | "created" | "title" | "manual";

export interface SortableNote {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  pinned: boolean;
  sortOrder: number;
}

export const SORT_KEYS: readonly SortKey[] = ["modified", "created", "title", "manual"];

export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  modified: "Recently modified",
  created: "Creation time",
  title: "Title",
  manual: "Manual order",
};

/** Sorts notes for display. Pinned notes always come first. */
export function sortNotes<T extends SortableNote>(notes: readonly T[], key: SortKey): T[] {
  const comparators: Record<SortKey, (a: T, b: T) => number> = {
    modified: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => a.title.localeCompare(b.title),
    manual: (a, b) => a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt,
  };

  return [...notes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) || comparators[key](a, b) || a.id.localeCompare(b.id),
  );
}

/**
 * Records that a note was opened.
 *
 * The list is ordered most-recent-first, holds each note once, and is bounded so
 * it cannot grow without limit. It is local UI state, not synced data: §10 asks
 * for a recent list, not for a per-device history on the server.
 */
export function rememberOpened(recent: readonly string[], noteId: string, limit = 20): string[] {
  return [noteId, ...recent.filter((id) => id !== noteId)].slice(0, limit);
}

/** Moves a note within the manual order, returning the ids in their new order. */
export function moveInOrder(
  order: readonly string[],
  noteId: string,
  targetIndex: number,
): string[] {
  const without = order.filter((id) => id !== noteId);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));
  return [...without.slice(0, clamped), noteId, ...without.slice(clamped)];
}
