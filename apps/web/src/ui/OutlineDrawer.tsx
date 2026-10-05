import { type HeadingItem } from "../editor/outline";
import { Icon } from "./Icon";

export interface OutlineDrawerProps {
  headings: HeadingItem[];
  onSelectHeading: (item: HeadingItem) => void;
  onClose: () => void;
}

export function OutlineDrawer({ headings, onSelectHeading, onClose }: OutlineDrawerProps) {
  return (
    <aside className="outline-drawer" aria-label="Table of contents">
      <header className="outline-header">
        <h3>Outline</h3>
        <button
          type="button"
          className="outline-close-btn"
          aria-label="Close outline"
          onClick={onClose}
        >
          <Icon name="remove" size={14} />
        </button>
      </header>

      {headings.length === 0 ? (
        <p className="outline-empty muted">No headings in this note.</p>
      ) : (
        <ul className="outline-list">
          {headings.map((item) => (
            <li
              key={item.id}
              className={`outline-item level-${item.level}`}
              style={{ paddingLeft: `${(item.level - 1) * 0.75}rem` }}
            >
              <button
                type="button"
                className="outline-link"
                onClick={() => onSelectHeading(item)}
                title={item.text}
              >
                <span className="outline-bullet">H{item.level}</span>
                <span className="outline-text">{item.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
