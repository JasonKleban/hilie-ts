import type { Feature } from './types.js';
import { isLikelyEmail, isLikelyPhone, isLikelyBirthdate, isLikelyExtID, isLikelyName, isLikelyPreferredName, containsMonth, containsDaySuffix, isCommonFirstName } from './validators.js';

function clamp(x: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, x));
}

// Configurable thresholds to avoid overfitting
const INDENTATION_SCALE = 8;
const POSITION_VARIANCE_SCALE = 40;
const CHAR_LENGTH_THRESHOLDS = { short: 5, medium: 15, long: 50 };

export const indentationDelta: Feature = {
  id: 'line.indentation_delta',
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    const curr = ctx.lines[ctx.lineIndex];
    const prev = ctx.lines[ctx.lineIndex - 1];

    const indent = (s: string | undefined) => s?.match(/^\s*/)?.[0].length ?? 0;

    const delta = indent(curr) - indent(prev);

    return clamp(delta / INDENTATION_SCALE);
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

export const hangingContinuation: Feature = {
  id: 'line.hanging_continuation',
  apply(ctx) {
    // Is the *next* line a hanging-indented continuation (starts with indentation
    // and lacks a list marker or numbered bullet)?
    const next = ctx.lines[ctx.lineIndex + 1] ?? '';
    if (!next) return 0;

    // Must start with some whitespace
    if (!/^\s+/.test(next)) return 0;
    const trimmed = next.trimStart();
    if (!trimmed) return 0;
    const ch = trimmed[0];

    // Exclude bullets and common list markers
    if (ch === '-' || ch === '*' || ch === '•' || ch === '+') return 0;
    // Exclude numbered bullets like "1." or "2)"
    if (/^\d+[\.)]/.test(trimmed)) return 0;

    return 1;
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
    
    // TF-IDF style: penalize if token appears too frequently (common word)
    const tf = freq / entityCount;
    const idf = tf > 0.5 ? 0.5 : 1; // Discount very common tokens

    return clamp(tf * idf);
  }
};

export const delimiterContextIsolation: Feature = {
  id: 'token.context_isolation',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const line = ctx.lines[lineIndex]!;

    const left = line[start - 1] ?? '';
    const right = line[end] ?? '';

    // Check for various delimiters and whitespace
    const isDelimiter = (c: string) => /[\s,|:;\t]/.test(c);
    const score = (isDelimiter(left) ? 0.5 : 0) + (isDelimiter(right) ? 0.5 : 0);

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

    return clamp(1 - delta / POSITION_VARIANCE_SCALE);
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

// Capitalization pattern features
export const segmentAllCaps: Feature = {
  id: 'segment.all_caps',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    if (!text || text.length < 2) return 0;
    return text === text.toUpperCase() && /[A-Z]/.test(text) ? 1 : 0;
  }
};

export const segmentTitleCase: Feature = {
  id: 'segment.title_case',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    if (!text) return 0;
    const words = text.split(/\s+/);
    const titleCased = words.every(w => w.length > 0 && /^[A-Z][a-z]*/.test(w));
    return titleCased ? 1 : 0;
  }
};

export const segmentInitialCaps: Feature = {
  id: 'segment.initial_caps',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    if (!text) return 0;
    // Detect patterns like "J." or "J.D."
    return /^([A-Z]\.)+$/.test(text) ? 1 : 0;
  }
};

export const segmentMixedCase: Feature = {
  id: 'segment.mixed_case',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    if (!text || text.length < 2) return 0;
    const hasUpper = /[A-Z]/.test(text);
    const hasLower = /[a-z]/.test(text);
    return hasUpper && hasLower ? 0.5 : 0;
  }
};

// Character shape and pattern features
export const segmentDigitPattern: Feature = {
  id: 'segment.digit_pattern',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    if (!text) return 0;
    // Shape pattern: d=digit, a=alpha, x=other
    const shape = text.replace(/\d/g, 'd').replace(/[a-zA-Z]/g, 'a').replace(/[^da]/g, 'x');
    // Common patterns for dates, IDs, phones
    if (/^d+[x-]d+[x-]d+$/.test(shape)) return 0.8; // Date-like: dd-dd-dddd
    if (/^d{7,}$/.test(shape)) return 0.6; // Long number
    return 0;
  }
};

