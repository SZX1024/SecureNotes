/**
 * Organisation: the folder tree, tag sets and the filters built from them (§9, §10).
 *
 * Pure functions over decrypted rows, so the rules — which notes a folder shows, what a tag change means,
 * which folders may be moved where — are testable without a database or a network.
 */

export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  children: FolderNode[];
}

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  sortOrder: number;
}

/**
 * Builds the tree from flat rows.
 *
 * A row whose parent is missing is treated as a root rather than dropped: a folder that cannot be placed
 * must still be visible, or the user's notes would appear to have vanished with it.
 */
export function buildFolderTree(rows: readonly FolderRow[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      depth: row.depth,
      children: [],
    });
  }

  /**
   * Whether a row's ancestors lead back to it.
   *
   * The server refuses to create a cycle, so this guards against a damaged local database — and the reason
   * it matters is that a cycle would otherwise make every folder in it a child of something, leaving no root
   * and therefore nothing in the tree. Folders that vanish are indistinguishable from notes that vanish.
   */
  const hasCycle = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let current = nodes.get(id)?.parentId ?? null;
    while (current !== null) {
      if (seen.has(current)) {
        return true;
      }
      seen.add(current);
      current = nodes.get(current)?.parentId ?? null;
    }
    return false;
  };

  const roots: FolderNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
    if (parent && !hasCycle(node.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const byName = (left: FolderNode, right: FolderNode) => left.name.localeCompare(right.name);
  const sort = (list: FolderNode[]) => {
    list.sort(byName);
    for (const node of list) {
      sort(node.children);
    }
  };
  sort(roots);

  return roots;
}

/** Every descendant id of a folder, excluding the folder itself. */
export function descendantIds(rows: readonly FolderRow[], id: string): string[] {
  const childrenOf = new Map<string | null, string[]>();
  for (const row of rows) {
    childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row.id]);
  }

  const found: string[] = [];
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    found.push(next);
    queue.push(...(childrenOf.get(next) ?? []));
  }
  return found;
}

/**
 * Whether a folder may be moved under another.
 *
 * Moving a folder into its own subtree would detach that subtree from the tree, and a folder cannot be its
 * own parent. The same rules the server enforces, applied here so the interface can disable the choice
 * instead of letting it fail.
 */
export function canMoveFolder(
  rows: readonly FolderRow[],
  folderId: string,
  targetParentId: string | null,
): boolean {
  if (targetParentId === null) {
    return true;
  }
  if (targetParentId === folderId) {
    return false;
  }
  return !descendantIds(rows, folderId).includes(targetParentId);
}

/** The notes a folder shows: its own, or everything when no folder is selected. */
export function notesInFolder<T extends { folderId: string | null }>(
  notes: readonly T[],
  folderId: string | null,
  rows: readonly FolderRow[] = [],
  includeSubfolders = true,
): T[] {
  if (folderId === null) {
    return [...notes];
  }
  const wanted = includeSubfolders ? [folderId, ...descendantIds(rows, folderId)] : [folderId];
  return notes.filter((note) => note.folderId !== null && wanted.includes(note.folderId));
}

/**
 * The result of changing which tags a note carries.
 *
 * Sets rather than sequences (§16 allows set semantics where they are safe): adding a tag twice is the same
 * as adding it once, and the operation the server receives is the whole set, so a retry cannot double-apply.
 */
export interface TagSetChange {
  added: string[];
  removed: string[];
  next: string[];
}

export function planTagChange(
  current: readonly string[],
  desired: readonly string[],
  maximum = 10,
): TagSetChange {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);

  // A cap rather than a silent drop: the caller decides what to tell the user.
  const next = [...desiredSet].slice(0, maximum);

  return {
    added: next.filter((id) => !currentSet.has(id)),
    removed: [...currentSet].filter((id) => !desiredSet.has(id)),
    next,
  };
}
