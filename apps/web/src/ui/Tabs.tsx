import { Icon } from "./Icon";

/**
 * The open notes (§22).
 *
 * A strip of the notes that are open, above the one being edited. It exists because the alternative — one note at a
 * time — makes moving between two of them a round trip through the list, and because a note that is open should stay
 * open while you look at another one.
 *
 * A tab whose editor holds unsaved changes says so, and closing one is never a way to lose work: the caller saves
 * before it switches or closes.
 */

export interface TabView {
  id: string;
  title: string;
  /** The editor holds something the database does not. */
  dirty: boolean;
}

export interface TabsProps {
  tabs: readonly TabView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function Tabs({ tabs, activeId, onSelect, onClose, onNew }: TabsProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="tab-strip" role="tablist" aria-label="Open notes">
      {tabs.map((tab) => {
        const label = tab.title.trim().length > 0 ? tab.title : "Untitled";
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className={active ? "tab active" : "tab"}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab-select"
              title={label}
              onClick={() => onSelect(tab.id)}
            >
              {/* Stated in the strip rather than only in the editor, because the point of it is that a *different*
                  note can be the one holding unsaved work. */}
              {tab.dirty && <span className="tab-dirty" aria-label="Unsaved changes" role="img" />}
              <span className="tab-title">{label}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${label}`}
              title={`Close ${label}`}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="remove" size={12} />
            </button>
          </div>
        );
      })}

      {/* Not "New note": the side panel already has a control by that name, and two controls with one accessible
          name is how a click lands somewhere unexpected. */}
      <button
        type="button"
        className="tab-new"
        aria-label="Open a new note"
        title="Open a new note"
        onClick={onNew}
      >
        <Icon name="add" size={14} />
      </button>
    </div>
  );
}
