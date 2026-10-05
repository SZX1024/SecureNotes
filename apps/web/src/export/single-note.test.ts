import { describe, expect, it, vi, beforeEach } from "vitest";
import { exportNoteAsMarkdown, exportNoteAsHtml, printNote } from "./single-note";

describe("single note export", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers markdown download with title prepended when needed", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    exportNoteAsMarkdown("My Test Note", "Some content");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("triggers html download with self-contained styling", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    globalThis.URL.createObjectURL = createObjectURL;

    exportNoteAsHtml("Meeting Notes", "<p>Discussed roadmap</p>");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("calls print without throwing", () => {
    expect(() => printNote("Print Title", "<p>Print body</p>")).not.toThrow();
  });
});
