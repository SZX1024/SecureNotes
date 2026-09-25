import { describe, expect, it } from "vitest";

import {
  BASE_MARKER,
  LOCAL_MARKER,
  REMOTE_MARKER,
  SEPARATOR_MARKER,
  diffHunks,
  threeWayMerge,
} from "./merge";

/**
 * Three-way merge (§16).
 *
 * The property that matters most is negative: when both sides changed the same lines the merge must
 * **not** choose. A merge that silently prefers one side is the same failure as last-write-wins, only
 * harder to notice, so those cases are asserted to produce visible markers instead.
 */

describe("changed regions", () => {
  it("finds a single changed line", () => {
    const hunks = diffHunks(["a", "b", "c"], ["a", "B", "c"]);

    expect(hunks).toEqual([{ baseStart: 1, baseLength: 1, lines: ["B"] }]);
  });

  it("finds an insertion and a deletion", () => {
    expect(diffHunks(["a", "c"], ["a", "b", "c"])).toEqual([
      { baseStart: 1, baseLength: 0, lines: ["b"] },
    ]);
    expect(diffHunks(["a", "b", "c"], ["a", "c"])).toEqual([
      { baseStart: 1, baseLength: 1, lines: [] },
    ]);
  });

  it("reports nothing for identical text", () => {
    expect(diffHunks(["a", "b"], ["a", "b"])).toEqual([]);
  });
});

describe("merging (§16)", () => {
  const base = "# Title\n\none\ntwo\nthree\n";

  it("keeps both sides when they touched different lines", () => {
    const local = "# Title local\n\none\ntwo\nthree\n";
    const remote = "# Title\n\none\ntwo\nthree remote\n";

    const result = threeWayMerge(base, local, remote);

    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    // Both edits survive: nothing was chosen over the other.
    expect(result.text).toContain("# Title local");
    expect(result.text).toContain("three remote");
  });

  it("takes the changed side when the other did not change", () => {
    const remote = "# Title\n\none\ntwo\nthree remote\n";

    expect(threeWayMerge(base, base, remote).text).toBe(remote);
    expect(threeWayMerge(base, remote, base).text).toBe(remote);
  });

  it("marks a region both sides changed, and keeps all three versions visible", () => {
    const local = "# Title\n\none local\ntwo\nthree\n";
    const remote = "# Title\n\none remote\ntwo\nthree\n";

    const result = threeWayMerge(base, local, remote);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.text).toContain(LOCAL_MARKER);
    expect(result.text).toContain(BASE_MARKER);
    expect(result.text).toContain(SEPARATOR_MARKER);
    expect(result.text).toContain(REMOTE_MARKER);
    // Every side is present, including the ancestor, so the reader can judge the change.
    expect(result.text).toContain("one local");
    expect(result.text).toContain("one remote");
    expect(result.text).toContain("one");
  });

  it("does not choose when both sides inserted at the same point", () => {
    const local = "a\nlocal\nb\n";
    const remote = "a\nremote\nb\n";

    const result = threeWayMerge("a\nb\n", local, remote);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
  });

  it("merges several separate regions without marking any of them", () => {
    const local = "# L\n\none\ntwo\nthree\nfour\n";
    const remote = "# Title\n\none\ntwo\nthree\nfour R\n";

    const result = threeWayMerge("# Title\n\none\ntwo\nthree\nfour\n", local, remote);

    expect(result.clean).toBe(true);
    expect(result.text).toContain("# L");
    expect(result.text).toContain("four R");
  });

  it("reports one conflict for a region both sides edited across several lines", () => {
    const local = "a\nfirst local\nsecond local\nd\n";
    const remote = "a\nfirst remote\nsecond remote\nd\n";

    const result = threeWayMerge("a\nb\nc\nd\n", local, remote);

    // One region to decide, not two.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.base).toEqual(["b", "c"]);
    expect(result.conflicts[0]!.local).toEqual(["first local", "second local"]);
    expect(result.conflicts[0]!.remote).toEqual(["first remote", "second remote"]);
  });

  it("handles one side deleting a region the other left alone", () => {
    const local = "a\nd\n";

    const result = threeWayMerge("a\nb\nc\nd\n", local, "a\nb\nc\nd\n");

    expect(result.clean).toBe(true);
    expect(result.text).toBe("a\nd\n");
  });

  it("handles a note that is empty on either side", () => {
    expect(threeWayMerge("", "", "").text).toBe("");
    expect(threeWayMerge("", "new\n", "").text).toBe("new\n");
    expect(threeWayMerge("old\n", "", "old\n").text).toBe("");
  });

  it("preserves a trailing newline convention", () => {
    // Markdown files end with a newline; a merge must not add or drop one.
    expect(threeWayMerge("a\n", "a\nb\n", "a\n").text).toBe("a\nb\n");
    expect(threeWayMerge("a\n", "a\n", "a\nb\n").text).toBe("a\nb\n");
  });
});