// Lexical/Gazetteer features
export const segmentContainsMonth: Feature = {
  id: 'segment.contains_month',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return containsMonth(text) ? 1 : 0;
  }
};

export const segmentContainsDaySuffix: Feature = {
  id: 'segment.contains_day_suffix',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return containsDaySuffix(text) ? 1 : 0;
  }
};

export const segmentCommonFirstName: Feature = {
  id: 'segment.common_first_name',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    return isCommonFirstName(text) ? 0.8 : 0;
  }
};

// Punctuation context features
export const segmentHasSpecialChars: Feature = {
  id: 'segment.has_special_chars',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    if (!text) return 0;
    return /[@#\-()_]/.test(text) ? 1 : 0;
  }
};

export const segmentPunctuationRatio: Feature = {
  id: 'segment.punctuation_ratio',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end);
    if (!text) return 0;
    const punctCount = (text.match(/[^\w\s]/g) || []).length;
    return clamp(punctCount / text.length);
  }
};

// Length-based features
export const segmentCharLengthBucket: Feature = {
  id: 'segment.char_length_bucket',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim();
    const len = text?.length ?? 0;
    if (len <= CHAR_LENGTH_THRESHOLDS.short) return 0.3;
    if (len <= CHAR_LENGTH_THRESHOLDS.medium) return 0.6;
    if (len <= CHAR_LENGTH_THRESHOLDS.long) return 0.8;
    return 0.5;
  }
};

// Prefix/Suffix features
export const segmentPrefix2: Feature = {
  id: 'segment.prefix_2',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim().toLowerCase();
    if (!text || text.length < 2) return 0;
    const prefix = text.substring(0, 2);
    // Common prefixes for names, IDs, etc.
    const commonPrefixes = ['dr', 'mr', 'ms', 'id', 'ph'];
    return commonPrefixes.includes(prefix) ? 0.5 : 0;
  }
};

export const segmentSuffix2: Feature = {
  id: 'segment.suffix_2',
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;
    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end).trim().toLowerCase();
    if (!text || text.length < 2) return 0;
    const suffix = text.substring(text.length - 2);
    // Common suffixes
    const commonSuffixes = ['jr', 'sr', 'id', 'er', 'ed'];
    return commonSuffixes.includes(suffix) ? 0.3 : 0;
  }
};

// =======================
// Dynamic file-level feature discovery
// =======================

export type Role = 'preceding' | 'leading' | 'trailing' | 'succeeding' | 'delimiter'

export type FeatureCandidate = {
  id: string
  kind: 'indent' | 'delimiter' | 'motif'
  pattern?: RegExp
  indentLevel?: number
  roles: Role[]
  examples: string[]
  count: number
  coverage: number
  salience?: number
}

export type FeatureAnalysis = {
  candidates: FeatureCandidate[]
  defaultWeights: Record<string, number>
}

import { analyzeSubstringRhythmicity } from './motif.js'
import { patternKeyForRegex } from './motif.js'

function addExample(array: string[], s: string, max = 3) {
  if (array.length >= max) return
  array.push(s)
}

