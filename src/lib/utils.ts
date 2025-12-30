import type { LineSpans } from './types.js';
import { isLikelyExtID, isLikelyEmail, isLikelyPhone } from './validators.js';

export function detectDelimiter(lines: string[], candidates?: RegExp[]): RegExp {
  // Candidate delimiters to consider
  const cands = candidates ?? [
    /\t/, // tab-separated
    /\s{2,}/, // multiple spaces
    /,/, // comma
    /\|/, // pipe
    /;/, // semicolon
    /:/, // colon
    /\s+/ // whitespace fallback
  ];

  const scores: number[] = new Array(cands.length).fill(0);

  // Pre-scan for outline/bullet-style formatting and consistent indentation.
  const nonEmptyLines = lines.map(l => l ?? '').filter(l => l.trim());
  const bulletRx = /^\s*(?:[-*•]|\d+\.)\s+/;
  const bulletMatches = nonEmptyLines.filter(l => bulletRx.test(l)).length;
  const hasBullets = (bulletMatches / (nonEmptyLines.length || 1)) >= 0.35;
  const indentMatches = nonEmptyLines.filter(l => /^\s{2,}/.test(l)).length;
  const hasIndentation = (indentMatches / (nonEmptyLines.length || 1)) >= 0.35;
  // If bullets are detected, strip the leading bullet/number marker before scoring so
  // that columnar whitespace or tabs within the content remain visible.
  const workingLines = hasBullets ? nonEmptyLines.map(l => l.replace(bulletRx, '')) : nonEmptyLines;
  const linesToScan = workingLines;

  for (let ci = 0; ci < cands.length; ci++) {
    const rx = cands[ci]!;
    const partsPerLine: number[] = [];
    let emailMatches = 0;
    let phoneMatches = 0;
    let extidFirst = 0;

    for (const line of linesToScan) {
      if (!line || !line.trim()) continue;
      const parts = line.split(rx).map(p => p.trim()).filter(Boolean);
      partsPerLine.push(parts.length);
      if (parts.length > 0) {
        if (isLikelyExtID(parts[0])) extidFirst++;
        for (const p of parts) {
          if (isLikelyEmail(p)) emailMatches++;
          if (isLikelyPhone(p)) phoneMatches++;
        }
      }
    }

    if (partsPerLine.length === 0) {
      scores[ci] = -1;
      continue;
    }

    // median parts and consistency
    const sorted = partsPerLine.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median: number = sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    const consistency = partsPerLine.filter(p => p === median).length / partsPerLine.length;

    // fractions
    const extidFrac = extidFirst / partsPerLine.length;
    const emailFrac = emailMatches / (partsPerLine.length || 1);
    const phoneFrac = phoneMatches / (partsPerLine.length || 1);

    // scoring heuristic
    let score = 0;
    score += consistency * 2.0;
    score += Math.min(median, 10) * 0.1; // favor delimiters that split into multiple columns
    score += extidFrac * 2.0;
    score += emailFrac * 1.0;
    score += phoneFrac * 1.0;

    // penalize when median==1 (delimiter not splitting)
    if (median <= 1) score -= 0.5;

    // If the delimiter produces single-part lines very consistently and there are
    // no column-like signals (extid/email/phone), consider it a poor candidate
    // (likely not a true delimiter) and disqualify it.
    if (median <= 1 && consistency >= 0.6 && extidFrac === 0 && emailFrac === 0 && phoneFrac === 0) {
      scores[ci] = -1;
      continue;
    }

    scores[ci] = score;
  }

  // pick the best candidate
  let bestIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if ((scores[i] ?? -Infinity) > (scores[bestIdx] ?? -Infinity)) bestIdx = i;
  }

  // If whitespace-ish candidates are nearly as good as the best candidate, prefer them
  const multiSpaceIdx = cands.findIndex(r => r.source === "\\s{2,}");
  const anySpaceIdx = cands.findIndex(r => r.source === "\\s+");
  const tabIdx = cands.findIndex(r => r.source === "\\t");
  const bestScore = scores[bestIdx] ?? -Infinity;
  const eps = 0.25; // small tolerance

  // If tabs are present in the raw or working sample and tab-scoring is nearly as good as the best, prefer tabs
  const hasTabs = lines.some(l => l.includes('\t')) || workingLines.some(l => l.includes('\t'));
  const epsTab = 0.5; // allow a bit more slack when tabs are actually present

  // If bullets or indentation appear to be present, favor space-based delimiters more readily.
  const epsSpace = (hasBullets || hasIndentation) ? 0.5 : eps;

  if (tabIdx >= 0 && hasTabs && (scores[tabIdx] ?? -Infinity) >= bestScore - epsTab) {
    bestIdx = tabIdx;
  } else {
    // Otherwise prefer space-based candidates when the current best is NOT tab
    if (multiSpaceIdx >= 0 && (scores[multiSpaceIdx] ?? -Infinity) >= bestScore - epsSpace && bestIdx !== tabIdx) {
      bestIdx = multiSpaceIdx;
    } else if (anySpaceIdx >= 0 && (scores[anySpaceIdx] ?? -Infinity) >= bestScore - epsSpace && bestIdx !== tabIdx) {
      bestIdx = anySpaceIdx;
    }
  }

  // return the best regex; fallback to whitespace if score is low
  if ((scores[bestIdx] ?? -Infinity) < 0.1) return /\s+/;
  return cands[bestIdx]!;
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
  const delimiterRegex = options?.delimiterRegex ?? detectDelimiter(lines);
  const minTokenLength = options?.minTokenLength ?? 1;
  const maxTokensPerSpan = options?.maxTokensPerSpan ?? 50;
  const maxPartsPerLine = options?.maxPartsPerLine ?? 50;
  const maxSpansPerLine = options?.maxSpansPerLine ?? 128;

  return lines.map((line, lineIndex) => {
    const spans: Array<{ start: number; end: number }> = [];
    const rawParts = line.split(delimiterRegex);

    let cursor = 0;
    const parts: Array<{ text: string; start: number; end: number }> = [];

    for (const part of rawParts) {
      const trimmed = part?.trim();
      // skip tiny tokens or pure punctuation
      if (!trimmed || trimmed.length < minTokenLength || /^\W+$/.test(trimmed)) {
        cursor += part?.length || 1;
        continue;
      }

      const start = line.indexOf(trimmed, cursor);
      if (start >= 0) {
        const end = start + trimmed.length;
        parts.push({ text: trimmed, start, end });
        cursor = end;
      } else {
        cursor += part?.length;
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
