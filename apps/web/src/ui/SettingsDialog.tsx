import { useEffect } from "react";

import { SORT_KEYS, SORT_LABELS, type SortKey } from "./sort";
import {
  EDITOR_WIDTHS,
  INTERFACE_SIZES,
  LINE_HEIGHTS,
  NOTE_SIZES,
  type Typography,
} from "./typography";
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
  typography: Typography;
  onTypography: (typography: Typography) => void;
  /** What the account stores, or null while it is still being read. */
  usage: { usedBytes: number; limitBytes: number } | null;
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
  typography,
  onTypography,
  usage,
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
            <h3>Typography</h3>
            <div className="settings-grid">
              <label className="field">
                <span>Interface size</span>
                <select
                  aria-label="Interface size"
                  value={typography.interfaceSize}
                  onChange={(event) =>
                    onTypography({ ...typography, interfaceSize: Number(event.target.value) })
                  }
                >
                  {INTERFACE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} px
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Note text size</span>
                <select
                  aria-label="Note text size"
                  value={typography.noteSize}
                  onChange={(event) =>
                    onTypography({ ...typography, noteSize: Number(event.target.value) })
                  }
                >
                  {NOTE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} px
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Line spacing</span>
                <select
                  aria-label="Line spacing"
                  value={typography.lineHeight}
                  onChange={(event) =>
                    onTypography({ ...typography, lineHeight: Number(event.target.value) })
                  }
                >
                  {LINE_HEIGHTS.map((height) => (
                    <option key={height} value={height}>
                      {height.toFixed(2)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="segmented" role="radiogroup" aria-label="Line width">
              {EDITOR_WIDTHS.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={typography.editorWidth === choice.value}
                  className={typography.editorWidth === choice.value ? "selected" : undefined}
                  onClick={() => onTypography({ ...typography, editorWidth: choice.value })}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="muted">Sizes apply immediately and are remembered on this device.</p>
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
            <p className="muted" data-testid="storage-usage">
              {usage === null
                ? "Reading stored attachments…"
                : `Storage: ${formatSize(usage.usedBytes)} of ${formatSize(usage.limitBytes)} used by encrypted attachments.`}
            </p>
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

/** Bytes, in the units a person reads. Kept here because it is only ever used to describe storage. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
