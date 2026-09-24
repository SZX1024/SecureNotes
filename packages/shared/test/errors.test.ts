import { describe, expect, it } from "vitest";

import { ERROR_CODES, PUBLIC_MESSAGES, isErrorCode, publicMessageFor } from "../src/errors";

describe("error contract", () => {
  it("defines a message for every code", () => {
    for (const code of ERROR_CODES) {
      expect(typeof PUBLIC_MESSAGES[code]).toBe("string");
      expect(PUBLIC_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("keeps public messages free of request-derived detail", () => {
    for (const code of ERROR_CODES) {
      const message = publicMessageFor(code);
      // No placeholders / interpolated fields, no technical leak keywords.
      expect(message).not.toMatch(/[{}%]/);
      expect(message.toLowerCase()).not.toMatch(/sql|stack|trace|d1|r2|token|secret|key=/);
    }
  });

  it("narrows unknown values", () => {
    expect(isErrorCode("NOT_FOUND")).toBe(true);
    expect(isErrorCode("not_found")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode({ code: "NOT_FOUND" })).toBe(false);
  });

  it("is frozen so a handler cannot mutate the public surface", () => {
    expect(Object.isFrozen(PUBLIC_MESSAGES)).toBe(true);
  });
});
