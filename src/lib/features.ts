import type { Feature } from './types.js';
import { isLikelyEmail, isLikelyPhone, isLikelyBirthdate, isLikelyExtID, isLikelyName, isLikelyPreferredName } from './validators.js';

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

    const tokenize = (s: string | undefined) => s?.toLowerCase().split(/\W+/).filter(Boolean);

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

    const line = ctx.lines[ctx.lineIndex]?.trim();

    return !line || line === "" ? 1 : 0;
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
    const text = ctx.lines[lineIndex]?.slice(start, end);

    const digits = (text?.match(/\d/g))?.length ?? 0;
    const total = text?.length || 1;

    return clamp(digits / total);
  }
};

export const segmentIsEmail: Feature = {
  id: 'segment.is_email',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isLikelyEmail(text) ? 1 : 0;
  }
};

export const segmentIsPhone: Feature = {
  id: 'segment.is_phone',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isLikelyPhone(text) ? 1 : 0;
  }
};

export const tokenRepetitionScore: Feature = {
  id: 'token.repetition_score',
  apply(ctx) {
    if (!ctx.candidateSpan || !ctx.schemaStats) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const token = ctx.lines[lineIndex]?.slice(start, end)?.trim();

    const freq = token ? (ctx.schemaStats.tokenFrequency[token] ?? 0) : 0;
    const entityCount = ctx.schemaStats.entityCount || 1;

    return clamp(freq / entityCount);
  }
};

export const delimiterContextIsolation: Feature = {
  id: 'token.context_isolation',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const line = ctx.lines[lineIndex]!;

    const left = line[start - 1]!;
    const right = line[end]!;

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
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isLikelyBirthdate(text) ? 1 : 0;
  }
};

export const segmentIsExtID: Feature = {
  id: 'segment.is_extid',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]!.slice(start, end);

    return isLikelyExtID(text) ? (0.8 + 0.2) : 0;
  }
};

export const segmentIsName: Feature = {
  id: 'segment.is_name',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isLikelyName(text) ? 1 : 0;
  }
};

export const segmentIsPreferredName: Feature = {
  id: 'segment.is_preferred_name',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isLikelyPreferredName(text) ? 1 : 0;
  }
};

export const segmentFeatures: Feature[] = [
  // put stronger signals up-front so they influence decoding earlier
  segmentIsExtID,
  segmentIsName,
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

export const leadingExtID: Feature = {
  id: 'line.leading_extid',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    const m = line.trim().match(/^(#?\S+)/);
    if (!m) return 0;
    const token = m[1];
    return isLikelyExtID(token) ? 1 : 0;
  }
};

export const hasNameLikelihood: Feature = {
  id: 'line.has_name',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    if (isLikelyName(line)) return 1;
    // also detect Last, First style
    if (/^[A-Za-z\-']+,\s*[A-Za-z\-']+/.test(line)) return 0.8;
    return 0;
  }
};

export const hasPreferredName: Feature = {
  id: 'line.has_preferred',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    return isLikelyPreferredName(line) ? 1 : 0;
  }
};

export const hasBirthdate: Feature = {
  id: 'line.has_birthdate',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    return isLikelyBirthdate(line) ? 1 : 0;
  }
};

export const hasColonLabel: Feature = {
  id: 'line.has_label',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    if (/\b(Name|ID|DOB|Birthdate|Phone|Email):/i.test(line)) return 1;
    return 0;
  }
};

export const leadingStructural: Feature = {
  id: 'line.leading_structural',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    if (/^\s*[*•o-]/.test(line)) return 1;
    if (/^\s*\d+[\.)]/.test(line)) return 1;
    return 0;
  }
};

export const shortTokenCount: Feature = {
  id: 'line.short_token_count',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    const tokens = line.trim().split(/\s+/).filter(Boolean).length;
    if (tokens <= 1) return 1;
    if (tokens <= 3) return 0.6;
    return 0;
  }
};

export const nextHasContact: Feature = {
  id: 'line.next_has_contact',
  apply(ctx) {
    const next = ctx.lines[ctx.lineIndex + 1] ?? '';
    if (!next) return 0;
    if (isLikelyPhone(next) || isLikelyEmail(next)) return 1;
    return 0;
  }
};

export const primaryLikely: Feature = {
  id: 'line.primary_likely',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';

    // leading numeric id, 'ID:' label, comma-separated Last, First, or table-like pipes
    if (/^\s*\d+\b/.test(line) || /\bID:/i.test(line) || /^\s*[A-Za-z]+,\s*[A-Za-z]+/.test(line) || /\|/.test(line)) return 1;
    return 0;
  }
};

export const guardianLikely: Feature = {
  id: 'line.guardian_likely',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';

    if (/\bparent\b|\bguardian\b|\bmom\b|\bdad\b|\bfather\b|\bmother\b/i.test(line)) return 1;
    // outline bullets with 'Parent'
    if (/^\s*[*•o-]\s*Parent/i.test(line)) return 1;
    return 0;
  }
};

export const boundaryFeatures: Feature[] = [
  // order important: stronger signals first
  leadingExtID,
  hasNameLikelihood,
  hasPreferredName,
  hasBirthdate,
  hasColonLabel,
  leadingStructural,
  shortTokenCount,
  nextHasContact,
  indentationDelta,
  lexicalSimilarityDrop,
  blankLine,
  primaryLikely,
  guardianLikely
];