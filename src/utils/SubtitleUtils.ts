export function parseSubtitleFile(text: string, type: 'srt' | 'vtt') {
  const chunks: { text: string; timestamp: [number, number | null] }[] = [];
  const lines = text.split(/\r?\n/);

  let i = 0;

  if (type === 'vtt') {
    // Skip WEBVTT header and optional metadata
    while (i < lines.length && !lines[i].includes('-->')) {
      if (lines[i].startsWith('WEBVTT')) {
        i++;
      } else {
        i++;
      }
    }
  }

  const timeToSeconds = (timeStr: string) => {
    const parts = timeStr.trim().split(':');
    let seconds = 0;

    // Check if it has hours
    if (parts.length === 3) {
      seconds += parseInt(parts[0], 10) * 3600;
      seconds += parseInt(parts[1], 10) * 60;
      seconds += parseFloat(parts[2].replace(',', '.'));
    } else if (parts.length === 2) {
      seconds += parseInt(parts[0], 10) * 60;
      seconds += parseFloat(parts[1].replace(',', '.'));
    }
    return seconds;
  };

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines or sequence numbers
    if (!line || (!line.includes('-->') && !isNaN(Number(line)))) {
      i++;
      continue;
    }

    if (line.includes('-->')) {
      const [start, end] = line.split('-->');
      const startTime = timeToSeconds(start);
      const endTime = timeToSeconds(end);

      i++;
      let textChunk = '';

      // Collect text lines until an empty line
      while (i < lines.length && lines[i].trim() !== '') {
        // Strip HTML/VTT tags from text if needed, for simplicity we just trim
        let cleanText = lines[i];
        if (type === 'vtt') {
          cleanText = cleanText.replace(/<[^>]+>/g, ''); // strip VTT tags
        }
        textChunk += (textChunk ? '\n' : '') + cleanText;
        i++;
      }

      chunks.push({
        text: textChunk,
        timestamp: [startTime, endTime]
      });
    } else {
      i++;
    }
  }

  const fullText = chunks.map(c => c.text).join(' ');
  return { chunks, text: fullText };
}

const MAX_LINE_CHARACTERS = 42;
const MAX_LINES_PER_EVENT = 2;
const MIN_SUBTITLE_DURATION = 1.0; // Minimum On-Screen Duration: 1.0 second
const TECHNICAL_FLOOR_DURATION = 0.2; // Absolute technical floor: ~5 frames / 200ms
const MAX_SUBTITLE_DURATION = 7.0; // Maximum On-Screen Duration: 6 to 7 seconds
const INTER_SUBTITLE_GAP = 0.084; // Inter-Subtitle Gap: 2 to 3 frames (~84ms at 25-30fps)
const TARGET_CPS = 16.0; // Standard Dialogue reading speed: 15-17 CPS
const MAX_CPS = 20.0; // Fast Dialogue Max reading speed: 20 CPS

/**
 * Returns visible character length ignoring HTML/VTT tags and entities
 */
export function getVisibleLength(str: string): number {
  return str.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, 'x').length;
}

const CONJUNCTIONS = new Set([
  "and", "but", "or", "nor", "for", "yet", "so",
  "because", "although", "though", "while", "since",
  "unless", "whereas", "which", "that", "who", "whom", "whose",
  "when", "whenever", "where", "wherever", "if", "whether", "as"
]);

const PREPOSITIONS = new Set([
  "in", "on", "at", "to", "from", "with", "by", "about",
  "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "over", "of", "off", "out"
]);

const ARTICLES_AND_DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those"
]);

const POSSESSIVES = new Set([
  "my", "your", "his", "her", "its", "our", "their"
]);

const HONORIFICS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st."
]);

const AUXILIARY_VERBS = new Set([
  "is", "am", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must"
]);

/**
 * Splits text into at most 2 lines (max 42 CPL) using Pyramid Style and Grammatical Line Breaks.
 * Top line is shorter than or equal to bottom line (Pyramid style).
 */
