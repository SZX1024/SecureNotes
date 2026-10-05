/**
 * Note statistics: word count, character count, and reading time.
 *
 * Supports both CJK characters and Western words for accurate metrics.
 */

export interface NoteStats {
  characters: number;
  words: number;
  readingMinutes: number;
  label: string;
}

const CJK_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_WORD_REGEX = /[a-zA-Z0-9_\u00C0-\u024F]+(?:'[a-zA-Z]+)?/g;

export function countNoteStats(text: string): NoteStats {
  if (!text || text.trim().length === 0) {
    return {
      characters: 0,
      words: 0,
      readingMinutes: 0,
      label: "0 words",
    };
  }

  // Count CJK characters
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK chars to isolate Latin/other words
  const nonCjkText = text.replace(CJK_REGEX, " ");
  const latinMatches = nonCjkText.match(LATIN_WORD_REGEX);
  const latinCount = latinMatches ? latinMatches.length : 0;

  const totalWords = cjkCount + latinCount;
  const characters = text.replace(/\s+/g, "").length;

  // Estimation: CJK ~350 chars/min, Latin ~200 words/min
  const estimatedMinutes = Math.max(1, Math.ceil(cjkCount / 350 + latinCount / 200));

  const wordPart = `${totalWords.toLocaleString()} ${totalWords === 1 ? "word" : "words"}`;
  const timePart = `~${estimatedMinutes} min read`;
  const label = `${wordPart} · ${timePart}`;

  return {
    characters,
    words: totalWords,
    readingMinutes: estimatedMinutes,
    label,
  };
}
