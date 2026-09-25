import { describe, expect, it } from "vitest";

import {
  buildFolderTree,
  canMoveFolder,
  descendantIds,
  notesInFolder,
  planTagChange,
  type FolderRow,
} from "./organisation";

/**
 * Organisation rules (§9, §10).
 *
 * The tree, the filters and the tag set are the parts a user navigates by, and each has a failure that only
 * shows up as "my notes are gone": a folder dropped from the tree, a filter that excludes a subfolder, a tag
 * added twice.
 */

const folder = (id: string, parentId: string | null, name: string, depth = 1): FolderRow => ({
  id,
  parentId,
  name,
  depth,
  sortOrder: 0,
});

const ROWS: FolderRow[] = [
  folder("work", null, "Work"),
  folder("reports", "work", "Reports", 2),
  folder("q1", "reports", "Q1", 3),
  folder("home", null, "Home"),
];

describe("the folder tree (§9)", () => {
  it("nests children under their parents, sorted by name", () => {
    const tree = buildFolderTree(ROWS);

    expect(tree.map((node) => node.name)).toEqual(["Home", "Work"]);
    expect(tree[1]!.children.map((node) => node.name)).toEqual(["Reports"]);
    expect(tree[1]!.children[0]!.children.map((node) => node.name)).toEqual(["Q1"]);
  });

  it("keeps a folder whose parent is missing rather than dropping it", () => {
    // Showing it as a root is the difference between "misplaced" and "my notes disappeared".
    const tree = buildFolderTree([...ROWS, folder("orphan", "gone", "Orphan")]);

    expect(tree.map((node) => node.id)).toContain("orphan");
  });

  it("does not recurse forever on a cycle", () => {
    const cyclic = [folder("a", "b", "A"), folder("b", "a", "B")];

    const tree = buildFolderTree(cyclic);

    // Neither is a child of the other, so both surface as roots instead of vanishing.
    expect(tree).toHaveLength(2);
  });

  it("lists descendants, and only them", () => {
    expect(descendantIds(ROWS, "work")).toEqual(["reports", "q1"]);
    expect(descendantIds(ROWS, "q1")).toEqual([]);
    expect(descendantIds(ROWS, "home")).toEqual([]);
  });
});

describe("moving a folder (§16)", () => {
  it("refuses to move a folder into itself or its own subtree", () => {
    expect(canMoveFolder(ROWS, "work", "work")).toBe(false);
    expect(canMoveFolder(ROWS, "work", "reports")).toBe(false);
    expect(canMoveFolder(ROWS, "work", "q1")).toBe(false);
  });

  it("allows a move to another branch or to the root", () => {
    expect(canMoveFolder(ROWS, "reports", "home")).toBe(true);
    expect(canMoveFolder(ROWS, "reports", null)).toBe(true);
  });
});

describe("folder filters (§10)", () => {
  const notes = [
    { id: "n1", folderId: null },
    { id: "n2", folderId: "work" },
    { id: "n3", folderId: "reports" },
    { id: "n4", folderId: "home" },
  ];

  it("shows everything when no folder is selected", () => {
    expect(notesInFolder(notes, null)).toHaveLength(4);
  });

  it("includes subfolders, which is what a user expects from a tree", () => {
    expect(notesInFolder(notes, "work", ROWS).map((note) => note.id)).toEqual(["n2", "n3"]);
  });

  it("can be limited to the folder itself", () => {
    expect(notesInFolder(notes, "work", ROWS, false).map((note) => note.id)).toEqual(["n2"]);
  });
});

describe("tag sets (§16)", () => {
  it("reports what changed", () => {
    expect(planTagChange(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
      next: ["b", "c"],
    });
  });

  it("treats the same tag twice as one", () => {
    // Set semantics: a duplicate must not become two links.
    expect(planTagChange(["a"], ["a", "a", "b", "b"]).next).toEqual(["a", "b"]);
  });

  it("caps the set without dropping what was already there", () => {
    const desired = Array.from({ length: 14 }, (_, index) => `tag-${index}`);

    const change = planTagChange([], desired, 10);

    expect(change.next).toHaveLength(10);
    expect(change.added).toHaveLength(10);
  });

  it("reports no change when the set is the same", () => {
    expect(planTagChange(["a", "b"], ["b", "a"])).toEqual({
      added: [],
      removed: [],
      next: ["b", "a"],
    });
  });
});
