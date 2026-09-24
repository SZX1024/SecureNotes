import { PUBLIC_MESSAGES } from "@securenotes/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiRequest, fetchHealth } from "./client";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("targets the versioned prefix on the same origin with credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { status: "ok" } }));

    await apiRequest("/health");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/health");
    expect(init.credentials).toBe("same-origin");
    // No CORS: the client must never ask for a cross-origin mode.
    expect(init.mode).toBeUndefined();
  });

  it("returns the unwrapped payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, data: { status: "ok", version: "1.0.0", environment: "test" } }),
    );

    await expect(fetchHealth()).resolves.toEqual({
      status: "ok",
      version: "1.0.0",
      environment: "test",
    });
  });

  it("maps a failure body onto the local message table, not server text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, error: { code: "FORBIDDEN", message: "secret server detail" } },
        403,
      ),
    );

    const error = await apiRequest("/notes").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("FORBIDDEN");
    expect(apiError.status).toBe(403);
    expect(apiError.message).toBe(PUBLIC_MESSAGES.FORBIDDEN);
    expect(apiError.message).not.toContain("secret server detail");
  });

  it("falls back to a status-derived code for non-JSON bodies", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      }),
    );

    const error = (await apiRequest("/health").catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toBe(PUBLIC_MESSAGES.RATE_LIMITED);
  });

  it("falls back to the status-derived code when the server sends an unknown code", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: { code: "TOTALLY_NEW" } }, 400));

    const error = (await apiRequest("/health").catch((caught: unknown) => caught)) as ApiError;

    // A code this client does not know is never surfaced as-is; the HTTP status
    // decides, and the message still comes from the local table.
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe(PUBLIC_MESSAGES.BAD_REQUEST);
  });

  it("reports network failures without leaking the underlying error", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8787"));

    const error = (await apiRequest("/health").catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(PUBLIC_MESSAGES.INTERNAL);
    expect(error.diagnostic).toBe("network request failed");
  });

  it("attaches the CSRF token only to state-changing requests", async () => {
    document.cookie = "csrf=token-abc; path=/";
    // A fresh Response per call: a body can only be consumed once.
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, data: {} }));

    await apiRequest("/notes", { method: "POST", body: { hello: "world" } });
    const [, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const postHeaders = postInit.headers as Headers;
    expect(postHeaders.get("x-csrf-token")).toBe("token-abc");
    expect(postHeaders.get("content-type")).toBe("application/json");
    expect(postInit.body).toBe(JSON.stringify({ hello: "world" }));

    fetchMock.mockClear();
    await apiRequest("/notes");
    const [, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((getInit.headers as Headers).get("x-csrf-token")).toBeNull();
  });
});
