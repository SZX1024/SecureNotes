import { Icon } from "./Icon";
import { ACTIVITY_ITEMS, type PanelView } from "./panels";

export { ACTIVITY_ITEMS };

/**
 * The activity bar (§22).
 *
 * The narrow rail that decides what the side panel is showing, so the panel itself can stay about one subject
 * instead of being a list of everything the application can do. Clicking the view that is already showing collapses
 * the panel, which is the gesture people already have in their fingers from editors.
 *
 * The gear is pinned to the bottom and is not a view: settings are a dialog, and pretending otherwise would leave
 * the panel showing something that is not part of the note you are working on.
 */

export interface ActivityBarProps {
  /** Null when the panel is collapsed. */
  active: PanelView | null;
  onSelect: (view: PanelView) => void;
  onOpenSettings: () => void;
  syncState: "ok" | "attention";
}

export function ActivityBar({ active, onSelect, onOpenSettings, syncState }: ActivityBarProps) {
  return (
    <nav className="rail" aria-label="Views">
      {ACTIVITY_ITEMS.map((item) => (
        <button
          key={item.view}
          type="button"
          className={item.view === active ? "selected" : undefined}
          aria-label={item.label}
          aria-pressed={item.view === active}
          title={item.label}
          onClick={() => onSelect(item.view)}
        >
          <Icon name={item.icon} size={20} />
          {/* The dot is the only thing the rail says about state: offline, a conflict, or work waiting. */}
          {item.view === "sync" && syncState === "attention" && (
            <span className="rail-dot" aria-hidden="true" />
          )}
        </button>
      ))}
      <div className="rail-spacer" />
      <button type="button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
        <Icon name="settings" size={20} />
      </button>
    </nav>
  );
}