export function analyzeFileLevelFeatures(input: string, opts?: { minSimpleLength?: number }) : FeatureAnalysis {
  const minSimpleLength = opts?.minSimpleLength ?? 5
  const lines = input.split(/\n/)

  // Indentation histogram
  const indents = new Map<number, number>()
  for (const l of lines) {
    const m = l.match(/^\s*/)
    const n = m ? m[0].length : 0
    indents.set(n, (indents.get(n) ?? 0) + 1)
  }

  // pick top indent levels (descending frequency) but skip zero indent
  const topIndents = [...indents.entries()].filter(([k]) => k > 0).sort((a,b) => b[1] - a[1]).slice(0,3).map(x => x[0])

  const candidates: FeatureCandidate[] = []

  for (const lvl of topIndents) {
    const examples: string[] = []
    let count = 0
    for (const l of lines) {
      if ((l.match(/^\s*/) ?? [''])[0].length === lvl) {
        count++
        addExample(examples, l.trim())
      }
    }
    candidates.push({ id: `indent:${lvl}`, kind: 'indent', indentLevel: lvl, roles: ['leading'], examples, count, coverage: count / Math.max(1, lines.length) })
  }

  // delimiter detection: empty lines, lines that are mostly repeated punctuation, and indent-resets
  const delimiterSamples = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    const trimmed = l.trim()
    if (!trimmed) {
      delimiterSamples.set('<blank>', (delimiterSamples.get('<blank>') ?? 0) + 1)
      continue
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      delimiterSamples.set(trimmed, (delimiterSamples.get(trimmed) ?? 0) + 1)
      continue
    }
    // indent reset: if previous indent > current and current is minimal indent
    if (i > 0) {
      const prev = ((lines[i-1] ?? '').match(/^\s*/) ?? [''])[0].length
      const curr = (l.match(/^\s*/) ?? [''])[0].length
      const minIndent = Math.min(...Array.from(indents.keys()))
      if (prev > curr && curr === minIndent) {
        delimiterSamples.set('<indent-reset>', (delimiterSamples.get('<indent-reset>') ?? 0) + 1)
      }
    }
  }

  for (const [k, v] of delimiterSamples.entries()) {
    const examples: string[] = []
    if (k === '<blank>') addExample(examples, '')
    else if (k === '<indent-reset>') addExample(examples, 'indent-reset')
    else addExample(examples, k)
    candidates.push({ id: `delimiter:${k}`, kind: 'delimiter', roles: ['delimiter'], examples, count: v, coverage: v / Math.max(1, lines.length) })
  }

  // motif-based candidates using existing motif analysis
  const analysis = analyzeSubstringRhythmicity(input, 1e-6, minSimpleLength)
  for (const m of analysis.motifs) {
    const key = patternKeyForRegex(m.pattern)
    const occs = analysis.occurrences.get(key) ?? []
    const examples: string[] = []
    let leading = 0, trailing = 0, delim = 0
    for (const o of occs.slice(0, 50)) {
      const pos = o.pos
      const len = o.len
      // find line start and end
      const lineStart = input.lastIndexOf('\n', pos) + 1
      const nextNewline = input.indexOf('\n', pos)
      const lineEnd = nextNewline === -1 ? input.length : nextNewline
      const sample = input.slice(pos, pos + len)
      addExample(examples, sample)
      if (pos === lineStart) leading++
      if (pos + len === lineEnd) trailing++
      if (sample.trim().length === (lineEnd - lineStart) || /^[-*_]{3,}$/.test(sample.trim())) delim++
    }
    const roles: Role[] = []
    if (leading / Math.max(1, occs.length) >= 0.6) roles.push('leading')
    if (trailing / Math.max(1, occs.length) >= 0.6) roles.push('trailing')
    if (delim / Math.max(1, occs.length) >= 0.6) roles.push('delimiter')
    if (roles.length === 0) roles.push('preceding')

    candidates.push({ id: `motif:${key}`, kind: 'motif', pattern: m.pattern, roles, examples, count: m.count, coverage: (m.count * m.minLength) / Math.max(1, input.length), salience: m.salience })
  }

  // compute default weights
  const defaultWeights: Record<string, number> = {}
  const roleMultiplier: Record<Role, number> = { delimiter: 1.2, leading: 1.0, preceding: 0.8, trailing: 0.8, succeeding: 0.8 }

  for (const c of candidates) {
    for (const r of c.roles) {
      const key = `${c.id}|${r}`
      const base = Math.log(1 + c.count)
      const sal = c.salience ?? 1
      const weight = Math.max(0.01, Math.min(5, base * sal * roleMultiplier[r]))
      defaultWeights[key] = weight
    }
  }

  return { candidates, defaultWeights }
}

