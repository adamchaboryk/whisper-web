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

