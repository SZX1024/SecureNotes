import { useEffect } from "react";

import { SORT_KEYS, SORT_LABELS, type SortKey } from "./sort";
import { Icon } from "./Icon";
import type { ThemePreference } from "../theme";

/**
 * Settings (§22).
 *
 * Everything that is about the application rather than about the note being written, in one place that is opened
 * deliberately and closed again: appearance, how notes are ordered, and what the thing is. The sidebar keeps the
 * work.
 *
 * Each setting has exactly one control. The previous interface offered the theme twice — a three-way selector and a
 * button that cycled the same setting — which is the kind of duplication that makes a person wonder whether the two
 * are different.
 */

export interface SettingsDialogProps {
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  sortKey: SortKey;
  onSortKey: (key: SortKey) => void;
  version: string;
  onClose: () => void;
}

const THEME_CHOICES: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: "appearance" | "light" | "dark";
}> = [
  { value: "system", label: "System", icon: "appearance" },
  { value: "light", label: "Light", icon: "light" },
  { value: "dark", label: "Dark", icon: "dark" },
];

export function SettingsDialog({
  theme,
  onTheme,
  sortKey,
  onSortKey,
  version,
  onClose,
}: SettingsDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="overlay" onPointerDown={onClose}>
      <section
        className="dialog settings"
        role="dialog"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            <Icon name="remove" />
          </button>
        </header>

        <div className="settings-body">
          <section>
            <h3>Appearance</h3>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {THEME_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === choice.value}
                  className={theme === choice.value ? "selected" : undefined}
                  onClick={() => onTheme(choice.value)}
                >
                  <Icon name={choice.icon} size={14} />
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="muted">
              Following the system changes with it; an explicit choice does not.
            </p>
          </section>

          <section>
            <h3>Notes</h3>
            <label className="field">
              <span>Order</span>
              <select
                value={sortKey}
                onChange={(event) => onSortKey(event.target.value as SortKey)}
              >
                {SORT_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section>
            <h3>About</h3>
            <p className="muted">
              SecureNotes {version} — a personal, local-first notebook. Notes, folder and tag names,
              attachments and their filenames are encrypted in this browser before they are stored
              or sent; the server holds ciphertext it cannot read. The only copy of the key is on
              your devices, so a backup matters: File → Export everything, and File → Recovery
              package for the account itself.
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}