// Convert FeatureCandidate to runtime Feature objects used by decoder/trainer
export function dynamicCandidatesToFeatures(cands: FeatureCandidate[]) {
  const boundaryFeatures: Feature[] = []
  const segmentFeatures: Feature[] = []

  for (const c of cands) {
    for (const r of c.roles) {
      const id = `dyn:${c.id}|${r}`

      if (r === 'delimiter') {
        // boundary-level feature: line matches delimiter
        const f: Feature = { id, apply(ctx) {
          const line = ctx.lines[ctx.lineIndex] ?? ''
          if (c.kind === 'delimiter') {
            if (c.examples.includes('') && line.trim() === '') return 1
            const pat = c.pattern ?? undefined
            if (pat) return pat.test(line) ? 1 : 0
            if (c.id.startsWith('delimiter:')) {
              const k = c.id.split(':')[1]
              if (k === '<indent-reset>') {
                // crude: check previous indent > current and current == min indent
                const prev = ctx.lines[ctx.lineIndex - 1] ?? ''
                const prevIndent = (prev.match(/^\s*/) ?? [''])[0].length
                const currIndent = (line.match(/^\s*/) ?? [''])[0].length
                const minIndent = 0
                return prevIndent > currIndent && currIndent === minIndent ? 1 : 0
              }
            }
          }
          if (c.kind === 'motif' && c.pattern) return c.pattern.test(line) ? 1 : 0
          return 0
        }}
        boundaryFeatures.push(f)
      } else {
        // segment-level features (preceding/leading/trailing)
        const sf: Feature = { id, apply(ctx) {
          if (!ctx.candidateSpan) return 0
          const { lineIndex, start, end } = ctx.candidateSpan
          const line = ctx.lines[lineIndex] ?? ''

          if (c.kind === 'indent' && c.indentLevel !== undefined) {
            const indent = (line.match(/^\s*/) ?? [''])[0].length
            if (r === 'leading') return indent === c.indentLevel ? 1 : 0
            return 0
          }

          if (c.kind === 'motif' && c.pattern) {
            // leading: pattern immediately before span start
            const beforeText = line.slice(0, start)
            const afterText = line.slice(end)
            if (r === 'leading') return c.pattern.test(line.slice(0, Math.min(line.length, start + 20))) ? 1 : 0
            if (r === 'trailing') return c.pattern.test(line.slice(Math.max(0, end - 20))) ? 1 : 0
            if (r === 'preceding') {
              // check if last match before start ends near start
              const g = new RegExp(c.pattern.source, c.pattern.flags.replace('g','') + 'g')
              let m: RegExpExecArray | null
              let lastEnd = -1
              while ((m = g.exec(beforeText)) !== null) lastEnd = m.index + m[0].length
              return (lastEnd >= 0 && start - lastEnd <= 2) ? 1 : 0
            }
            if (r === 'succeeding') {
              const g = new RegExp(c.pattern.source, c.pattern.flags.replace('g','') + 'g')
              let m: RegExpExecArray | null
              let firstStart = -1
              while ((m = g.exec(afterText)) !== null) { if (firstStart === -1) firstStart = m.index }
              return (firstStart >= 0 && firstStart <= 2) ? 1 : 0
            }
          }

          return 0
        }}
        segmentFeatures.push(sf)
      }
    }
  }

  return { boundaryFeatures, segmentFeatures }
}

export const segmentFeatures: Feature[] = [
  // put stronger signals up-front so they influence decoding earlier
  segmentIsExtID,
  segmentIsName,
  segmentIsPreferredName,
  segmentIsBirthdate,
  segmentIsEmail,
  segmentIsPhone,
  // Capitalization patterns
  segmentAllCaps,
  segmentTitleCase,
  segmentInitialCaps,
  segmentMixedCase,
  // Character patterns
  segmentDigitPattern,
  // Lexical features
  segmentContainsMonth,
  segmentContainsDaySuffix,
  segmentCommonFirstName,
  // Punctuation
  segmentHasSpecialChars,
  segmentPunctuationRatio,
  // Length
  segmentCharLengthBucket,
  // Prefix/Suffix
  segmentPrefix2,
  segmentSuffix2,
  // Original features
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

export const hasBirthdate: Feature = {
  id: 'line.has_birthdate',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    return isLikelyBirthdate(line) ? 1 : 0;
  }
};

