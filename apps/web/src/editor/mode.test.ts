import { describe, expect, it } from "vitest";

import { EDITOR_MODE_STORAGE_KEY, defaultEditorMode, loadEditorMode, saveEditorMode } from "./mode";

/**
 * Editor mode selection and persistence (§12).
 *
 * The device rule decides what a first-time visitor gets; a remembered choice decides
 * what they get afterwards, and it has to win — a user who switched to source on their
 * phone does not expect the viewport to switch them back.
 */

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("device default", () => {
  it("starts a phone in WYSIWYG", () => {
    expect(defaultEditorMode(390, true)).toBe("wysiwyg");
    expect(defaultEditorMode(390, false)).toBe("wysiwyg");
  });

  it("starts a desktop in source", () => {
    expect(defaultEditorMode(1440, false)).toBe("source");
  });

  it("treats a coarse pointer as mobile even on a wide screen", () => {
    // A tablet in landscape: touch input is the signal that matters there.
    expect(defaultEditorMode(1100, true)).toBe("wysiwyg");
  });
});

describe("remembered choice", () => {
  it("wins over the device default in both directions", () => {
    expect(defaultEditorMode(390, true, "source")).toBe("source");
    expect(defaultEditorMode(1440, false, "wysiwyg")).toBe("wysiwyg");
  });

  it("round-trips", () => {
    const storage = memoryStorage();
    saveEditorMode(storage, "source");

    expect(storage.values.get(EDITOR_MODE_STORAGE_KEY)).toBe("source");
    expect(loadEditorMode(storage)).toBe("source");
  });

  it("ignores a missing or corrupt value", () => {
    expect(loadEditorMode(memoryStorage())).toBeNull();
    expect(loadEditorMode(memoryStorage({ [EDITOR_MODE_STORAGE_KEY]: "bogus" }))).toBeNull();
  });
});
