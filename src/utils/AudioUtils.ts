function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function pad3(n: number): string {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}

export function formatAudioTimestamp(time: number): string {
  const totalSeconds = Math.floor(time);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hoursPrefix = hours > 0 ? pad2(hours) + ":" : "";
  return `${hoursPrefix}${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatSrtTimestamp(time: number): string {
  const totalSeconds = Math.floor(time);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor((time - totalSeconds) * 1000);

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(milliseconds)}`;
}

export function formatSrtTimeRange(start: number, end: number): string {
  return `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`;
}

export function parseAudioTimestamp(timestamp: string): number | null {
  const trimmed = timestamp.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":");
  if (parts.length === 0 || parts.length > 3) return null;

  let seconds = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) return null;
    const value = parseFloat(part);
    if (isNaN(value) || !isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return isFinite(seconds) && seconds >= 0 ? seconds : null;
}
