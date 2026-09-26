import { describe, expect, it } from "vitest";

import { clampMenuPosition } from "./context-menu";

describe("where a context menu goes", () => {
  it("opens where the pointer is when there is room", () => {
    expect(
      clampMenuPosition(
        { x: 100, y: 100 },
        { width: 200, height: 120 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("moves rather than being clipped at an edge", () => {
    // A menu opened near the bottom right has to come back into the window, or its last item cannot be clicked.
    const bottomRight = clampMenuPosition(
      { x: 980, y: 780 },
      { width: 200, height: 120 },
      { width: 1000, height: 800 },
    );
    expect(bottomRight.x).toBe(796);
    expect(bottomRight.y).toBe(676);
  });

  it("stays in the corner when the menu is larger than the window", () => {
    const huge = clampMenuPosition(
      { x: 10, y: 10 },
      { width: 2000, height: 2000 },
      { width: 800, height: 600 },
    );
    expect(huge.x).toBe(4);
    expect(huge.y).toBe(4);
  });
});
