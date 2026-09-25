import { Icon } from "./Icon";

/**
 * The status bar (§22).
 *
 * What the application is doing, always in the same place: sync, anything that needs a decision, how many notes
 * there are, and the version. It is the answer to "is my work safe?", which in a local-first application is the
 * question a user actually has — so it never hides behind a menu.
 *
 * The sync item is a control rather than a label: it opens the sync panel, because the state being visible is only
 * useful if the remedy is one click away.
 */

export interface StatusBarProps {
  /** Set when a backup is overdue; the reminder belongs where it cannot be scrolled away. */
  exportReminder: string | null;
  /** The words the interface uses for the current sync state. */
  syncLabel: string;
  syncTone: "ok" | "busy" | "attention";
  conflictCount: number;
  noteCount: number;
  version: string;
  onOpenSync: () => void;
  onOpenConflicts: () => void;
}

export function StatusBar({
  exportReminder,
  syncLabel,
  syncTone,
  conflictCount,
  noteCount,
  version,
  onOpenSync,
  onOpenConflicts,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <button
        type="button"
        className={`status-item status-${syncTone}`}
        data-testid="sync-state"
        title="Sync"
        onClick={onOpenSync}
      >
        <Icon
          name={syncTone === "busy" ? "busy" : syncTone === "attention" ? "warning" : "online"}
          size={14}
        />
        {syncLabel}
      </button>

      {conflictCount > 0 && (
        <button type="button" className="status-item status-attention" onClick={onOpenConflicts}>
          <Icon name="conflict" size={14} />
          {conflictCount} conflict{conflictCount === 1 ? "" : "s"} to resolve
        </button>
      )}

      {exportReminder !== null && (
        <button
          type="button"
          className="status-item status-attention"
          data-testid="export-reminder"
          title="Backups are in the File menu"
          onClick={onOpenSync}
        >
          <Icon name="warning" size={14} />
          {exportReminder}
        </button>
      )}

      <div className="status-spacer" />

      <span className="status-item muted" title="Notes on this device">
        {noteCount} note{noteCount === 1 ? "" : "s"}
      </span>
      {/* Stated rather than implied: it is the property the whole application exists for. */}
      <span
        className="status-item muted"
        title="Everything is encrypted before it leaves this device"
      >
        <Icon name="security" size={14} />
        Encrypted
      </span>
      <span className="status-item muted">v{version}</span>
    </footer>
  );
}
