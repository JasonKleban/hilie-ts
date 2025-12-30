import type { Feature } from './types.js';
import { isLikelyEmail, isLikelyPhone, isLikelyBirthdate, isLikelyExtID, isLikelyFullName, isLikelyPreferredName } from './validators.js';

function clamp(x: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, x));
}

export const indentationDelta: Feature = {
  id: 'line.indentation_delta',
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    const curr = ctx.lines[ctx.lineIndex];
    const prev = ctx.lines[ctx.lineIndex - 1];

    const indent = (s: string | undefined) => s?.match(/^\s*/)?.[0].length ?? 0;

    const delta = indent(curr) - indent(prev);

    return clamp(delta / 8);
  }
};

export const lexicalSimilarityDrop: Feature = {
  id: 'line.lexical_similarity_drop',
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    const tokenize = (s: string | undefined) => s?.toLowerCase().split(/\W+/).filter(Boolean) ?? [];

    const a = new Set(tokenize(ctx.lines[ctx.lineIndex - 1]));
    const b = new Set(tokenize(ctx.lines[ctx.lineIndex]));

    const intersection = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size || 1;

    const jaccard = intersection / union;

    return clamp(1 - jaccard);
  }
};

export const blankLine: Feature = {
  id: 'line.blank_line',
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    return (ctx.lines[ctx.lineIndex] ?? "").trim() === "" ? 1 : 0;
  }
};

export const tokenCountBucket: Feature = {
  id: 'segment.token_count_bucket',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    const count = text?.trim().split(/\s+/).length ?? 0;

    if (count <= 1) return 0.2;
    if (count <= 3) return 0.5;
    if (count <= 7) return 0.8;
    return 0.6;
  }
};

export const numericRatio: Feature = {
  id: 'segment.numeric_ratio',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';

    const digits = (text.match(/\d/g) ?? []).length;
    const total = text.length || 1;

    return clamp(digits / total);
  }
};

export const segmentIsEmail: Feature = {
  id: 'segment.is_email',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';
    return isLikelyEmail(text) ? 1 : 0;
  }
};

export const segmentIsPhone: Feature = {
  id: 'segment.is_phone',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';
    return isLikelyPhone(text) ? 1 : 0;
  }
};

export const tokenRepetitionScore: Feature = {
  id: 'token.repetition_score',
  apply(ctx) {
    if (!ctx.candidateSpan || !ctx.schemaStats) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const token = (ctx.lines[lineIndex]?.slice(start, end) ?? '').trim();

    const freq = ctx.schemaStats.tokenFrequency[token] ?? 0;
    const entityCount = ctx.schemaStats.entityCount || 1;

    return clamp(freq / entityCount);
  }
};

export const delimiterContextIsolation: Feature = {
  id: 'token.context_isolation',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const line = ctx.lines[lineIndex];

    const left = line?.[start - 1] ?? '';
    const right = line?.[end] ?? '';

    const score = (/\s/.test(left) ? 0.5 : 0) + (/\s/.test(right) ? 0.5 : 0);

    return score;
  }
};

export const relativePositionConsistency: Feature = {
  id: 'field.relative_position_consistency',
  apply(ctx) {
    if (!ctx.candidateSpan || !ctx.previousEntity) return 0;

    const { start } = ctx.candidateSpan;
    const mean = ctx.previousEntity.meanFieldStart;

    const delta = Math.abs(start - mean);

    return clamp(1 - delta / 40);
  }
};

export const optionalFieldPenalty: Feature = {
  id: 'field.optional_penalty',
  apply(ctx) {
    if (!ctx.schemaStats) return 0;

    const optionalProb = ctx.schemaStats.optionalFieldProbability ?? 0.5;

    return clamp(-1 + optionalProb);
  }
};

// New segment-level heuristics: birthdate, ExtID, FullName, PreferredName
export const segmentIsBirthdate: Feature = {
  id: 'segment.is_birthdate',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';
    return isLikelyBirthdate(text) ? 1 : 0;
  }
};

export const segmentIsExtID: Feature = {
  id: 'segment.is_extid',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';

    // prefer extids that appear near start of line
    const line = ctx.lines[lineIndex] ?? '';
    const posBias = Math.max(0, 1 - (start / Math.max(1, line.length))); // 1 near start, 0 at end

    return isLikelyExtID(text) ? (0.8 + 0.2 * posBias) : 0;
  }
};

export const segmentIsFullName: Feature = {
  id: 'segment.is_fullname',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';
    return isLikelyFullName(text) ? 1 : 0;
  }
};

export const segmentIsPreferredName: Feature = {
  id: 'segment.is_preferred_name',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? '';
    return isLikelyPreferredName(text) ? 1 : 0;
  }
};

export const segmentFeatures: Feature[] = [
  // put stronger signals up-front so they influence decoding earlier
  segmentIsExtID,
  segmentIsFullName,
  segmentIsPreferredName,
  segmentIsBirthdate,
  segmentIsEmail,
  segmentIsPhone,
  tokenCountBucket,
  numericRatio,
  tokenRepetitionScore,
  delimiterContextIsolation,
  relativePositionConsistency,
  optionalFieldPenalty
];

export const boundaryFeatures: Feature[] = [
  indentationDelta, 
  lexicalSimilarityDrop,
  blankLine
];