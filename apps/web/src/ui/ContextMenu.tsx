import { useEffect, useRef, useState } from "react";

import { clampMenuPosition, type MenuPosition } from "./context-menu";

/**
 * The menu that opens on a right-click.
 *
 * Positions itself where the pointer is and moves back inside the window when that would put it over an edge, closes on
 * `Escape` or a click anywhere else, and takes focus so the keyboard can reach it. One menu at a time: it is owned by
 * the thing that opened it, and opening another replaces it.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Something that cannot be taken back, or nearly cannot. */
  danger?: boolean;
}

export interface ContextMenuState extends MenuPosition {
  items: ContextMenuItem[];
}

export interface ContextMenuProps {
  menu: ContextMenuState;
  onClose: () => void;
}

export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition>({ x: menu.x, y: menu.y });

  // Measured after it is in the document, because the size is what decides where it fits.
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPosition(
      clampMenuPosition(
        { x: menu.x, y: menu.y },
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    ref.current?.focus();
  }, [menu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
    >
      {menu.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={item.danger ? "menu-item danger" : "menu-item"}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
