import type { LineSpans } from './types.js';

export function naiveSpanGenerator(lines: string[]): LineSpans[] {
  return lines.map((line, lineIndex) => {
    const spans: Array<{ start: number; end: number }> = [];
    let cursor = 0;

    for (const part of line.split(/\|/)) {
      const trimmed = part.trim();
      const start = line.indexOf(trimmed, cursor);
      const end = start + trimmed.length;
      spans.push({ start, end });
      cursor = end;
    }

    return { lineIndex, spans };
  });
}

export function spanGenerator(
  lines: string[],
  options?: {
    delimiterRegex?: RegExp;
    minTokenLength?: number;
    maxTokensPerSpan?: number;
    maxPartsPerLine?: number;
    maxSpansPerLine?: number;
  }
): LineSpans[] {
  const delimiterRegex = options?.delimiterRegex ?? /\||,|;|\t|\s{2,}/g;
  const minTokenLength = options?.minTokenLength ?? 2;
  const maxTokensPerSpan = options?.maxTokensPerSpan ?? 3;
  const maxPartsPerLine = options?.maxPartsPerLine ?? 8;
  const maxSpansPerLine = options?.maxSpansPerLine ?? 128;

  return lines.map((line, lineIndex) => {
    const spans: Array<{ start: number; end: number }> = [];
    const rawParts = line.split(delimiterRegex);

    let cursor = 0;
    const parts: Array<{ text: string; start: number; end: number }> = [];

    for (const part of rawParts) {
      const trimmed = part.trim();
      // skip tiny tokens or pure punctuation
      if (!trimmed || trimmed.length < minTokenLength || /^\W+$/.test(trimmed)) {
        cursor += part.length;
        continue;
      }

      const start = line.indexOf(trimmed, cursor);
      if (start >= 0) {
        const end = start + trimmed.length;
        parts.push({ text: trimmed, start, end });
        cursor = end;
      } else {
        cursor += part.length;
      }

      if (parts.length >= maxPartsPerLine) break;
    }

    // Generate spans for up to maxTokensPerSpan contiguous parts (n-grams)
    outer: for (let i = 0; i < parts.length; i++) {
      for (let k = 1; k <= maxTokensPerSpan && i + k <= parts.length; k++) {
        const start = parts[i]!.start;
        const end = parts[i + k - 1]!.end;
        if (end - start >= minTokenLength) {
          spans.push({ start, end });
          if (spans.length >= maxSpansPerLine) break outer;
        }
      }
    }

    // Fallback: if we found nothing, fall back to word tokens (with small cap)
    if (spans.length === 0) {
      const wordRegex = /\b\w{2,}\b/g;
      let m: RegExpExecArray | null;
      while ((m = wordRegex.exec(line))) {
        spans.push({ start: m.index, end: m.index + m[0].length });
        if (spans.length >= 64) break;
      }
    }

    return { lineIndex, spans };
  });
}