export const hasKeyValuePattern: Feature = {
  id: 'line.has_key_value_pattern',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    // Generalized: detect any key-value pattern with colon separator
    if (/\b[A-Za-z][A-Za-z\s]{1,20}:\s*\S/.test(line)) return 1;
    return 0;
  }
};

export const hasListMarker: Feature = {
  id: 'line.has_list_marker',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    // Generalized list markers: bullets, numbers, letters
    if (/^\s*[*•○●■□◆◇▪▫→‣⁃]/.test(line)) return 1; // Various bullets
    if (/^\s*\d+[\.)]/.test(line)) return 0.8; // Numbered lists
    if (/^\s*[a-zA-Z][\.)]/.test(line)) return 0.7; // Lettered lists
    if (/^\s*[-–—]\s/.test(line)) return 0.6; // Dash bullets
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
    // Softer signal - return probability rather than binary
    let score = 0;
    if (isLikelyPhone(next)) score += 0.6;
    if (isLikelyEmail(next)) score += 0.6;
    // Check for contact keywords
    if (/phone|email|contact/i.test(next)) score += 0.3;
    return Math.min(score, 1);
  }
};

export const primaryLikely: Feature = {
  id: 'line.primary_likely',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';

    // Softer signals for primary entity detection
    let score = 0;
    if (/^\s*\d+\b/.test(line)) score += 0.4; // Leading number
    if (/\bID:/i.test(line)) score += 0.3; // ID label
    if (/^\s*[A-Za-z]+,\s*[A-Za-z]+/.test(line)) score += 0.4; // Last, First
    if (/\|/.test(line)) score += 0.2; // Table-like
    return Math.min(score, 1);
  }
};

export const guardianLikely: Feature = {
  id: 'line.guardian_likely',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';

    // Softer signals for guardian/secondary entity detection
    let score = 0;
    if (/\bparent\b|\bguardian\b/i.test(line)) score += 0.5;
    if (/\bmom\b|\bdad\b|\bfather\b|\bmother\b/i.test(line)) score += 0.4;
    if (/^\s*[*•○●■]\s*(?:Parent|Guardian)/i.test(line)) score += 0.3;
    return Math.min(score, 1);
  }
};

// Line-level aggregate features
export const lineFieldDensity: Feature = {
  id: 'line.field_density',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    if (!line.trim()) return 0;
    
    // Count likely fields on this line
    let fieldCount = 0;
    if (isLikelyExtID(line)) fieldCount++;
    if (isLikelyName(line)) fieldCount++;
    if (isLikelyEmail(line)) fieldCount++;
    if (isLikelyPhone(line)) fieldCount++;
    if (isLikelyBirthdate(line)) fieldCount++;
    
    // Dense lines (multiple fields) suggest data rows
    return clamp(fieldCount / 3);
  }
};

export const lineAvgTokenLength: Feature = {
  id: 'line.avg_token_length',
  apply(ctx) {
    const line = ctx.lines[ctx.lineIndex] ?? '';
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 0;
    
    const avgLen = tokens.reduce((sum, t) => sum + t.length, 0) / tokens.length;
    // Normalize: short tokens (1-3 chars) = 0, medium (4-8) = 0.5, long (9+) = 1
    return clamp((avgLen - 3) / 6);
  }
};

export const boundaryFeatures: Feature[] = [
  // order important: stronger signals first
  leadingExtID,
  hasNameLikelihood,
  hasBirthdate,
  hasKeyValuePattern,
  hasListMarker,
  shortTokenCount,
  nextHasContact,
  lineFieldDensity,
  lineAvgTokenLength,
  indentationDelta,
  lexicalSimilarityDrop,
  blankLine,
  // Hanging continuation is a useful boundary hint: treat next indented non-list
  // line as a continuation which favors a boundary on the preceding line.
  hangingContinuation,
  primaryLikely,
  guardianLikely
];