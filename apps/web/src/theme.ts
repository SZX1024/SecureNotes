/**
 * Theme preference (§ requirements: follow the system by default, with a manual
 * override).
 *
 * Resolution is a pure function so the rule is testable: `system` follows the OS and
 * an explicit choice wins over it, which is what makes the setting survive a system
 * change the user did not ask for.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "securenotes.theme";

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

/** The order the toggle cycles through. */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return preference === "system" ? "light" : preference === "light" ? "dark" : "system";
}

export interface ThemeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function loadThemePreference(storage: ThemeStorage): ThemePreference {
  const stored = storage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function saveThemePreference(storage: ThemeStorage, preference: ThemePreference): void {
  storage.setItem(THEME_STORAGE_KEY, preference);
}
