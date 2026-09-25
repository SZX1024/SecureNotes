import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { firstRunnableIndex, nextMenuIndex } from "./menu-navigation";

/**
 * The menu bar (§22).
 *
 * File operations belong at the top where they are always in the same place, rather than in a sidebar that scrolls
 * away — which is what the previous layout did with export, import and the recovery package.
 *
 * A menu is a menu, not a list of buttons: it opens on click, on `Alt` plus its own letter, and on the arrow keys,
 * it closes on `Escape` or a click outside, and while it is open the arrow keys move between its items and its
 * neighbours. That is a lot of behaviour to get right, so the parts that are pure — which item an arrow lands on —
 * are separated from the parts that are not.
 */

export interface MenuEntry {
  id: string;
  label: string;
  onSelect: () => void;
  shortcut?: string;
  disabled?: boolean;
  /** Draws a tick: used where the menu states a choice rather than performing an action. */
  checked?: boolean;
  /** A rule rather than an item. */
  separator?: boolean;
}

export interface MenuDefinition {
  id: string;
  label: string;
  /** The letter that opens it with `Alt`, matching the label's first letter. */
  accessKey: string;
  items: MenuEntry[];
}

export interface MenuBarProps {
  menus: readonly MenuDefinition[];
  appName: string;
  version: string;
  onOpenCommands: () => void;
}

export function MenuBar({ menus, appName, version, onOpenCommands }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const bar = useRef<HTMLDivElement>(null);

  const active = menus.find((menu) => menu.id === openMenu) ?? null;

  const close = () => {
    setOpenMenu(null);
    setHighlight(0);
  };

  const open = (id: string) => {
    setOpenMenu(id);
    // The first actionable item, so an arrow press or Enter has somewhere to start.
    const menu = menus.find((candidate) => candidate.id === id);
    setHighlight(firstRunnableIndex(menu?.items ?? []));
  };

  const run = (item: MenuEntry) => {
    if (item.disabled || item.separator) {
      return;
    }
    item.onSelect();
    close();
  };

  useEffect(() => {
    if (active === null) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      const items = active.items;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) =>
          nextMenuIndex(current, items.length, event.key === "ArrowDown" ? 1 : -1),
        );
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const position = menus.findIndex((menu) => menu.id === active.id);
        const next =
          menus[nextMenuIndex(position, menus.length, event.key === "ArrowRight" ? 1 : -1)];
        if (next) {
          open(next.id);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = items[highlight];
        if (item) {
          run(item);
        }
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  // `Alt` plus a letter, which is how a menu bar has always been opened from the keyboard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      const menu = menus.find((candidate) => candidate.accessKey === key);
      if (menu) {
        event.preventDefault();
        if (openMenu === menu.id) {
          close();
        } else {
          open(menu.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="menu-bar" ref={bar}>
      <span className="menu-brand" title={`SecureNotes ${version}`}>
        {appName}
      </span>

      {menus.map((menu) => (
        <div key={menu.id} className="menu">
          <button
            type="button"
            className={menu.id === openMenu ? "menu-title open" : "menu-title"}
            aria-haspopup="menu"
            aria-expanded={menu.id === openMenu}
            onClick={() => (menu.id === openMenu ? close() : open(menu.id))}
          >
            {menu.label}
          </button>

          {menu.id === openMenu && (
            <ul className="menu-items" role="menu">
              {menu.items.map((item, index) =>
                item.separator ? (
                  <li key={item.id} className="menu-separator" role="separator" />
                ) : (
                  <li key={item.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={index === highlight ? "menu-item highlighted" : "menu-item"}
                      disabled={item.disabled}
                      onPointerEnter={() => setHighlight(index)}
                      onClick={() => run(item)}
                    >
                      <span className="menu-check">
                        {item.checked ? <Icon name="check" size={14} /> : null}
                      </span>
                      <span className="menu-label">{item.label}</span>
                      {item.shortcut !== undefined && (
                        <span className="menu-shortcut">{item.shortcut}</span>
                      )}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}

      <div className="menu-spacer" />

      <button
        type="button"
        className="menu-command"
        onClick={onOpenCommands}
        title="Command palette"
      >
        <Icon name="command" size={14} />
        <span>Commands</span>
        <span className="menu-shortcut">Ctrl+K</span>
      </button>
    </div>
  );
}
