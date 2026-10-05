import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, loadCustomTemplates, saveCustomTemplate } from "./templates";

describe("templates", () => {
  it("provides built-in templates with content", () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.content).toBeTruthy();
    }
  });

  it("saves and loads custom templates", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };

    expect(loadCustomTemplates(storage)).toEqual([]);

    const custom = {
      id: "custom-1",
      name: "My Template",
      description: "A custom template",
      defaultTitle: "My Note",
      content: "# Custom Content",
    };

    saveCustomTemplate(storage, custom);
    expect(loadCustomTemplates(storage)).toEqual([custom]);
  });
});
