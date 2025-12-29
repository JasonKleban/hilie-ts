import type { LineSpans } from './types.js';

export function naiveSpanGenerator(lines: string[]): LineSpans[] {
  return lines.map((line, lineIndex) => {
    const spans: Array<{ start: number; end: number }> = [];
    let cursor = 0;

    for (const part of line.split('|')) {
      const trimmed = part.trim();
      const start = line.indexOf(trimmed, cursor);
      const end = start + trimmed.length;
      spans.push({ start, end });
      cursor = end;
    }

    return { lineIndex, spans };
  });
}