export function splitTextIntoPyramidLines(text: string): string {
  const clean = text.trim();
  if (!clean) return "";

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return clean;

  const totalVisible = getVisibleLength(words.join(" "));
  // Single-line subtitles are preferred when possible (<= 42 chars)
  if (totalVisible <= MAX_LINE_CHARACTERS) {
    return clean;
  }

  let bestSplitIndex = -1;
  let bestScore = -Infinity;

  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(" ");
    const line2 = words.slice(i).join(" ");

    const len1 = getVisibleLength(line1);
    const len2 = getVisibleLength(line2);

    // Both lines must be within the 42 CPL maximum limit
    if (len1 > MAX_LINE_CHARACTERS || len2 > MAX_LINE_CHARACTERS) {
      continue;
    }

    let score = 0;

    // Visual Hierarchy (Pyramid Style): keep top line <= bottom line
    if (len1 <= len2) {
      score += 40;
      const ratio = len1 / Math.max(1, len2);
      if (ratio >= 0.6 && ratio <= 0.95) {
        score += 25; // Reward balanced pyramid
      }
    } else {
      score -= (len1 - len2) * 4; // Penalize top-heavy split
    }

    const prevWord = words[i - 1];
    const prevWordLower = prevWord.toLowerCase().replace(/['"“”‘’]/g, "");
    const nextWord = words[i];
    const nextWordLower = nextWord.toLowerCase().replace(/['"“”‘’]/g, "");

    // Grammatical Line Breaks:
    // 1. Break after terminal punctuation (. ! ?)
    if (/[.!?]["'”)]?$/.test(prevWord)) {
      score += 100;
    }
    // 2. Break after clause punctuation (, ; : — -)
    else if (/[,;:\u2014-]["'”)]?$/.test(prevWord)) {
      score += 70;
    }

    // 3. Break before conjunctions or relative clauses
    if (CONJUNCTIONS.has(nextWordLower)) {
      score += 45;
    }

    // 4. Break before prepositions
    if (PREPOSITIONS.has(nextWordLower)) {
      score += 25;
    }

    // Penalize unnatural splits:
    if (ARTICLES_AND_DETERMINERS.has(prevWordLower)) {
      score -= 80;
    }
    if (POSSESSIVES.has(prevWordLower)) {
      score -= 60;
    }
    if (HONORIFICS.has(prevWordLower)) {
      score -= 100;
    }
    if (AUXILIARY_VERBS.has(prevWordLower)) {
      score -= 45;
    }
    if (prevWord.length === 1 && /[A-Z]/.test(prevWord)) {
      score -= 80;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSplitIndex = i;
    }
  }

  if (bestSplitIndex !== -1) {
    return `${words.slice(0, bestSplitIndex).join(" ")}\n${words.slice(bestSplitIndex).join(" ")}`;
  }

  // Fallback if strict grammar scoring didn't match
  let line1 = "";
  let line2 = "";
  for (const word of words) {
    if (!line1 || getVisibleLength(`${line1} ${word}`) <= MAX_LINE_CHARACTERS) {
      line1 = line1 ? `${line1} ${word}` : word;
    } else {
      line2 = line2 ? `${line2} ${word}` : word;
    }
  }
  return line2 ? `${line1}\n${line2}` : line1;
}

/**
 * Formats transcript chunks into broadcast-compliant subtitles:
 * - Max 42 CPL.
 * - Max 2 lines per event (single-line preferred).
 * - Pyramid visual hierarchy (top line <= bottom line).
 * - Grammatical line breaks.
 * - Minimum on-screen duration: 1.0s (floor: 0.2s).
 * - Maximum on-screen duration: 6 to 7 seconds.
 * - Inter-subtitle gap: 2 to 3 frames (~84ms).
 * - Reading speed constraints: 15-17 CPS standard, max 20 CPS.
 */
export function formatSrtChunks(chunks: { text: string; timestamp: [number, number | null] }[]) {
  if (!chunks.length) return [];

  // 1. Flatten into linear words with interpolated timing
  interface WordTiming {
    word: string;
    start: number;
    end: number;
  }

  const allWords: WordTiming[] = [];

  for (const chunk of chunks) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;

    const words = chunkText.split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const sourceStart = chunk.timestamp[0];
    const sourceEnd = chunk.timestamp[1] ?? (sourceStart + words.length * 0.4);
    const sourceDuration = Math.max(0.2, sourceEnd - sourceStart);
    const totalChars = words.join(" ").length;

    let charOffset = 0;
    for (const word of words) {
      const wordStart = sourceStart + (sourceDuration * charOffset) / Math.max(1, totalChars);
      charOffset += word.length;
      const wordEnd = sourceStart + (sourceDuration * charOffset) / Math.max(1, totalChars);
      charOffset += 1; // space
      allWords.push({
        word,
        start: wordStart,
        end: wordEnd,
      });
    }
  }

  if (!allWords.length) return [];

  // 2. Group words into events fitting max 2 lines (<= 84 chars) and <= 7.0s duration
  const rawEvents: { text: string; start: number; end: number }[] = [];
  let currentWords: WordTiming[] = [];

  const flushEvent = () => {
    if (!currentWords.length) return;
    const text = currentWords.map((w) => w.word).join(" ");
    const start = currentWords[0].start;
    const end = currentWords[currentWords.length - 1].end;
    rawEvents.push({ text, start, end });
    currentWords = [];
  };

  const MAX_EVENT_CHARS = MAX_LINE_CHARACTERS * MAX_LINES_PER_EVENT; // 84 chars max

  for (let i = 0; i < allWords.length; i++) {
    const wordObj = allWords[i];
    const candidateWords = [...currentWords, wordObj];
    const candidateText = candidateWords.map((w) => w.word).join(" ");
    const candidateLength = getVisibleLength(candidateText);
    const candidateDuration = wordObj.end - (currentWords[0]?.start ?? wordObj.start);

    const isTerminalPunctuation = /[.!?]["'”)]?$/.test(wordObj.word);
    const isClausePunctuation = /[,;:\u2014-]["'”)]?$/.test(wordObj.word);

    // Check if adding this word exceeds event constraints
    const exceedsLength = candidateLength > MAX_EVENT_CHARS;
    const exceedsDuration = candidateDuration > MAX_SUBTITLE_DURATION;

    if (currentWords.length > 0 && (exceedsLength || exceedsDuration)) {
      flushEvent();
      currentWords.push(wordObj);
    } else {
      currentWords.push(wordObj);
    }

    // Natural break at terminal punctuation if current event has reasonable length
    if (isTerminalPunctuation && candidateLength >= 20) {
      flushEvent();
    } else if (isClausePunctuation && candidateLength >= 45 && candidateDuration >= 3.0) {
      flushEvent();
    }
  }
  flushEvent();

  // 3. Apply pyramid line splitting, duration clamping, and reading speed constraints
  const formattedEvents: { text: string; timestamp: [number, number] }[] = [];

  for (const ev of rawEvents) {
    const pyramidText = splitTextIntoPyramidLines(ev.text);
    const visibleLength = getVisibleLength(pyramidText);

    // Reading speed constraints (15-17 CPS standard, max 20 CPS)
    const minReadingDuration = visibleLength / MAX_CPS; // Absolute min for reading speed
    const idealReadingDuration = visibleLength / TARGET_CPS; // Target reading speed

    let duration = ev.end - ev.start;
    // Ensure duration meets minimum 1.0s and reading speed requirement
    duration = Math.max(duration, MIN_SUBTITLE_DURATION, minReadingDuration);
    // Prefer target reading speed if duration was very brief
    duration = Math.max(duration, Math.min(idealReadingDuration, MAX_SUBTITLE_DURATION));
    // Cap at maximum on-screen duration (6 to 7 seconds)
    duration = Math.min(duration, MAX_SUBTITLE_DURATION);

    formattedEvents.push({
      text: pyramidText,
      timestamp: [ev.start, ev.start + duration],
    });
  }

  // 4. Enforce inter-subtitle gap (2 to 3 frames, ~84ms) and sequential timing
  for (let i = 0; i < formattedEvents.length; i++) {
    const current = formattedEvents[i];
    const next = formattedEvents[i + 1];

    if (next) {
      // Ensure current ends before next start by at least INTER_SUBTITLE_GAP
      const maxCurrentEnd = next.timestamp[0] - INTER_SUBTITLE_GAP;
      if (current.timestamp[1] > maxCurrentEnd) {
        if (maxCurrentEnd - current.timestamp[0] >= TECHNICAL_FLOOR_DURATION) {
          current.timestamp[1] = Math.max(current.timestamp[0] + TECHNICAL_FLOOR_DURATION, maxCurrentEnd);
        } else {
          // If spacing is extremely tight, push the next subtitle start
          current.timestamp[1] = current.timestamp[0] + TECHNICAL_FLOOR_DURATION;
          next.timestamp[0] = current.timestamp[1] + INTER_SUBTITLE_GAP;
          if (next.timestamp[1] < next.timestamp[0] + TECHNICAL_FLOOR_DURATION) {
            next.timestamp[1] = next.timestamp[0] + TECHNICAL_FLOOR_DURATION;
          }
        }
      }
    }
  }

  return formattedEvents;
}

