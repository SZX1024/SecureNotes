import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  applyPreferences,
  loadPreferences,
  parsePreferences,
  savePreferences,
  type AppPreferences,
} from "./preferences";

describe("the app preferences", () => {
  it("falls back to defaults for invalid inputs", () => {
    for (const raw of [null, "", "invalid json", "[]", "123", "null"]) {
      expect(parsePreferences(raw)).toEqual(DEFAULT_APP_PREFERENCES);
    }
  });

  it("keeps valid preferences and falls back for unknown values", () => {
    const valid = parsePreferences(
      JSON.stringify({
        defaultEditorMode: "source",
        showLineNumbers: false,
        defaultAttachmentRetention: 7,
        syncDelayMs: 3000,
      }),
    );
    expect(valid).toEqual({
      defaultEditorMode: "source",
      showLineNumbers: false,
      defaultAttachmentRetention: 7,
      syncDelayMs: 3000,
    });

    const invalid = parsePreferences(
      JSON.stringify({
        defaultEditorMode: "invalid-mode",
        showLineNumbers: "not a boolean",
        defaultAttachmentRetention: 999,
        syncDelayMs: 99999,
      }),
    );
    expect(invalid).toEqual(DEFAULT_APP_PREFERENCES);
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    const prefs: AppPreferences = {
      defaultEditorMode: "source",
      showLineNumbers: false,
      defaultAttachmentRetention: 30,
      syncDelayMs: 10000,
    };

    savePreferences(storage, prefs);
    expect(store.has(PREFERENCES_STORAGE_KEY)).toBe(true);
    expect(loadPreferences(storage)).toEqual(prefs);
  });

  it("applies line numbers dataset to root element", () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    applyPreferences({ ...DEFAULT_APP_PREFERENCES, showLineNumbers: false }, root);
    expect(root.dataset["lineNumbers"]).toBe("false");

    applyPreferences({ ...DEFAULT_APP_PREFERENCES, showLineNumbers: true }, root);
    expect(root.dataset["lineNumbers"]).toBe("true");
  });
});
