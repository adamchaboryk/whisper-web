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

export function formatSrtChunks(chunks: { text: string; timestamp: [number, number | null] }[]) {
  const MAX_LINE_CHARS = 42;
  const MAX_LINES = 2;

  const formattedChunks: { text: string; timestamp: [number, number | null] }[] = [];

  const getVisibleLength = (str: string) => {
    return str.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, 'x').length;
  };

  for (const chunk of chunks) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;

    const words = chunkText.split(/\s+/).filter(Boolean);
    const sourceStart = chunk.timestamp[0];
    const sourceEnd = chunk.timestamp[1] ?? sourceStart;
    const sourceDuration = sourceEnd - sourceStart;
    const sourceLength = getVisibleLength(words.join(" "));

    let currentText = "";
    let currentStartOffset = 0;

    const pushChunk = (text: string, endOffset: number) => {
      const start = sourceStart + (sourceDuration * currentStartOffset) / Math.max(1, sourceLength);
      const end = sourceStart + (sourceDuration * endOffset) / Math.max(1, sourceLength);
      formattedChunks.push({
        text,
        timestamp: [start, end],
      });
      currentText = "";
      currentStartOffset = endOffset + 1;
    };

    for (const word of words) {
      const visibleWord = getVisibleLength(word);
      const candidate = currentText ? `${currentText} ${word}` : word;
      const lines = currentText.split("\n");
      const visibleLineLength = getVisibleLength(lines[lines.length - 1] ?? "");

      const hasRoomOnCurrentLine = visibleLineLength + (currentText ? 1 : 0) + visibleWord <= MAX_LINE_CHARS;
      const hasRoomForSecondLine = lines.length < MAX_LINES;

      if (currentText && !hasRoomOnCurrentLine && !hasRoomForSecondLine) {
        pushChunk(currentText, currentStartOffset + getVisibleLength(currentText) - 1);
      }

      if (!currentText) {
        currentText = word;
      } else if (hasRoomOnCurrentLine) {
        currentText = candidate;
      } else {
        currentText = `${currentText}\n${word}`;
      }
    }

    if (currentText) {
      pushChunk(currentText, sourceLength - 1);
    }
  }

  return formattedChunks;
}
