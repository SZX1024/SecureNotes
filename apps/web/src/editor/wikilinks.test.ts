import { describe, expect, it } from "vitest";
import { computeBacklinks, extractWikiLinks, transformWikiLinksToHtml } from "./wikilinks";

describe("wikilinks", () => {
  it("extracts wikilinks titles", () => {
    const md = "See [[Architecture]] and [[Security Model]] for details. Also [[Architecture]].";
    expect(extractWikiLinks(md)).toEqual(["Architecture", "Security Model"]);
  });

  it("transforms wikilinks into HTML anchors", () => {
    const html = "<p>Check [[Meeting]] out</p>";
    const res = transformWikiLinksToHtml(html);
    expect(res).toContain('class="wikilink"');
    expect(res).toContain('data-wikilink="Meeting"');
  });

  it("computes backlinks correctly", () => {
    const allNotes = [
      { id: "1", title: "Architecture", body: "Core design" },
      { id: "2", title: "Security", body: "Referencing [[Architecture]] here." },
      { id: "3", title: "Random", body: "No references" },
    ];

    const backlinks = computeBacklinks(allNotes, "1", "Architecture");
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.sourceNoteId).toBe("2");
    expect(backlinks[0]?.sourceNoteTitle).toBe("Security");
  });
});
