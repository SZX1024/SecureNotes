/**
 * Application user preferences.
 *
 * Stored locally in localStorage, controlling default behaviors like editor mode,
 * line numbers, attachment retention, and sync delay.
 */

export type DefaultEditorMode = "wysiwyg" | "source";
export type AttachmentRetentionChoice = "keep" | 7 | 30;
export type SyncDelayChoice = 3000 | 5000 | 10000;

export interface AppPreferences {
  defaultEditorMode: DefaultEditorMode;
  showLineNumbers: boolean;
  defaultAttachmentRetention: AttachmentRetentionChoice;
  syncDelayMs: SyncDelayChoice;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  defaultEditorMode: "source",
  showLineNumbers: true,
  defaultAttachmentRetention: "keep",
  syncDelayMs: 5000,
};

export const PREFERENCES_STORAGE_KEY = "securenotes.app-preferences";

export const DEFAULT_EDITOR_MODE_CHOICES: ReadonlyArray<{
  value: DefaultEditorMode;
  label: string;
}> = [
  { value: "wysiwyg", label: "WYSIWYG" },
  { value: "source", label: "Markdown source" },
];

export const ATTACHMENT_RETENTION_CHOICES: ReadonlyArray<{
  value: AttachmentRetentionChoice;
  label: string;
}> = [
  { value: "keep", label: "Forever" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
];

export const SYNC_DELAY_CHOICES: ReadonlyArray<{
  value: SyncDelayChoice;
  label: string;
}> = [
  { value: 3000, label: "3s (Fast)" },
  { value: 5000, label: "5s (Standard)" },
  { value: 10000, label: "10s (Relaxed)" },
];

export interface PreferencesStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function parsePreferences(raw: string | null): AppPreferences {
  if (raw === null) {
    return DEFAULT_APP_PREFERENCES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_APP_PREFERENCES;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_APP_PREFERENCES;
  }

  const candidate = parsed as Partial<Record<keyof AppPreferences, unknown>>;

  const defaultEditorMode: DefaultEditorMode =
    candidate.defaultEditorMode === "source" || candidate.defaultEditorMode === "wysiwyg"
      ? candidate.defaultEditorMode
      : DEFAULT_APP_PREFERENCES.defaultEditorMode;

  const showLineNumbers =
    typeof candidate.showLineNumbers === "boolean"
      ? candidate.showLineNumbers
      : DEFAULT_APP_PREFERENCES.showLineNumbers;

  const defaultAttachmentRetention: AttachmentRetentionChoice =
    candidate.defaultAttachmentRetention === 7 ||
    candidate.defaultAttachmentRetention === 30 ||
    candidate.defaultAttachmentRetention === "keep"
      ? candidate.defaultAttachmentRetention
      : DEFAULT_APP_PREFERENCES.defaultAttachmentRetention;

  const syncDelayMs: SyncDelayChoice =
    candidate.syncDelayMs === 3000 ||
    candidate.syncDelayMs === 10000 ||
    candidate.syncDelayMs === 5000
      ? candidate.syncDelayMs
      : DEFAULT_APP_PREFERENCES.syncDelayMs;

  return {
    defaultEditorMode,
    showLineNumbers,
    defaultAttachmentRetention,
    syncDelayMs,
  };
}

export function loadPreferences(storage: PreferencesStorage): AppPreferences {
  return parsePreferences(storage.getItem(PREFERENCES_STORAGE_KEY));
}

export function savePreferences(storage: PreferencesStorage, prefs: AppPreferences): void {
  storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
}

export function applyPreferences(
  prefs: AppPreferences,
  root: { dataset: Record<string, string | undefined> },
): void {
  root.dataset["lineNumbers"] = String(prefs.showLineNumbers);
}
