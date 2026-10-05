import { describe, expect, it } from "vitest";
import { countNoteStats } from "./word-count";

describe("countNoteStats", () => {
  it("handles empty or whitespace strings", () => {
    expect(countNoteStats("")).toEqual({
      characters: 0,
      words: 0,
      readingMinutes: 0,
      label: "0 words",
    });
    expect(countNoteStats("   \n\t  ")).toEqual({
      characters: 0,
      words: 0,
      readingMinutes: 0,
      label: "0 words",
    });
  });

  it("counts english words accurately", () => {
    const stats = countNoteStats("Hello world from SecureNotes!");
    expect(stats.words).toBe(4);
    expect(stats.characters).toBe(26);
    expect(stats.readingMinutes).toBe(1);
    expect(stats.label).toBe("4 words · ~1 min read");
  });

  it("counts cjk characters accurately", () => {
    const stats = countNoteStats("安全笔记 客户端加密 离线运行");
    expect(stats.words).toBe(13);
    expect(stats.characters).toBe(13);
    expect(stats.readingMinutes).toBe(1);
    expect(stats.label).toBe("13 words · ~1 min read");
  });

  it("counts mixed multilingual text", () => {
    const stats = countNoteStats("Hello 世界, this is a test 测试.");
    // "Hello", "this", "is", "a", "test" = 5 latin words
    // "世", "界", "测", "试" = 4 cjk chars
    expect(stats.words).toBe(9);
  });
});
