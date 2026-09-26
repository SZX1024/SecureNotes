import { describe, expect, it, vi } from "vitest";

import { initialUnlockContext, reduceUnlock, describeUnlockState } from "../state/unlock";
import {
  buildCommands,
  filterCommands,
  formatShortcut,
  matchShortcut,
  SHORTCUTS,
} from "./shortcuts";
import { moveInOrder, rememberOpened, sortNotes, type SortableNote } from "./sort";

/**
 * Shell logic that must not depend on rendering (§10, §23, §7).
 *
 * Sorting, shortcut dispatch and the unlock transitions are the parts of the UI
 * that can be wrong without looking wrong, so they are asserted directly rather
 * than left to a click-through.
 */

function note(overrides: Partial<SortableNote> & { id: string }): SortableNote {
  return {
    title: overrides.id,
    updatedAt: 0,
    createdAt: 0,
    pinned: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("note ordering (§10)", () => {
  // The four orderings deliberately disagree, so a mistake in one of them cannot
  // be hidden by the others agreeing. `c` is pinned in every case.
  const notes = [
    note({ id: "a", title: "Alpha", updatedAt: 10, createdAt: 3, sortOrder: 2 }),
    note({ id: "b", title: "Beta", updatedAt: 30, createdAt: 1, sortOrder: 1 }),
    note({ id: "c", title: "Gamma", updatedAt: 20, createdAt: 2, pinned: true, sortOrder: 3 }),
  ];

  it("sorts by each of the four documented keys", () => {
    // Pinned first, then: newest modified, newest created, alphabetical, manual.
    expect(sortNotes(notes, "modified").map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    expect(sortNotes(notes, "created").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(sortNotes(notes, "title").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(sortNotes(notes, "manual").map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("honours each key independently of pinning", () => {
    // With nothing pinned, the keys must still differ from each other.
    const unpinned = notes.map((entry) => ({ ...entry, pinned: false }));
    expect(sortNotes(unpinned, "modified").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(sortNotes(unpinned, "created").map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(sortNotes(unpinned, "title").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(sortNotes(unpinned, "manual").map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps pinned notes first under every ordering", () => {
    for (const key of ["modified", "created", "title", "manual"] as const) {
      expect(sortNotes(notes, key)[0]!.id, key).toBe("c");
    }
  });

  it("breaks ties deterministically", () => {
    const tied = [note({ id: "z" }), note({ id: "y" })];
    expect(sortNotes(tied, "modified").map((entry) => entry.id)).toEqual(["y", "z"]);
  });

  it("does not mutate the input", () => {
    const original = [...notes];
    sortNotes(notes, "title");
    expect(notes).toEqual(original);
  });
});

describe("recently opened and manual order (§10)", () => {
  it("keeps the most recent first, without duplicates, bounded", () => {
    let recent: string[] = [];
    recent = rememberOpened(recent, "a");
    recent = rememberOpened(recent, "b");
    recent = rememberOpened(recent, "a");

    expect(recent).toEqual(["a", "b"]);

    let bounded: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      bounded = rememberOpened(bounded, `note-${index}`, 20);
    }
    expect(bounded).toHaveLength(20);
    expect(bounded[0]).toBe("note-24");
  });

  it("moves a note within the manual order", () => {
    expect(moveInOrder(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    // Out-of-range targets clamp rather than dropping the note.
    expect(moveInOrder(["a", "b"], "a", 99)).toEqual(["b", "a"]);
  });
});

describe("keyboard shortcuts (§23)", () => {
  it("matches a modifier shortcut", () => {
    expect(
      matchShortcut({
        key: "k",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        fromTextField: false,
      }),
    ).toBe("search");
    expect(
      matchShortcut({
        key: "K",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        fromTextField: false,
      }),
    ).toBe("search");
  });

  it("requires the exact modifier set", () => {
    // A shortcut that fires without its modifier is worse than one that never does.
    expect(
      matchShortcut({
        key: "k",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        fromTextField: false,
      }),
    ).toBeNull();
    expect(
      matchShortcut({
        key: "r",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        fromTextField: false,
      }),
    ).toBeNull();
  });

  it("ignores unmodified keys typed into a field, except Escape", () => {
    const inField = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      fromTextField: true,
    };
    expect(matchShortcut({ key: "n", ...inField })).toBeNull();
    expect(matchShortcut({ key: "Escape", ...inField })).toBe("escape");
  });

  it("lets modifiers work inside a field", () => {
    expect(
      matchShortcut({
        key: "s",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        fromTextField: true,
      }),
    ).toBe("save-note");
  });

  it("formats shortcuts for both conventions", () => {
    const save = SHORTCUTS.find((shortcut) => shortcut.id === "save-note")!;
    expect(formatShortcut(save, false)).toBe("Ctrl+S");
    expect(formatShortcut(save, true)).toBe("⌘S");
  });
});

describe("command palette (§10)", () => {
  const actions = {
    newNote: vi.fn(),
    search: vi.fn(),
    toggleSidebar: vi.fn(),
    showRecycleBin: vi.fn(),
    lock: vi.fn(),
    signOut: vi.fn(),
    sortBy: vi.fn(),
    deleteNote: vi.fn(),
  };

  it("filters by label and keywords, and returns everything for an empty query", () => {
    const commands = buildCommands(actions);
    expect(filterCommands(commands, "")).toHaveLength(commands.length);
    expect(filterCommands(commands, "recycle").map((command) => command.id)).toContain(
      "recycle-bin",
    );
    expect(filterCommands(commands, "logout").map((command) => command.id)).toContain("sign-out");
    expect(filterCommands(commands, "zzz")).toHaveLength(0);
  });

  it("runs the selected command", () => {
    const commands = buildCommands(actions);
    filterCommands(commands, "lock")[0]!.run?.();
    expect(actions.lock).toHaveBeenCalled();
  });

  it("offers a command for every sort key", () => {
    const ids = buildCommands(actions).map((command) => command.id);
    for (const key of ["modified", "created", "title", "manual"]) {
      expect(ids).toContain(`sort-${key}`);
    }
  });
});

describe("unlock transitions (§7)", () => {
  it("starts at enrolment when there is no account", () => {
    const context = initialUnlockContext(false, false);
    expect(describeUnlockState(context).screen).toBe("login");
    expect(context.state).toBe("anonymous");
  });

  it("starts locked when a wrapped DEK is on the device", () => {
    const context = initialUnlockContext(true, true);
    expect(context.state).toBe("locked");
    expect(describeUnlockState(context).screen).toBe("unlock");
  });

  it("locks after the App Lock window and keeps offline unlock available", () => {
    const unlocked = reduceUnlock(initialUnlockContext(true, true), {
      type: "credentials-verified",
    });
    expect(describeUnlockState(unlocked).screen).toBe("app");

    const expired = reduceUnlock(unlocked, { type: "app-lock-expired" });
    expect(expired.state).toBe("locked");
    // The account is intact, so the device key can unlock it again.
    expect(expired.hasLocalKeyMaterial).toBe(true);
  });

  it("destroys local key material when the session is revoked (§4)", () => {
    const unlocked = reduceUnlock(initialUnlockContext(true, true), { type: "unlocked" });
    const revoked = reduceUnlock(unlocked, { type: "session-revoked" });

    expect(revoked.state).toBe("anonymous");
    expect(revoked.hasLocalKeyMaterial).toBe(false);
    // And signing out must not leave an offline unlock path behind either.
    expect(reduceUnlock(unlocked, { type: "signed-out" }).hasLocalKeyMaterial).toBe(false);
  });

  it("cannot be unlocked without key material", () => {
    const context = reduceUnlock(
      { state: "anonymous", hasLocalKeyMaterial: false },
      {
        type: "device-key-available",
      },
    );
    expect(context.state).toBe("locked");
    expect(describeUnlockState({ state: "locked", hasLocalKeyMaterial: false }).screen).toBe(
      "login",
    );
  });
});
