import { describe, expect, it } from "vitest";

import {
  DEFAULT_TYPOGRAPHY,
  TYPOGRAPHY_STORAGE_KEY,
  applyTypography,
  loadTypography,
  parseTypography,
  saveTypography,
  typographyStyle,
} from "./typography";

describe("the typography preference", () => {
  it("falls back to the defaults for anything it cannot read", () => {
    for (const raw of [null, "", "not json", "[]", "null", '"big"']) {
      expect(parseTypography(raw)).toEqual(DEFAULT_TYPOGRAPHY);
    }
  });

  it("clamps a stored size into the range this build can render", () => {
    // The value comes from a browser profile, not from this build: a profile written by another version, or edited
    // by hand, must not be able to produce an interface nobody can read.
    const tiny = parseTypography('{"interfaceSize":1,"noteSize":2,"lineHeight":0.1}');
    expect(tiny.interfaceSize).toBe(12);
    expect(tiny.noteSize).toBe(13);
    expect(tiny.lineHeight).toBe(1.4);

    const huge = parseTypography('{"interfaceSize":400,"noteSize":900,"lineHeight":40}');
    expect(huge.interfaceSize).toBe(16);
    expect(huge.noteSize).toBe(20);
    expect(huge.lineHeight).toBe(2);
  });

  it("keeps a valid choice and ignores an unknown one", () => {
    const chosen = parseTypography(
      '{"interfaceSize":15,"noteSize":18,"lineHeight":1.85,"editorWidth":"comfortable","editorPadding":"spacious","fontFamily":"serif"}',
    );
    expect(chosen).toEqual({
      interfaceSize: 15,
      noteSize: 18,
      lineHeight: 1.85,
      editorWidth: "comfortable",
      editorPadding: "spacious",
      fontFamily: "serif",
    });
    expect(parseTypography('{"editorWidth":"enormous"}').editorWidth).toBe("full");
    expect(parseTypography('{"editorPadding":"enormous"}').editorPadding).toBe("standard");
    expect(parseTypography('{"fontFamily":"comic-sans"}').fontFamily).toBe("sans");
  });

  it("derives the smaller interface sizes from the chosen one", () => {
    // A heading that does not move with the body text is how a "larger font" setting looks broken.
    const style = typographyStyle({
      ...DEFAULT_TYPOGRAPHY,
      interfaceSize: 15,
      noteSize: 18,
      lineHeight: 1.55,
      editorPadding: "spacious",
      fontFamily: "serif",
    });
    expect(style["--text-ui"]).toBe("15px");
    expect(style["--text-sm"]).toBe("14px");
    expect(style["--text-xs"]).toBe("13px");
    expect(style["--font-note-size"]).toBe("18px");
    expect(style["--line-prose"]).toBe("1.55");
    expect(style["--note-padding"]).toBe("2.5rem");
    expect(style["--font-note-family"]).toContain("Charter");
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    const typography = {
      interfaceSize: 14,
      noteSize: 20,
      lineHeight: 1.4,
      editorWidth: "comfortable" as const,
      editorPadding: "spacious" as const,
      fontFamily: "mono" as const,
    };
    saveTypography(storage, typography);
    expect(store.has(TYPOGRAPHY_STORAGE_KEY)).toBe(true);
    expect(loadTypography(storage)).toEqual(typography);
  });

  it("puts the preference where the stylesheet reads it", () => {
    const properties = new Map<string, string>();
    const dataset: Record<string, string | undefined> = {};
    applyTypography(
      {
        ...DEFAULT_TYPOGRAPHY,
        interfaceSize: 16,
        editorWidth: "comfortable",
        editorPadding: "spacious",
      },
      { style: { setProperty: (name, value) => void properties.set(name, value) }, dataset },
    );

    expect(properties.get("--text-ui")).toBe("16px");
    expect(properties.get("--note-padding")).toBe("2.5rem");
    expect(dataset["editorWidth"]).toBe("comfortable");
    expect(dataset["editorPadding"]).toBe("spacious");
  });
});
