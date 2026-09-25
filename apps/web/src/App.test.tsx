import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

/**
 * Shell boot behaviour (§21, §22).
 *
 * The shell has to decide which screen to show before it can render anything
 * useful, so these tests drive that decision: a server with no account must lead
 * to enrolment, not to a login form that cannot succeed.
 */

function stubApi(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(async () => {
  // The shell starts work of its own — a status probe, a sync pass — that settles after the test body returns. Let
  // it finish while the DOM is still here: torn down first, React's scheduler runs in a Node context where
  // `window` does not exist, which vitest reports as an unhandled error and which made this suite intermittently
  // red for reasons that had nothing to do with what it asserts.
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  cleanup();
  vi.unstubAllGlobals();
});

describe("application shell", () => {
  it("offers first-run enrolment when no account exists", async () => {
    stubApi({ ok: true, data: { initialized: false } });

    render(<App />);

    expect(await screen.findByRole("heading", { name: /first run/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
  });

  it("asks for a code when the account exists but this device has no key", async () => {
    stubApi({ ok: true, data: { initialized: true } });

    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/authenticator code/i)).toBeInTheDocument();
    // The shell must not claim to be unlocked before a key exists.
    expect(screen.queryByRole("button", { name: /new note/i })).not.toBeInTheDocument();
  });

  it("assumes the account exists when the status probe fails", async () => {
    // A flaky network must not steer the user into creating a second account.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  });
});
