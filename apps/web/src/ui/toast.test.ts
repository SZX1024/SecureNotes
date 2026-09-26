import { describe, expect, it } from "vitest";

import { TOAST_DURATION_MS, autoDismisses, toastRole } from "./toast";

describe("the message at the bottom of the window", () => {
  it("keeps a failure until it is dismissed", () => {
    // A failure that disappears on its own is the easiest way to miss a problem: it goes while the person is looking
    // at the thing that failed.
    expect(autoDismisses("error")).toBe(false);
    expect(autoDismisses("success")).toBe(true);
    expect(autoDismisses("info")).toBe(true);
  });

  it("interrupts for a failure and not for a confirmation", () => {
    expect(toastRole("error")).toBe("alert");
    expect(toastRole("success")).toBe("status");
    expect(toastRole("info")).toBe("status");
  });

  it("stays long enough to read", () => {
    expect(TOAST_DURATION_MS).toBeGreaterThanOrEqual(2000);
    expect(TOAST_DURATION_MS).toBeLessThanOrEqual(8000);
  });
});
