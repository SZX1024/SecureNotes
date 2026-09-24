import { describe, expect, it } from "vitest";

import {
  THEME_STORAGE_KEY,
  loadThemePreference,
  nextThemePreference,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from "./theme";

/**
 * Theming.
 *
 * The rule that needs protecting is that an explicit choice beats the system: a user
 * who picked light does not expect their laptop's sunset schedule to override it.
 */

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("theme resolution", () => {
  it("follows the system when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit choice win over the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("cycles through the three preferences", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });
});

describe("theme persistence", () => {
  it("round-trips a preference", () => {
    const storage = memoryStorage();
    saveThemePreference(storage, "dark");

    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(loadThemePreference(storage)).toBe("dark");
  });

  it("falls back to the system for a missing or corrupt value", () => {
    expect(loadThemePreference(memoryStorage())).toBe("system");
    expect(loadThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "neon" }))).toBe("system");
  });

  it("accepts every valid preference", () => {
    for (const preference of ["system", "light", "dark"] as ThemePreference[]) {
      const storage = memoryStorage();
      saveThemePreference(storage, preference);
      expect(loadThemePreference(storage)).toBe(preference);
    }
  });
});
