import { describe, expect, it } from "vitest";

import {
  MAX_OPEN_TABS,
  OPEN_TABS_STORAGE_KEY,
  addTab,
  isDirty,
  loadTabs,
  neighbourAfterClose,
  parseTabs,
  removeTab,
  saveTabs,
} from "./tabs";

describe("open notes", () => {
  it("adds without duplicating, most recent last", () => {
    expect(addTab(["a", "b"], "a")).toEqual(["b", "a"]);
    expect(addTab([], "a")).toEqual(["a"]);
  });

  it("keeps the list bounded, dropping the oldest", () => {
    const full = Array.from({ length: MAX_OPEN_TABS }, (_, index) => `n${index}`);
    const next = addTab(full, "newest");
    expect(next).toHaveLength(MAX_OPEN_TABS);
    expect(next.at(-1)).toBe("newest");
    expect(next).not.toContain("n0");
  });

  it("moves to the tab that takes the closed one's place", () => {
    // Closing a tab should leave the reader next to where they were, not at the far end of the strip.
    expect(neighbourAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterClose(["a", "b", "c"], "a")).toBe("b");
    expect(neighbourAfterClose(["a"], "a")).toBeNull();
  });

  it("marks a tab dirty when the editor holds something the database does not", () => {
    expect(isDirty({ title: "A", body: "x" }, { title: "A", body: "x" })).toBe(false);
    expect(isDirty({ title: "A", body: "x" }, { title: "A", body: "y" })).toBe(true);
    expect(isDirty({ title: "A", body: "x" }, null)).toBe(true);
    expect(isDirty(null, { title: "A", body: "x" })).toBe(false);
  });

  it("ignores anything in storage this build cannot open", () => {
    const known = (id: string) => ["a", "b"].includes(id);
    expect(parseTabs(null, known)).toEqual([]);
    expect(parseTabs("not json", known)).toEqual([]);
    expect(parseTabs('{"a":1}', known)).toEqual([]);
    // Duplicates, foreign ids and non-strings all go; the order of the rest is kept.
    expect(parseTabs('["a","nope","a",7,"b"]', known)).toEqual(["a", "b"]);
    const many = JSON.stringify(Array.from({ length: 30 }, (_, index) => `x${index}`));
    expect(parseTabs(many, () => true)).toHaveLength(MAX_OPEN_TABS);
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveTabs(storage, ["a", "b"]);
    expect(store.has(OPEN_TABS_STORAGE_KEY)).toBe(true);
    expect(loadTabs(storage, () => true)).toEqual(["a", "b"]);
    expect(removeTab(["a", "b"], "a")).toEqual(["b"]);
  });
});
