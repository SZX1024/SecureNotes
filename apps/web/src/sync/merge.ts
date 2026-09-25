/**
 * Markdown three-way merge (§16).
 *
 * "Use Markdown three-way merge to assist manual resolution; unresolved sections must remain visible."
 *
 * The algorithm is diff3, line based: the differences of each side against the common ancestor are
 * computed, and a region is merged automatically only when at most one side changed it. When both sides
 * changed overlapping lines the result is not guessed at — the region is emitted with explicit markers so
 * the reader decides. That is the whole point: a merge that silently picks a side is the same failure as
 * last-write-wins, just harder to notice.
 *
 * It is deliberately independent of the editor, the network and the database: a merge is a pure function
 * of three strings, so its behaviour can be pinned down by tests.
 */

/** The markers a merged document carries where a decision is still needed. */
export const LOCAL_MARKER = "<<<<<<< LOCAL";
export const BASE_MARKER = "||||||| BASE";
export const SEPARATOR_MARKER = "=======";
export const REMOTE_MARKER = ">>>>>>> REMOTE";

export interface MergeConflict {
  /** The lines the ancestor had there, which is what makes the two sides comparable. */
  base: string[];
  local: string[];
  remote: string[];
}

export interface MergeResult {
  text: string;
  conflicts: MergeConflict[];
  /** True when every region merged without needing a decision. */
  clean: boolean;
}

interface Hunk {
  /** Start index in the base document. */
  baseStart: number;
  /** How many base lines the hunk replaces. */
  baseLength: number;
  /** The replacing lines. */
  lines: string[];
}

