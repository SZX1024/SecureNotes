import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App shell", () => {
  it("shows the build version from the root package.json", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: {} })),
    );
    render(<App />);
    expect(screen.getByTestId("app-version")).toHaveTextContent(/^v\d+\.\d+\.\d+/);
  });

  it("reports a reachable backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          data: { status: "ok", version: "1.2.3", environment: "development" },
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    expect(screen.getByText(/worker v1\.2\.3/)).toBeInTheDocument();
  });

  it("renders only the generic message when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            error: { code: "RATE_LIMITED", message: "internal detail: table rate_limits" },
          },
          429,
        ),
      ),
    );

    render(<App />);

    const error = await screen.findByText(/Too many requests/);
    expect(error).toBeInTheDocument();
    expect(error.textContent).not.toContain("rate_limits");
  });
});
