/**
 * Where a context menu goes.
 *
 * Pure and separate, because the interesting part is the edge: a menu opened near the bottom or the right of the window
 * has to move rather than be clipped, and a menu that runs off the screen is a menu whose last item cannot be clicked.
 */

export interface MenuPosition {
  x: number;
  y: number;
}

export function clampMenuPosition(
  position: MenuPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 4,
): MenuPosition {
  const x = Math.max(margin, Math.min(position.x, viewport.width - size.width - margin));
  const y = Math.max(margin, Math.min(position.y, viewport.height - size.height - margin));
  // When the menu is larger than the viewport, prefer the top-left corner over a negative offset.
  return {
    x: Math.max(margin, x),
    y: Math.max(margin, y),
  };
}