function splitLines(text: string): string[] {
  // A trailing newline is a property of the text, not an extra empty line, so it is restored at the end.
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

/** Longest common subsequence, used to see what actually changed between two versions. */
function lcsMatrix(left: readonly string[], right: readonly string[]): number[][] {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/** The regions where `changed` differs from `base`, expressed as replacements of base ranges. */
export function diffHunks(base: readonly string[], changed: readonly string[]): Hunk[] {
  const table = lcsMatrix(base, changed);
  const hunks: Hunk[] = [];

  let i = 0;
  let j = 0;
  let pending: Hunk | null = null;

  const flush = () => {
    if (pending) {
      hunks.push(pending);
      pending = null;
    }
  };

  while (i < base.length || j < changed.length) {
    if (i < base.length && j < changed.length && base[i] === changed[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }

    // A mismatch: extend the current hunk, or start one. Advancing the side with the smaller remaining
    // match keeps the hunks minimal, which is what allows the two sides to merge cleanly when they touch
    // different regions.
    if (!pending) {
      pending = { baseStart: i, baseLength: 0, lines: [] };
    }

    const keepBase =
      j >= changed.length || (i < base.length && table[i + 1]![j]! >= table[i]![j + 1]!);
    if (keepBase) {
      pending.baseLength += 1;
      i += 1;
    } else {
      pending.lines.push(changed[j]!);
      j += 1;
    }
  }

  flush();
  return hunks;
}

/**
 * Merges two edited versions of a common ancestor.
 *
 * `local` and `remote` are interchangeable for the result except for which marker block they appear in,
 * so a caller that prefers one side can simply swap the arguments.
 */
export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);

  // Identical edits, or one side untouched: nothing to decide.
  if (local === remote) {
    return { text: local, conflicts: [], clean: true };
  }
  if (base === local) {
    return { text: remote, conflicts: [], clean: true };
  }
  if (base === remote) {
    return { text: local, conflicts: [], clean: true };
  }

  const localHunks = diffHunks(baseLines, localLines);
  const remoteHunks = diffHunks(baseLines, remoteLines);

  const output: string[] = [];
  const conflicts: MergeConflict[] = [];

  let cursor = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  while (localIndex < localHunks.length || remoteIndex < remoteHunks.length) {
    const nextLocal = localHunks[localIndex];
    const nextRemote = remoteHunks[remoteIndex];

    // Copy the untouched base lines up to the next change on either side.
    const nextStart = Math.min(
      nextLocal?.baseStart ?? Number.POSITIVE_INFINITY,
      nextRemote?.baseStart ?? Number.POSITIVE_INFINITY,
    );
    while (cursor < nextStart) {
      output.push(baseLines[cursor]!);
      cursor += 1;
    }

    if (nextLocal && nextRemote && overlaps(nextLocal, nextRemote)) {
      // Both sides changed the same region: take the whole overlapping span and mark it.
      const start = Math.min(nextLocal.baseStart, nextRemote.baseStart);
      const localEnd = nextLocal.baseStart + nextLocal.baseLength;
      const remoteEnd = nextRemote.baseStart + nextRemote.baseLength;
      const end = Math.max(localEnd, remoteEnd);

      const localSide = collectSide(localLines, baseLines, localHunks, localIndex, end);
      const remoteSide = collectSide(remoteLines, baseLines, remoteHunks, remoteIndex, end);

      output.push(
        LOCAL_MARKER,
        ...localSide.lines,
        BASE_MARKER,
        ...baseLines.slice(start, end),
        SEPARATOR_MARKER,
        ...remoteSide.lines,
        REMOTE_MARKER,
      );
      conflicts.push({
        base: baseLines.slice(start, end),
        local: localSide.lines,
        remote: remoteSide.lines,
      });

      cursor = end;
      localIndex = localSide.nextIndex;
      remoteIndex = remoteSide.nextIndex;
      continue;
    }

    // Only one side changed here.
    if (nextLocal && (!nextRemote || nextLocal.baseStart < nextRemote.baseStart)) {
      output.push(...nextLocal.lines);
      cursor = nextLocal.baseStart + nextLocal.baseLength;
      localIndex += 1;
      continue;
    }
    if (nextRemote) {
      output.push(...nextRemote.lines);
      cursor = nextRemote.baseStart + nextRemote.baseLength;
      remoteIndex += 1;
    }
  }

  while (cursor < baseLines.length) {
    output.push(baseLines[cursor]!);
    cursor += 1;
  }

  const text = output.join("\n");
  return {
    text: text.length === 0 ? "" : `${text}\n`,
    conflicts,
    clean: conflicts.length === 0,
  };
}

function overlaps(left: Hunk, right: Hunk): boolean {
  const leftEnd = left.baseStart + left.baseLength;
  const rightEnd = right.baseStart + right.baseLength;
  // Touching ranges count as overlapping: inserting at the same point from both sides is ambiguous too.
  return left.baseStart <= rightEnd && right.baseStart <= leftEnd;
}

/**
 * Gathers everything one side says about a base range.
 *
 * A conflict region can span several hunks from the same side, so they are collected together rather
 * than reported one at a time — the user should see one region to decide, not three.
 */
function collectSide(
  sideLines: readonly string[],
  baseLines: readonly string[],
  hunks: readonly Hunk[],
  fromIndex: number,
  endBase: number,
): { lines: string[]; nextIndex: number } {
  const lines: string[] = [];
  let index = fromIndex;
  let cursor = hunks[fromIndex]!.baseStart;

  while (index < hunks.length && hunks[index]!.baseStart <= endBase) {
    const hunk = hunks[index]!;
    const gap = hunk.baseStart - cursor;
    if (gap > 0) {
      // Unchanged lines inside the conflict region are part of what the user is comparing.
      lines.push(...baseLines.slice(cursor, hunk.baseStart));
    }
    lines.push(...hunk.lines);
    cursor = hunk.baseStart + hunk.baseLength;
    index += 1;
  }

  const tail = endBase - cursor;
  if (tail > 0) {
    lines.push(...baseLines.slice(cursor, endBase));
  }

  // Guard against a side whose hunks end before the region does.
  void sideLines;
  return { lines, nextIndex: index };
}
