import { TranscriptChunk, TranscriptWord } from "../hooks/useTranscriber";
import { extractPlainText, sanitizeHTML } from "./SubtitleUtils";

export interface FindMatch {
  chunkIndex: number;
  start: number;
  end: number;
}

export interface FindReplaceOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

/** Returns the plain-text representation of a chunk used for search/replace offsets. */
export function getChunkPlainText(chunk: TranscriptChunk): string {
  return extractPlainText(chunk.text.trimStart());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchRegex(
  query: string,
  options: FindReplaceOptions,
): RegExp | null {
  if (!query) return null;
  let pattern = escapeRegExp(query);
  if (options.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  try {
    return new RegExp(pattern, options.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Finds every match of `query` across all chunks' plain text. */
export function findMatches(
  chunks: TranscriptChunk[],
  query: string,
  options: FindReplaceOptions,
): FindMatch[] {
  const regex = buildSearchRegex(query, options);
  if (!regex) return [];

  const matches: FindMatch[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    const plainText = getChunkPlainText(chunk);
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(plainText)) !== null) {
      matches.push({
        chunkIndex,
        start: match.index,
        end: match.index + match[0].length,
      });
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }
  });
  return matches;
}

function distributeWordsEvenly(
  texts: string[],
  start: number,
  end: number,
): TranscriptWord[] {
  if (!texts.length) return [];
  const span = Math.max(end - start, 0.001);
  const step = span / texts.length;
  return texts.map((text, i) => ({
    text,
    timestamp: [start + i * step, start + (i + 1) * step] as [
      number,
      number,
    ],
  }));
}

/**
 * Preserves word-level timestamps for text unaffected by an edit, and
 * interpolates new timestamps for the changed region based on the
 * timestamps of the surrounding, unchanged words.
 */
export function interpolateWordsForTextChange(
  words: TranscriptWord[] | undefined,
  oldPlainText: string,
  newPlainText: string,
  chunkStart: number,
  chunkEnd: number,
): TranscriptWord[] | undefined {
  if (!words?.length) return words;

  const oldWordTexts = oldPlainText.trim().split(/\s+/).filter(Boolean);
  const newWordTexts = newPlainText.trim().split(/\s+/).filter(Boolean);

  // If the word array doesn't line up with the tokenized old text, we can't
  // reliably align old timestamps to the new words, so spread them evenly.
  if (words.length !== oldWordTexts.length) {
    return distributeWordsEvenly(newWordTexts, chunkStart, chunkEnd);
  }

  const minLen = Math.min(oldWordTexts.length, newWordTexts.length);
  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    oldWordTexts[prefixLen] === newWordTexts[prefixLen]
  ) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldWordTexts[oldWordTexts.length - 1 - suffixLen] ===
    newWordTexts[newWordTexts.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const prefixWords = words.slice(0, prefixLen);
  const suffixWords = suffixLen ? words.slice(words.length - suffixLen) : [];
  const middleNewTexts = newWordTexts.slice(
    prefixLen,
    newWordTexts.length - suffixLen,
  );

  const rangeStart = prefixWords.length
    ? prefixWords[prefixWords.length - 1].timestamp[1]
    : chunkStart;
  const rangeEnd = suffixWords.length ? suffixWords[0].timestamp[0] : chunkEnd;

  const middleWords = distributeWordsEvenly(
    middleNewTexts,
    rangeStart,
    Math.max(rangeEnd, rangeStart),
  );

  return [...prefixWords, ...middleWords, ...suffixWords];
}

/** Applies one or more non-overlapping matches within a single chunk. */
export function replaceMatchesInChunk(
  chunk: TranscriptChunk,
  matchesInChunk: FindMatch[],
  replacement: string,
): TranscriptChunk {
  if (!matchesInChunk.length) return chunk;

  const oldPlainText = getChunkPlainText(chunk);
  const sorted = [...matchesInChunk].sort((a, b) => a.start - b.start);

  let newPlainText = "";
  let cursor = 0;
  for (const match of sorted) {
    newPlainText += oldPlainText.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  newPlainText += oldPlainText.slice(cursor);

  const newWords = interpolateWordsForTextChange(
    chunk.words,
    oldPlainText,
    newPlainText,
    chunk.timestamp[0],
    chunk.timestamp[1] ?? chunk.timestamp[0] + 1,
  );

  return {
    ...chunk,
    text: sanitizeHTML(newPlainText),
    words: newWords,
  };
}

/** Replaces every match across all chunks, grouped and applied per chunk. */
export function replaceAllMatches(
  chunks: TranscriptChunk[],
  matches: FindMatch[],
  replacement: string,
): TranscriptChunk[] {
  const matchesByChunk = new Map<number, FindMatch[]>();
  for (const match of matches) {
    const existing = matchesByChunk.get(match.chunkIndex);
    if (existing) {
      existing.push(match);
    } else {
      matchesByChunk.set(match.chunkIndex, [match]);
    }
  }

  return chunks.map((chunk, index) => {
    const chunkMatches = matchesByChunk.get(index);
    return chunkMatches
      ? replaceMatchesInChunk(chunk, chunkMatches, replacement)
      : chunk;
  });
}
