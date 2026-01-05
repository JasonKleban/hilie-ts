import type { FieldLabel, FieldSchema, FieldConfig, FeatureContext, JointState, LineSpans, BoundaryState, EnumerateOptions, FieldSpan, Feedback, JointSequence, RecordSpan, SubEntitySpan, SubEntityType, Feature } from './types.js';
import { boundaryFeatures, segmentFeatures } from './features.js';
import { normalizeFeedback } from './feedbackUtils.js';

interface VCell {
  score: number;
  prev: number | null;
}

/**
 * Compute a transition score between two joint states used by the Viterbi DP.
 *
 * Purpose: provide small hand-crafted biases for transitions between
 * boundary states (B/C). This helps the decoder prefer or penalize
 * starting a new record vs. continuing an existing one.
 *
 * Notes:
 * - Pulls optional override values from `weights['transition.*']` if present.
 * - Pure function: no side effects, returns a numeric score to add to a path.
 */
function transitionScore(prev: JointState, curr: JointState, weights: Record<string, number>): number {
  let score = 0;

  if (prev.boundary === 'B' && curr.boundary === 'B') {
    score += weights['transition.B_to_B'] ?? -0.5;
  }

  if (prev.boundary === 'C' && curr.boundary === 'C') {
    score += weights['transition.C_to_C'] ?? 0.3;
  }

  if (curr.boundary === 'B') {
    score += weights['transition.any_to_B'] ?? 0.4;
  }

  return score;
}

/**
 * Enumerate plausible per-line JointState assignments for a set of candidate spans.
 *
 * Responsibility: generate a bounded, practical search space of label assignments
 * for a single line's spans (used by `decodeJointSequence` when building the state
 * lattice). To avoid exponential blowup the function enforces caps such as
 * `maxUniqueFields`, per-field limits, and `maxStates`.
 *
 * Returns: an array of `JointState` objects (each with a `boundary` and a
 * `fields` array) representing candidate per-line assignments.
 *
 * @param spans - candidate spans for a single line
 * @param schema - field schema defining available fields and constraints
 * @param opts - optional state space constraints
 */
export function enumerateStates(
  spans: LineSpans,
  schema: FieldSchema,
  opts?: EnumerateOptions
): JointState[] {
  const states: JointState[] = [];

  const enumerateOpts = {
    maxUniqueFields: opts?.maxUniqueFields ?? 3,
    maxStatesPerField: opts?.maxStatesPerField ?? {},
    safePrefix: opts?.safePrefix ?? 8,
    maxStates: opts?.maxStates ?? 2048,
    whitespaceSpanIndices: opts?.whitespaceSpanIndices ?? new Set<number>(),
    forcedLabelsByLine: opts?.forcedLabelsByLine ?? {},
    forcedBoundariesByLine: opts?.forcedBoundariesByLine ?? {}
  };
  // Build repeatability set and per-field limits from schema
  const repeatable = new Set<FieldLabel>();
  const fieldMaxAllowed = new Map<FieldLabel, number>();

  for (const field of schema.fields) {
    const maxAllowed = field.maxAllowed ?? 1;
    fieldMaxAllowed.set(field.name, maxAllowed);
    if (maxAllowed > 1) {
      repeatable.add(field.name);
    }
  }

  // Build field list from schema (excluding NOISE)
  const fieldLabels = schema.fields.map(f => f.name);
  const noiseLabel = schema.noiseLabel;

  // To avoid exponential blowup, only enumerate over an initial prefix when the span count is large.
  const SAFE_PREFIX = enumerateOpts.safePrefix;
  const prefixLen = Math.min(spans.spans.length, SAFE_PREFIX);

  function countOccurrences(acc: string[], label: string) {
    return acc.filter(x => x === label).length;
  }

  function distinctNonNoiseCount(acc: string[]) {
    return new Set(acc.filter(x => x !== noiseLabel)).size;
  }

  /**
   * Recursive helper that enumerates combinations of field labels for spans.
   *
   * Purpose: perform depth-first generation of candidate `fields` arrays while
   *   enforcing caps (unique counts, per-label limits, overall maxStates) to
   *   keep the state space tractable.
   */
  function backtrack(i: number, acc: string[]) {
    // Global safety check: stop if we've reached the cap
    if (states.length >= enumerateOpts.maxStates) return;

    if (i === prefixLen) {
      // if we limited to a prefix, fill remaining positions with NOISE
      const tail = spans.spans.slice(prefixLen).map(() => noiseLabel);
      // Push states but guard against exceeding the cap
      const forcedBoundary = enumerateOpts.forcedBoundariesByLine?.[spans.lineIndex ?? -1];
    if (forcedBoundary !== undefined) {
      if (states.length < enumerateOpts.maxStates) states.push({ boundary: forcedBoundary as BoundaryState, fields: [...(acc as any), ...tail] });
    } else {
      if (states.length < enumerateOpts.maxStates) states.push({ boundary: 'B', fields: [...(acc as any), ...tail] });
      if (states.length < enumerateOpts.maxStates) states.push({ boundary: 'C', fields: [...(acc as any), ...tail] });
    }
      return;
    }

    // Check if current span is whitespace-only - if so, force it to NOISE
    if (enumerateOpts.whitespaceSpanIndices?.has(i)) {
      // Force whitespace spans to NOISE
      acc.push(noiseLabel);
      backtrack(i + 1, acc);
      acc.pop();
      return;
    }

    // If there is a forced label for this exact span (from feedback), only allow that label
    const forcedForLine = (enumerateOpts.forcedLabelsByLine ?? {})[spans.lineIndex ?? -1] ?? {};
    const spanKey = `${spans.spans[i]!.start}-${spans.spans[i]!.end}`;
    const forcedLabel = forcedForLine[spanKey];
    if (forcedLabel !== undefined) {
      // Only include the forced label (if schema contains it) or NOISE if it is the noise label
      if (forcedLabel === noiseLabel) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }
      // If forcedLabel is known in fieldLabels, accept it, otherwise fallback to noise
      if (!fieldLabels.includes(forcedLabel)) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }

      // Only attempt the forced label
      const f = forcedLabel;
      // enforce caps and per-field limits still apply
      const nonNoiseCount = distinctNonNoiseCount(acc);
      if (f !== noiseLabel && !repeatable.has(f) && acc.includes(f)) {
        // Can't add duplicate single-occurrence field; fall back to NOISE
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }

      if (f !== noiseLabel && !acc.includes(f) && nonNoiseCount >= enumerateOpts.maxUniqueFields) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }

      const fieldLimit = enumerateOpts.maxStatesPerField[f] ?? (fieldMaxAllowed.get(f) ?? 1);
      if (f !== noiseLabel && countOccurrences(acc, f) >= fieldLimit) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }

      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();
      return;
    }

    for (const f of fieldLabels) {
      // Another quick cap check to avoid unnecessary work
      if (states.length >= enumerateOpts.maxStates) return;

      const nonNoiseCount = distinctNonNoiseCount(acc);

      // Enforce uniqueness for single-occurrence labels
      if (f !== noiseLabel && !repeatable.has(f) && acc.includes(f)) continue;

      // Enforce max unique fields
      if (f !== noiseLabel && !acc.includes(f) && nonNoiseCount >= enumerateOpts.maxUniqueFields) continue;

      // Enforce per-label caps using schema maxAllowed
      const fieldLimit = enumerateOpts.maxStatesPerField[f] ?? (fieldMaxAllowed.get(f) ?? 1);
      if (f !== noiseLabel && countOccurrences(acc, f) >= fieldLimit) continue;

      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();

      // Safety: if we've generated a large number of states, bail out early.
      if (states.length >= enumerateOpts.maxStates) return;
    }

    // Also always include NOISE as an option
    if (states.length < enumerateOpts.maxStates) {
      acc.push(noiseLabel);
      backtrack(i + 1, acc);
      acc.pop();
    }
  }

  backtrack(0, []);

  // Enforce strict cap just in case generation slightly exceeded the threshold
  if (states.length > enumerateOpts.maxStates) states.length = enumerateOpts.maxStates;

  return states;
}

/**
 * Perform joint Viterbi decoding across document lines.
 *
 * Intent: simultaneously infer per-line boundary codes (`B` / `C`) and the
 * per-span field label assignments by building a dynamic programming lattice
 * over enumerated per-line state spaces.
 *
 * Behavior:
 * - Precomputes boundary and segment feature contributions and emission scores
 *   to keep the inner loop efficient.
 * - Uses `transitionScore` to bias transitions between `JointState`s.
 *
 * Returns: the best-scoring `JointSequence` (one entry per input line).
 */
export function decodeJointSequence(
  lines: string[],
  spansPerLine: LineSpans[],
  featureWeights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  enumerateOpts?: EnumerateOptions
): JointSequence {
  const lattice: VCell[][] = [];
  const stateSpaces: JointState[][] = [];

  // Precompute state spaces
  for (let t = 0; t < spansPerLine.length; t++) {
    const spans = spansPerLine[t]!;
    
    // Identify whitespace-only spans to force them to NOISE during enumeration
    const whitespaceSpanIndices = new Set<number>();
    for (let i = 0; i < spans.spans.length; i++) {
      const span = spans.spans[i]!;
      const spanText = lines[t]?.slice(span.start, span.end) ?? '';
      if (/^\s*$/.test(spanText)) {
        whitespaceSpanIndices.add(i);
      }
    }
    
    stateSpaces.push(enumerateStates(spans, schema, { ...enumerateOpts, whitespaceSpanIndices }));
  }

  // Precompute boundary feature contributions (per-line) and per-span segment feature caches to avoid repeated expensive computations
  const boundaryBase: number[] = []; // sum w * v for boundary features at each line
  const spanFeatureCache: Array<Array<Record<string, number>>> = []; // [line][spanIndex][featureId] = value
  const spanTextCache: Array<string[]> = []; // [line][spanIndex] = text
  const spanExact10or11: Array<boolean[]> = [];

  for (let t = 0; t < lines.length; t++) {
    const ctxBase: FeatureContext = { lineIndex: t, lines };

    // boundary features base
    let bsum = 0;
    for (const f of boundaryFeaturesArg) {
      const v = f.apply(ctxBase);
      const w = featureWeights[f.id] ?? 0;
      bsum += w * v;
    }
    boundaryBase[t] = bsum;

    // per-span caches
    const spans = spansPerLine[t]!;
    const spanFeatArray: Array<Record<string, number>> = [];
    const textArray: string[] = [];
    const exactArray: boolean[] = [];

    for (let si = 0; si < (spans?.spans.length ?? 0); si++) {
      const span = spans.spans[si]!;
      const sctx: FeatureContext = { lineIndex: t, lines, candidateSpan: { lineIndex: t, start: span.start, end: span.end } };
      const featsRec: Record<string, number> = {};

      for (const f of segmentFeaturesArg) {
        featsRec[f.id] = f.apply(sctx);
      }

      const txt = sctx.candidateSpan ? lines[t]?.slice(sctx.candidateSpan.start, sctx.candidateSpan.end) ?? '' : '';
      const exact = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));

      spanFeatArray.push(featsRec);
      textArray.push(txt);
      exactArray.push(exact);
    }

    spanFeatureCache.push(spanFeatArray);
    spanTextCache.push(textArray);
    spanExact10or11.push(exactArray);
  }

  // Precompute emission scores per (t, stateIndex) to avoid recomputing them in the inner DP loop
  const emissionScores: Array<number[]> = [];

  for (let t = 0; t < lines.length; t++) {
    emissionScores[t] = [];
    const spans = spansPerLine[t]!;
    for (let si = 0; si < stateSpaces[t]!.length; si++) {
      const s = stateSpaces[t]![si]!;

      // boundary contribution: B => +base, C => -base
      const bbase = boundaryBase[t] ?? 0;
      const bcontrib = s.boundary === 'B' ? bbase : -bbase;

      // field contribution using cached span features
      let fcontrib = 0;
      for (let k = 0; k < s.fields.length; k++) {
        const label = s.fields[k];
        const txt: string = spanTextCache[t]?.[k] ?? '';
        
        // Whitespace spans are already forced to NOISE during enumeration, so no penalty needed here
        
        if (label === schema.noiseLabel) continue;
        const featsRec: Record<string, number> = spanFeatureCache[t]?.[k] ?? {};
        const exact10or11: boolean = spanExact10or11[t]?.[k] ?? false;

        for (const fid of Object.keys(featsRec)) {
          const w = featureWeights[fid] ?? 0;
          const v = featsRec[fid] ?? 0;

          // Label-aware scoring: boost when label matches feature signal
          if (fid === 'segment.is_phone') {
            fcontrib += (label === 'Phone') ? w * v : -0.5 * w * v;
          } else if (fid === 'segment.is_email') {
            fcontrib += (label === 'Email') ? w * v : -0.5 * w * v;
          } else if (fid === 'segment.is_extid') {
            if (exact10or11) {
              fcontrib += (label === 'ExtID') ? -0.8 * w * v : (label === 'Phone' ? 0.7 * w * v : -0.3 * w * v);
            } else {
              fcontrib += (label === 'ExtID') ? w * v : -0.5 * w * v;
            }
          } else if (fid === 'segment.is_name') {
            fcontrib += (label === 'Name') ? w * v : -0.5 * w * v;
          } else if (fid === 'segment.is_preferred_name') {
            fcontrib += (label === 'PreferredName') ? w * v : -0.5 * w * v;
          } else if (fid === 'segment.is_birthdate') {
            fcontrib += (label === 'Birthdate') ? w * v : -0.5 * w * v;
          } else {
            fcontrib += w * v;
          }
        }
      }

      emissionScores[t]![si] = bcontrib + fcontrib;
    }
  }

  // initialize first time step with emission scores so boundary features at line 0 are considered
  // small bias toward starting a record on the first non-empty line to avoid misclassifying
  // the initial row (e.g., case3.txt) as a continuation and losing its spans entirely
  const startLineHasContent = (lines[0]?.trim().length ?? 0) > 0;
  const startBoundaryBias = startLineHasContent ? 0.75 : 0;

  lattice[0] = stateSpaces[0]?.map((s, idx) => {
    const baseScore = emissionScores[0]![idx] ?? -Infinity;
    const bias = s.boundary === 'B' ? startBoundaryBias : 0;
    return { score: baseScore + bias, prev: null };
  }) ?? [];

  for (let t = 1; t < lines.length; t++) {
    lattice[t] = [];

    for (let i = 0; i < stateSpaces[t]!.length; i++) {
      let bestScore = -Infinity;
      let bestPrev: number | null = null;

      // emission score for this state is precomputed
      const emit = emissionScores[t]![i] ?? -Infinity;

      for (let j = 0; j < stateSpaces[t - 1]!.length; j++) {
        const trans = transitionScore(stateSpaces[t - 1]![j]!, stateSpaces[t]![i]!, featureWeights);
        const score = lattice[t - 1]![j]!.score + trans + emit;

        if (score > bestScore) {
          bestScore = score;
          bestPrev = j;
        }
      }

      lattice[t]![i] = { score: bestScore, prev: bestPrev };
    }
  }

  let lastIndex = lattice[lines.length - 1]!.map((c, i) => ({ i, score: c.score })).sort((a, b) => b.score - a.score)[0]!.i;
  const path: JointState[] = [];

  for (let t = lines.length - 1; t >= 0; t--) {
    path.unshift(stateSpaces[t]![lastIndex]!);
    lastIndex = lattice[t]![lastIndex]!.prev!;
  }

  return path;
}

/**
 * Extract a feature vector from a joint assignment (gold or predicted).
 *
 * Purpose: compute an additive feature vector (mapping id -> numeric count)
 * by summing boundary-level and span-level feature contributions according to
 * the labels present in the provided `JointSequence` so that learning updates can compare
 * gold vs. predicted vectors.
 *
 * Returns: a sparse map from feature id to numeric contribution.
 */
export function extractJointFeatureVector(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema
): Record<string, number> {
  const vec: Record<string, number> = {};

  // boundary features (line-level)
  for (let i = 0; i < jointSeq.length; i++) {
    const state = jointSeq[i]!;
    const ctx: FeatureContext = { lineIndex: i, lines };
    for (const f of boundaryFeaturesArg) {
      const v = f.apply(ctx);
      const contrib = state.boundary === 'B' ? v : -v;
      vec[f.id] = (vec[f.id] ?? 0) + contrib;
    }
  }

  // segment features (span-level)
  for (let i = 0; i < jointSeq.length; i++) {
    const state = jointSeq[i]!;
    const spans = spansPerLine[i]!;

    for (let si = 0; si < spans.spans.length; si++) {
      const span = spans.spans[si]!;
      const label = state.fields[si];
      const ctx: FeatureContext = { lineIndex: i, lines, candidateSpan: { lineIndex: i, start: span.start, end: span.end } };

      for (const f of segmentFeaturesArg) {
        const v = f.apply(ctx);
        let contrib = v;

        const spanText = ctx.candidateSpan ? ctx.lines[ctx.candidateSpan.lineIndex]?.slice(ctx.candidateSpan.start, ctx.candidateSpan.end) ?? '' : '';
        const exact10or11Digits = /^\d{10,11}$/.test(spanText.replace(/\D/g, ''));

        if (f.id === 'segment.is_phone') {
          contrib = label === 'Phone' ? v : -0.5 * v;
        } else if (f.id === 'segment.is_email') {
          contrib = label === 'Email' ? v : -0.5 * v;
        } else if (f.id === 'segment.is_extid') {
          if (exact10or11Digits) {
            contrib = (label === 'ExtID') ? -0.8 * v : (label === 'Phone') ? 0.7 * v : -0.3 * v;
          } else {
            contrib = label === 'ExtID' ? v : -0.5 * v;
          }
        } else if (f.id === 'segment.is_name') {
          contrib = label === 'Name' ? v : -0.5 * v;
        } else if (f.id === 'segment.is_preferred_name') {
          contrib = label === 'PreferredName' ? v : -0.5 * v;
        } else if (f.id === 'segment.is_birthdate') {
          contrib = label === 'Birthdate' ? v : -0.5 * v;
        }

        vec[f.id] = (vec[f.id] ?? 0) + contrib;
      }
    }
  }

  return vec;
}

/**
 * Heuristically assign `entityType` hints (Primary / Guardian / Unknown) to
 * lines marked as record boundaries.
 *
 * Intent: use lightweight boundary features and role-keyword signals to label
 * boundary lines with likely entity roles, then enforce simple contiguity
 * constraints (e.g., Guardians should have a nearby Primary). Returns a new
 * `JointSequence` array with `entityType` set for boundary entries.
 */
export function annotateEntityTypesInSequence(lines: string[], jointSeq: JointSequence, boundaryFeaturesArg?: Feature[]): JointSequence {
  // Use provided boundary features or fall back to global ones
  const bFeatures = boundaryFeaturesArg ?? boundaryFeatures;
  
  // Compute per-line feature scores using boundary features
  const featuresPerLine: Record<number, Record<string, number>> = {};

  for (let i = 0; i < jointSeq.length; i++) {
    const ctx: FeatureContext = { lineIndex: i, lines };
    const feats: Record<string, number> = {};
    for (const f of bFeatures) {
      feats[f.id] = f.apply(ctx);
    }
    // Also add quick regex-derived guardian token flag
    const line = lines[i] ?? '';
    feats['line.role_keyword'] = /\bParent\b|\bGuardian\b|\bGrandparent\b|\bAunt\/Uncle\b|\bFoster\b|\bEmergency Contact\b/i.test(line) ? 1 : 0;

    featuresPerLine[i] = feats;
  }

  // Scoring weights (hand-tuned). Primary vs Guardian
  const primaryWeights: Record<string, number> = {
    'line.primary_likely': 2.0,
    'line.leading_extid': 1.6,
    'line.has_name': 1.6,
    'line.has_preferred': 1.2,
    'line.has_birthdate': 1.0,
    'line.has_label': 1.0,
    'line.next_has_contact': 1.2,
    'line.short_token_count': 0.6,
    'line.leading_structural': 0.2,
    'line.indentation_delta': 0.2
  };

  const guardianWeights: Record<string, number> = {
    'line.guardian_likely': 2.0,
    'line.role_keyword': 2.0,
    'line.leading_structural': 0.6,
    'line.has_label': 0.4,
    'line.short_token_count': 0.2
  };

  // Initial label assignments based on scores
  const assigned = jointSeq.map((s) => ({ ...s }));

  for (let i = 0; i < assigned.length; i++) {
    const cell = assigned[i]!;
    if (!cell || cell.boundary !== 'B') {
      if (cell) cell.entityType = 'Unknown';
      continue;
    }

    const feats = featuresPerLine[i] ?? {};
    let pScore = 0;
    let gScore = 0;

    for (const k of Object.keys(feats)) {
      pScore += (primaryWeights[k] ?? 0) * (feats[k] ?? 0);
      gScore += (guardianWeights[k] ?? 0) * (feats[k] ?? 0);
    }

    // tie-breaker: name presence increases primary
    if ((feats['line.has_name'] ?? 0) > 0) pScore += 0.5;

    if (pScore >= 1.0 && pScore > gScore) cell.entityType = 'Primary';
    else if (gScore >= 0.8 && gScore >= pScore) cell.entityType = 'Guardian';
    else cell.entityType = 'Unknown';
  }

  // Enforce adjacency/contiguity constraints: a Guardian must have a nearby Primary (preceding preferred)
  const MAX_DISTANCE = 3;

  for (let i = 0; i < assigned.length; i++) {
    const cell = assigned[i]!;
    if (!cell || cell.entityType !== 'Guardian') continue;

    // look for nearest preceding Primary within MAX_DISTANCE
    let foundPrimary: number | null = null;
    for (let d = 1; d <= MAX_DISTANCE; d++) {
      const j = i - d;
      if (j < 0) break;
      const other = assigned[j]!;
      if (other && other.entityType === 'Primary') { foundPrimary = j; break; }
      // stop if we encounter a non-empty boundary that is Primary/Guardian? Given contiguity assumption, break if not contiguous
      if (other && other.boundary !== 'B') break;
    }

    // also allow following Primary if not found earlier (rare but possible)
    if (foundPrimary === null) {
      for (let d = 1; d <= 1; d++) {
        const j = i + d;
        if (j >= assigned.length) break;
        const other = assigned[j]!;
        if (other && other.entityType === 'Primary') { foundPrimary = j; break; }
        if (other && other.boundary !== 'B') break;
      }
    }

    if (foundPrimary === null) {
      // no nearby primary found — mark Unknown to avoid spurious Guardians
      cell.entityType = 'Unknown';
    }
  }

  return assigned;
}

/**
 * Convert a joint decode into a structured collection of records and sub-entities.
 *
 * Purpose: take a predicted or gold `JointSequence` (per-line boundary+fields assignments)
 * and produce an array of `RecordSpan` objects where each top-level record contains
 * grouped `SubEntitySpan` children (Primary/Guardian) with `FieldSpan` entries.
 * The function computes file-relative offsets, per-field confidences (when
 * `featureWeights` are provided), and skips `Unknown` sub-entities.
 *
 * Parameters:
 * - lines: array of document lines
 * - spansPerLine: candidate spans for each line
 * - jointSeq: per-line `JointSequence` assignments (may or may not include entityType)
 * - featureWeights: optional weights used to compute softmax confidences per field
 * - segmentFeaturesArg: segment-level features
 * - schema: field schema
 *
 * Returns: a `RecordSpan[]` describing the inferred records and their sub-entities.
 */
export function entitiesFromJointSequence(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  featureWeights: Record<string, number> | undefined,
  segmentFeaturesArg: Feature[],
  schema: FieldSchema
): RecordSpan[] {
  // compute line offsets
  const offsets: number[] = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(off);
    off += (lines[i]?.length ?? 0) + 1; // assume '\n' separator
  }

  /**
   * Compute a label-specific score for a single candidate span (used when
   * converting a joint into `RecordSpan[]` or to compute confidence via softmax).
   *
   * Notes: mirrors the emission-style label-aware weighting logic used by the
   * decoder so confidence estimates align with model scoring.
   */
  // helper to score labels for a single span
  function scoreLabelForSpan(lineIndex: number, spanIdx: number, label: FieldLabel): number {
    const sctx: FeatureContext = { lineIndex, lines, candidateSpan: { lineIndex, start: spansPerLine[lineIndex]!.spans[spanIdx]!.start, end: spansPerLine[lineIndex]!.spans[spanIdx]!.end } };
    const txt = lines[lineIndex]?.slice(sctx.candidateSpan!.start, sctx.candidateSpan!.end) ?? '';
    
    // Whitespace-only spans should always be NOISE
    const isWhitespace = /^\s*$/.test(txt);
    if (isWhitespace && label !== schema.noiseLabel) {
      return -100; // Large penalty for labeling whitespace as non-NOISE
    }
    
    let score = 0;
    for (const f of segmentFeaturesArg) {
      const v = f.apply(sctx);
      const w = (featureWeights && featureWeights[f.id]) ?? 0;
      // label-aware scoring like in fieldEmissionScore
      if (f.id === 'segment.is_phone') {
        score += (label === 'Phone') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_email') {
        score += (label === 'Email') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_extid') {
        const txt = lines[lineIndex]?.slice(sctx.candidateSpan!.start, sctx.candidateSpan!.end) ?? '';
        const exact = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));
        if (exact) {
          score += (label === 'ExtID') ? -0.8 * w * v : (label === 'Phone' ? 0.7 * w * v : -0.3 * w * v);
        } else {
          score += (label === 'ExtID') ? w * v : -0.5 * w * v;
        }
      } else if (f.id === 'segment.is_name') {
        score += (label === 'Name') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_preferred_name') {
        score += (label === 'PreferredName') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_birthdate') {
        score += (label === 'Birthdate') ? w * v : -0.5 * w * v;
      } else {
        score += w * v;
      }
    }
    return score;
  }

  const records: RecordSpan[] = [];

  // If entityType is not present in the joint sequence, annotate it using heuristics
  const jointAnnotated = (!jointSeq.some(s => s && s.entityType !== undefined)) ? annotateEntityTypesInSequence(lines, jointSeq) : jointSeq;
  const jointLocal = jointAnnotated;

  // find entity boundaries from joint states (lines with boundary === 'B')
  for (let i = 0; i < jointLocal.length; i++) {
    if (jointLocal[i]!.boundary !== 'B') continue;
    // record runs until next line with boundary === 'B' or end of document
    let j = i + 1;
    while (j < jointLocal.length && jointLocal[j]!.boundary !== 'B') j++;
    const startLine = i;
    const endLine = j - 1;

    // We will construct sub-entities inside this top-level record by grouping
    // contiguous lines with the same annotated entityType (Primary/Guardian/Unknown).
    const subEntities: SubEntitySpan[] = [];

    for (let li = startLine; li <= endLine; li++) {
      const role = ((jointLocal[li] && jointLocal[li]!.entityType) ? (jointLocal[li]!.entityType as SubEntityType) : 'Unknown');
      // Ignore Unknown roles when constructing sub-entities (noise lines should not create sub-entities)
      if (role === 'Unknown') continue;
      const spans = spansPerLine[li]?.spans ?? [];

      // collect fields for this line
      const lineFields: FieldSpan[] = [];
      for (let si = 0; si < spans.length; si++) {
        const s = spans[si]!;
        const fileStart = offsets[li]! + s.start;
        const fileEnd = offsets[li]! + s.end;
        const text = lines[li]?.slice(s.start, s.end) ?? '';
        const assignedLabel = (jointSeq[li] && jointSeq[li]!.fields && jointSeq[li]!.fields[si]) ? jointSeq[li]!.fields[si] : undefined;

        // compute confidence via softmax over label scores if weights provided
        let confidence = 0.5; // default to moderate confidence when weights not provided
        if (featureWeights) {
          const labelScores: number[] = [];
          const labels: FieldLabel[] = schema.fields.map(f => f.name).concat(schema.noiseLabel);
          for (const lab of labels) labelScores.push(scoreLabelForSpan(li, si, lab));
          const max = Math.max(...labelScores);
          const exps = labelScores.map(sv => Math.exp(sv - max));
          const ssum = exps.reduce((a,b) => a+b, 0);
          const probs = exps.map(e => e / ssum);
          const idx = labels.indexOf(assignedLabel ?? schema.noiseLabel);
          confidence = probs[idx] ?? 0;
        }

        lineFields.push({ lineIndex: li, start: s.start, end: s.end, text, fileStart, fileEnd, fieldType: assignedLabel, confidence });
      }

      // Either append to the last sub-entity (if same role) or start a new one
      const last = subEntities[subEntities.length - 1];
      if (last && last.entityType === role) {
        // extend range
        last.endLine = li;
        last.fileEnd = (offsets[li] ?? 0) + ((lines[li]?.length) ?? 0);
        // set entity-relative positions later; for now append fields
        for (const f of lineFields) last.fields.push(f);
      } else {
        const fileStart = offsets[li] ?? 0;
        const fileEnd = (offsets[li] ?? 0) + ((lines[li]?.length) ?? 0);
        subEntities.push({ startLine: li, endLine: li, fileStart, fileEnd, entityType: role, fields: lineFields });
      }
    }

    // set entity-relative positions for fields within each subEntity
    for (const se of subEntities) {
      const recFileStart = offsets[startLine] ?? 0;
      for (const f of se.fields) {
        f.entityStart = f.fileStart - recFileStart;
        f.entityEnd = f.fileEnd - recFileStart;
      }
    }

    const fileStart = offsets[startLine] ?? 0;
    const fileEnd = (offsets[endLine] ?? 0) + ((lines[endLine]?.length) ?? 0);

    records.push({ startLine, endLine, fileStart, fileEnd, subEntities });
  }

  return records;
}

/**
 * Decode a joint sequence while honoring user feedback constraints.
 *
 * Unlike `updateWeightsFromUserFeedback`, this does not modify weights.
 * It applies feedback as hard constraints (span additions/removals + forced
 * labels + record-boundary constraints + sub-entity type ranges) so callers can
 * re-run decoding without losing asserted spans.
 */
export function decodeJointSequenceWithFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  feedback: Feedback,
  enumerateOpts?: EnumerateOptions
): { pred: JointSequence; spansPerLine: LineSpans[] } {
  const normalizedFeedback = normalizeFeedback(feedback);
  const feedbackEntities = normalizedFeedback.entities;
  const recordAssertions = normalizedFeedback.records;
  const feedbackSubEntities = normalizedFeedback.subEntities;

  const spansCopy: LineSpans[] = spansPerLine.map(s => ({
    lineIndex: s.lineIndex,
    spans: s.spans.map(sp => ({ start: sp.start, end: sp.end }))
  }));

  function ensureLine(li: number) {
    if (li < 0 || li >= spansCopy.length) return false;
    spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] };
    return true;
  }

  function findSpanIndex(lineIdx: number, start?: number, end?: number) {
    const s = spansCopy[lineIdx];
    if (!s) return -1;
    if (start === undefined || end === undefined) return -1;
    return s.spans.findIndex(x => x.start === start && x.end === end);
  }

  // Apply feedback span add/remove operations and build forced label map
  const labelMap: Record<string, FieldLabel> = {}; // key = `${line}:${start}-${end}`

  for (const ent of feedbackEntities ?? []) {
    const entStartLine = ent.startLine ?? null;
    for (const f of ent.fields ?? []) {
      const li = (f.lineIndex ?? entStartLine);
      if (li === null || li === undefined) continue;
      if (!ensureLine(li)) continue;

      const action = f.action ?? 'add';
      if (action === 'remove') {
        const idx = findSpanIndex(li, f.start, f.end);
        if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1);
        continue;
      }

      // add/assert: ensure the span exists
      const idx = findSpanIndex(li, f.start, f.end);
      if (idx < 0 && f.start !== undefined && f.end !== undefined) {
        spansCopy[li]!.spans.push({ start: f.start, end: f.end });
        spansCopy[li]!.spans.sort((a, b) => a.start - b.start);
      }

      if (f.fieldType && f.start !== undefined && f.end !== undefined) {
        labelMap[`${li}:${f.start}-${f.end}`] = f.fieldType;
      }
    }
  }

  const forcedLabelsByLine: Record<number, Record<string, FieldLabel>> = {};
  for (const [key, lab] of Object.entries(labelMap)) {
    const [lineStr, range] = key.split(':');
    if (!range) continue;
    const lineIdx = Number(lineStr);
    if (Number.isNaN(lineIdx)) continue;
    const map = forcedLabelsByLine[lineIdx] ?? (forcedLabelsByLine[lineIdx] = {});
    map[range] = lab;
  }

  // Forced boundaries from explicit record assertions only
  const forcedBoundariesByLine: Record<number, BoundaryState> = {};
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined) continue;
    if (r.startLine < 0 || r.startLine >= spansCopy.length) continue;
    forcedBoundariesByLine[r.startLine] = 'B';
    const lastLine = (r.endLine !== undefined && r.endLine >= r.startLine) ? r.endLine : (spansCopy.length - 1);
    const boundedLast = Math.min(lastLine, spansCopy.length - 1);
    for (let li = r.startLine + 1; li <= boundedLast; li++) forcedBoundariesByLine[li] = 'C';
  }
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined || r.endLine === undefined) continue;
    if (r.endLine < r.startLine) continue;
    const nextLine = r.endLine + 1;
    if (nextLine >= 0 && nextLine < spansCopy.length) {
      forcedBoundariesByLine[nextLine] = 'B';
    }
  }

  // Apply sub-entity type assertions across full ranges
  const entityTypeMap: Record<number, SubEntityType> = {};
  for (const ent of feedbackSubEntities ?? []) {
    if (ent.startLine === undefined || ent.entityType === undefined) continue;
    const startLine = ent.startLine;
    const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine;
    const boundedEnd = Math.min(endLine, spansCopy.length - 1);
    for (let li = startLine; li <= boundedEnd; li++) {
      entityTypeMap[li] = ent.entityType as SubEntityType;
    }
  }

  // Expand safePrefix when feedback targets spans beyond the default prefix.
  let maxAssertedSpanIdx = -1;
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? ent.startLine;
      if (li === undefined || li === null) continue;
      if (li < 0 || li >= spansCopy.length) continue;
      const idx = spansCopy[li]?.spans.findIndex(sp => sp.start === f.start && sp.end === f.end) ?? -1;
      if (idx > maxAssertedSpanIdx) maxAssertedSpanIdx = idx;
    }
  }

  const finalEnumerateOpts: EnumerateOptions | undefined = (() => {
    const base = enumerateOpts ?? {};
    const safePrefix = (maxAssertedSpanIdx < 0)
      ? base.safePrefix
      : Math.max((base.safePrefix ?? 8), maxAssertedSpanIdx + 1);
    return {
      ...base,
      ...(safePrefix !== undefined ? { safePrefix } : {}),
      forcedLabelsByLine,
      forcedBoundariesByLine
    } as EnumerateOptions;
  })();

  const pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, finalEnumerateOpts);

  // Ensure returned prediction reflects explicit sub-entity type assertions.
  for (let li = 0; li < pred.length; li++) {
    const forcedType = entityTypeMap[li];
    if (!forcedType) continue;
    pred[li] = { ...(pred[li] ?? { boundary: 'C', fields: [] }), entityType: forcedType };
  }

  return { pred, spansPerLine: spansCopy };
}

/**
 * Update model weights using user feedback (fields added or removed).
 *
 * Purpose: incorporate sparse user corrections by updating weights based on
 * explicitly added/removed spans. Spans not mentioned in feedback are treated
 * as implicitly correct and receive stabilization boosts when predictions remain
 * consistent, preventing weight drift and promoting convergence.
 *
 * Behavior:
 * - Processes only explicitly corrected spans (add/remove actions)
 * - Applies perceptron-style updates for corrections
 * - Provides stabilization: spans that match original prediction and weren't
 *   corrected receive small positive reinforcement (controlled by stabilizationFactor)
 * - Supports targeted nudges when straightforward updates don't flip predictions
 *
 * Parameters:
 * - lines: the document lines
 * - spansPerLine: candidate spans per line (may be modified internally)
 * - jointSeq: current predicted joint assignment
 * - feedback: user-supplied feedback with entity/field add/remove assertions
 * - weights: mutable feature weight map to be updated in-place
 * - boundaryFeaturesArg: boundary-level features
 * - segmentFeaturesArg: segment-level features
 * - schema: field schema
 * - learningRate: default 1.0
 * - enumerateOpts: optional enumeration constraints passed to the decoder
 * - stabilizationFactor: boost factor for uncorrected spans (default 0.15)
 *
 * Returns: object containing the updated weights and the post-update prediction.
 */
export function updateWeightsFromUserFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  feedback: Feedback,
  weights: Record<string, number>,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  learningRate = 1.0,
  enumerateOpts?: EnumerateOptions,
  stabilizationFactor = 0.15
): { updated: Record<string, number>; pred: JointSequence; spansPerLine?: LineSpans[] } {
  const normalizedFeedback = normalizeFeedback(feedback);
  const feedbackEntities = normalizedFeedback.entities;
  const feedbackSubEntities = normalizedFeedback.subEntities;
  const recordAssertions = normalizedFeedback.records;
  const subEntityAssertions = normalizedFeedback.subEntities;

  // Clone spans so we can modify
  const spansCopy: LineSpans[] = spansPerLine.map(s => ({ lineIndex: s.lineIndex, spans: s.spans.map(sp => ({ start: sp.start, end: sp.end })) }));

  // Track which spans were explicitly mentioned in feedback for stabilization pass
  const feedbackTouchedSpans = new Set<string>();

  // apply feedback: additions/removals
  let confs: number[] = [];

  // helper to find matching span index by line/start/end
  function findSpanIndex(lineIdx: number, start?: number, end?: number) {
    const s = spansCopy[lineIdx];
    if (!s) return -1;
    if (start === undefined || end === undefined) return -1;
    return s.spans.findIndex(x => x.start === start && x.end === end);
  }

  for (const ent of feedbackEntities ?? []) {
    const entStartLine = ent.startLine ?? null;

    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? entStartLine;
      if (li === null || li === undefined) continue;
      
      // Mark this span as touched by feedback
      const spanKey = `${li}:${f.start}-${f.end}`;
      feedbackTouchedSpans.add(spanKey);
      
      const action = f.action ?? 'add';
      if (action === 'remove') {
        const idx = findSpanIndex(li, f.start, f.end);
        if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1);
        if (f.confidence !== undefined) confs.push(f.confidence);
      } else {
        // add or assert: ensure span exists
        const idx = findSpanIndex(li, f.start, f.end);
        if (idx < 0) {
          // insert and keep sorted
          spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] };
          spansCopy[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 });
          spansCopy[li]!.spans.sort((a, b) => a.start - b.start);
        }
        if (f.confidence !== undefined) confs.push(f.confidence);
      }
    }
  }

  const meanConf = confs.length ? confs.reduce((a,b)=>a+b,0)/confs.length : 1.0;

  // Expand safePrefix when feedback targets spans beyond the default prefix.
  let maxAssertedSpanIdx = -1;
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? ent.startLine;
      if (li === undefined || li === null) continue;
      const idx = spansCopy[li]?.spans.findIndex(sp => sp.start === f.start && sp.end === f.end) ?? -1;
      if (idx > maxAssertedSpanIdx) maxAssertedSpanIdx = idx;
    }
  }

  const effEnumerateOpts: EnumerateOptions | undefined = (() => {
    if (maxAssertedSpanIdx < 0) return enumerateOpts;
    const safePrefix = Math.max((enumerateOpts?.safePrefix ?? 8), maxAssertedSpanIdx + 1);
    return { ...enumerateOpts, safePrefix };
  })();


  // Build gold JointState[] aligned with spansCopy
  const gold: JointState[] = [];

  // create a quick mapping from feedback assertions to labels per-line/start/end
  const labelMap: Record<string, FieldLabel> = {}; // key = `${line}:${start}-${end}`
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      if (f.action === 'remove') continue;
      if (f.fieldType) {
        const li = f.lineIndex ?? ent.startLine;
        if (li === undefined) continue;
        const key = `${li}:${f.start}-${f.end}`;
        labelMap[key] = f.fieldType;
      }
    }
  }

  // Map explicit entityType assertions (sub-entity type) from feedback
  const entityTypeMap: Record<number, SubEntityType> = {};
  for (const ent of feedbackSubEntities ?? []) {
    if (ent.startLine === undefined || ent.entityType === undefined) continue;
    const startLine = ent.startLine;
    const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine;
    const boundedEnd = Math.min(endLine, spansCopy.length - 1);
    for (let li = startLine; li <= boundedEnd; li++) {
      entityTypeMap[li] = ent.entityType as SubEntityType;
    }
  }

  // Determine boundary choices: prefer explicit record assertions when provided,
  // otherwise fall back to the provided joint sequence.
  const boundarySet = new Set<number>();
  for (const r of recordAssertions ?? []) {
    if (r.startLine !== undefined) boundarySet.add(r.startLine);
  }

  // Build forced boundary map from explicit *record* ranges.
  // IMPORTANT: sub-entity assertions must NOT force boundary 'B' at their
  // startLine, otherwise they would incorrectly split an asserted record.
  const forcedBoundariesByLine: Record<number, BoundaryState> = {};
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined) continue;
    forcedBoundariesByLine[r.startLine] = 'B';
    const lastLine = (r.endLine !== undefined && r.endLine >= r.startLine) ? r.endLine : (spansCopy.length - 1);
    for (let li = r.startLine + 1; li <= lastLine; li++) {
      forcedBoundariesByLine[li] = 'C';
    }
  }

  // If the user asserts an explicit record range, treat it as a closed interval
  // by also forcing a boundary at the next line (endLine + 1). This prevents a
  // single record-range assertion from collapsing the entire document into one
  // record when the model would otherwise choose 'C' boundaries afterwards.
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined || r.endLine === undefined) continue;
    if (r.endLine < r.startLine) continue;
    const nextLine = r.endLine + 1;
    if (nextLine >= 0 && nextLine < spansCopy.length) {
      forcedBoundariesByLine[nextLine] = 'B';
    }
  }

  // Build forced label map for enumeration so that states containing asserted labels
  // are allowed and preferred by the decoder. Keyed by line -> { "start-end": label }
  const forcedLabelsByLine: Record<number, Record<string, FieldLabel>> = {};
  for (const [key, lab] of Object.entries(labelMap)) {
    const [lineStr, range] = key.split(':');
    if (!range) continue;
    const lineIdx = Number(lineStr);
    if (Number.isNaN(lineIdx)) continue;
    const map = forcedLabelsByLine[lineIdx] ?? (forcedLabelsByLine[lineIdx] = {});
    map[range] = lab;
  }

  // Merge forcedLabelsByLine into enumeration options so enumerateStates can use them
  const finalEnumerateOpts = { ...effEnumerateOpts, forcedLabelsByLine, forcedBoundariesByLine } as EnumerateOptions;
  // Also prepare an enumeration options object that includes forced boundaries/labels
  // for any subsequent decoding steps (targeted nudges, enforcement loops).
  const enumerateOptsWithForces = finalEnumerateOpts;

  for (let li = 0; li < spansCopy.length; li++) {
    const lineSp = spansCopy[li] ?? { lineIndex: li, spans: [] };
    const fields: FieldLabel[] = [];
    for (const sp of lineSp.spans) {
      const key = `${li}:${sp.start}-${sp.end}`;
      if (labelMap[key]) fields.push(labelMap[key]!);
      else {
        // fallback to predicted label if present at same index, otherwise NOISE
        const predLabel = (jointSeq[li] && jointSeq[li]!.fields && jointSeq[li]!.fields[0]) ? (function findMatching(){
          // try to find span with same coords in original joint spans
          const origIdx = (spansPerLine[li]?.spans ?? []).findIndex(x=>x.start===sp.start && x.end===sp.end);
          if (origIdx >= 0) return jointSeq[li]!.fields[origIdx] ?? schema.noiseLabel;
          // else fallback to NOISE
          return schema.noiseLabel as FieldLabel;
        })() : schema.noiseLabel as FieldLabel;
        fields.push(predLabel);
      }
    }
    const boundary: BoundaryState = (forcedBoundariesByLine[li] as BoundaryState) ?? (boundarySet.has(li) ? 'B' : (jointSeq[li] ? jointSeq[li]!.boundary : 'C'));
    const entityType = entityTypeMap[li] ?? (jointSeq[li] ? jointSeq[li]!.entityType : undefined);
    if (entityType !== undefined) {
      gold.push({ boundary, fields, entityType });
    } else {
      gold.push({ boundary, fields });
    }
  }

  // Re-run prediction on the augmented spans *without* forced labels first so
  // we can compute vPred for the current model (unforced) versus vGold which
  // encodes user-asserted labels. This yields a non-zero delta to update
  // weights when the asserted label differs from the model's current prediction.
  const predUnforced = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, effEnumerateOpts);

  // extract feature vectors
  const vGold = extractJointFeatureVector(lines, spansCopy, gold, boundaryFeaturesArg, segmentFeaturesArg, schema);
  const vPred = extractJointFeatureVector(lines, spansCopy, predUnforced, boundaryFeaturesArg, segmentFeaturesArg, schema);

  // After weight updates we will re-run a *forced* decode (finalEnumerateOpts)
  // so that any asserted labels are reflected in the returned prediction.
  let pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, finalEnumerateOpts);

  // Debug: log phone feature contributions when a Phone/Email assertion is present
  const assertedFieldsList = ([] as any[]).concat((feedbackEntities ?? []).flatMap((e: any) => e.fields ?? []));
  const phoneAsserted = assertedFieldsList.some(f => f.fieldType === 'Phone');
  const emailAsserted = assertedFieldsList.some(f => f.fieldType === 'Email');

  // apply scaled update: w += lr * meanConf * (vGold - vPred)
  const keys = new Set<string>([...Object.keys(vGold), ...Object.keys(vPred)]);
  for (const k of keys) {
    const delta = (vGold[k] ?? 0) - (vPred[k] ?? 0);
    weights[k] = (weights[k] ?? 0) + learningRate * meanConf * delta;
  }

  // Heuristic safety net: if user explicitly asserted a Phone/Email/ExtID but
  // the corresponding weighted delta ended up non-positive, attempt a targeted
  // nudge that is large enough to flip the score for the asserted span.
  const assertedFields = ([] as any[]).concat((feedbackEntities ?? []).flatMap((e: any) => e.fields ?? []));

  const labelFeatureMap: Record<string, string> = {
    'Phone': 'segment.is_phone',
    'Email': 'segment.is_email',
    'ExtID': 'segment.is_extid',
    'Name': 'segment.is_name',
    'PreferredName': 'segment.is_preferred_name',
    'Birthdate': 'segment.is_birthdate'
  };

  // Special handling for removals: when the user requests removal of a specific
  // span, they intend that span not be predicted anymore. The standard update
  // based on reconstructing a 'gold' joint over the modified spans may produce
  // no weight change (because the span is simply absent from the post-removal
  // prediction). To make removals influence the detector weights we apply a
  // targeted negative update per removed field. For each removed span we
  // construct a minimal joint where the span is labeled by the removed field
  // and another joint where it's NOISE; the difference (vGold - vPred) will be
  // negative and will push weights away from features that favored the removed
  // label.
  for (const f of assertedFields.filter((x: any) => x.action === 'remove')) {
    const li = f.lineIndex ?? 0;
    const origSpans = spansPerLine;
    const si = (origSpans[li]?.spans ?? []).findIndex((x: any) => x.start === f.start && x.end === f.end);
    if (si >= 0) {
      // Choose a tight sub-span to focus the removal update on.
      // If the user removed a broad span (e.g., an entire line) we try to
      // localize to a phone/email/extid-like substring so feature detectors
      // like `segment.is_phone` actually fire.
      const origSpan = origSpans[li]!.spans[si]!;
      let useStart = origSpan.start;
      let useEnd = origSpan.end;
      const lineText = lines[li] ?? '';
      const candidateText = lineText.slice(useStart, useEnd);

      if (f.fieldType === 'Phone') {
        const m = candidateText.match(/[0-9()+\-\.\s]{7,}/);
        if (m) {
          const off = candidateText.indexOf(m[0]);
          useStart = useStart + off;
          useEnd = useStart + m[0].length;
        }
      } else if (f.fieldType === 'Email') {
        const m = candidateText.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
        if (m) {
          const off = candidateText.indexOf(m[0]);
          useStart = useStart + off;
          useEnd = useStart + m[0].length;
        }
      } else if (f.fieldType === 'ExtID') {
        // try to find a token inside the candidate that looks like an ExtID
        const toks = candidateText.split(/\s+/).filter(Boolean);
        let acc = 0;
        for (const tok of toks) {
          const idx = candidateText.indexOf(tok, acc);
          acc = idx + tok.length;
          if (tok && tok.length <= 20 && /^[-_#A-Za-z0-9]+$/.test(tok) && !/^\d{10,11}$/.test(tok)) {
            // treat as likely extid
            const off = candidateText.indexOf(tok);
            useStart = useStart + off;
            useEnd = useStart + tok.length;
            break;
          }
        }
      }

      // build spansSingle: keep only the (possibly tightened) target span on its line
      const spansSingle: LineSpans[] = origSpans.map((s: LineSpans | undefined, idx: number) => {
        if (idx !== li) return { lineIndex: idx, spans: [] } as LineSpans;
        return { lineIndex: li, spans: [ { start: useStart, end: useEnd } ] } as LineSpans;
      });

      // Build two tiny joints: one where the candidate is the removed label, and
      // one where it's NOISE (the desired state after removal).
      const jointPred: JointState[] = spansSingle.map((s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [ f.fieldType as FieldLabel ] } as JointState;
      });
      const jointGold: JointState[] = spansSingle.map((s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [ schema.noiseLabel ] } as JointState;
      });

      const vPredSpan = extractJointFeatureVector(lines, spansSingle, jointPred, boundaryFeaturesArg, segmentFeaturesArg, schema);
      const vGoldSpan = extractJointFeatureVector(lines, spansSingle, jointGold, boundaryFeaturesArg, segmentFeaturesArg, schema);

      const keys = new Set<string>([...Object.keys(vPredSpan), ...Object.keys(vGoldSpan)]);
      for (const k of keys) {
        const delta = (vGoldSpan[k] ?? 0) - (vPredSpan[k] ?? 0);
        // Use the field's confidence as the scaling factor for the removal
        // update so users can provide weaker/stronger signals.
        weights[k] = (weights[k] ?? 0) + learningRate * (f.confidence ?? 1.0) * delta;
      }
    }
  }

  /**
   * Targeted feature nudging helper.
   *
   * Purpose: when straightforward updates do not flip a predicted label to an
   * asserted target, `tryNudge` attempts to identify a feature (or the
   * provided featureId) where increasing its weight will most effectively
   * change the score gap between current label and target label and then
   * applies a calibrated nudge to that feature.
   */
  function tryNudge(featureId: string, targetLabel: FieldLabel) {
    // find first asserted span with this label
    const f = assertedFields.find(x => x.fieldType === targetLabel);
    if (!f) return;
    const li = f.lineIndex ?? 0;
    const si = (spansCopy[li]?.spans ?? []).findIndex(x => x.start === f.start && x.end === f.end);
    if (si < 0) return;

    // If already predicted as target *by the underlying (unforced) model*, nothing to do
    const currLabel = predUnforced[li] && predUnforced[li]!.fields && predUnforced[li]!.fields[si] ? predUnforced[li]!.fields[si] : schema.noiseLabel;
    if (currLabel === targetLabel) return;

    // Compute score for target and current label under current weights
    function scoreWithWeights(wts: Record<string, number>, lab: FieldLabel) {
      const sctx: FeatureContext = { lineIndex: li, lines, candidateSpan: { lineIndex: li, start: spansCopy[li]!.spans[si]!.start, end: spansCopy[li]!.spans[si]!.end } };
      let score = 0;
      for (const ftr of segmentFeaturesArg) {
        const v = ftr.apply(sctx);
        const w = wts[ftr.id] ?? 0;
        if (ftr.id === 'segment.is_phone') {
          score += (lab === 'Phone') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_email') {
          score += (lab === 'Email') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_extid') {
          const txt = lines[li]?.slice(sctx.candidateSpan!.start, sctx.candidateSpan!.end) ?? '';
          const exact = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));
          if (exact) {
            score += (lab === 'ExtID') ? -0.8 * w * v : (lab === 'Phone' ? 0.7 * w * v : -0.3 * w * v);
          } else {
            score += (lab === 'ExtID') ? w * v : -0.5 * w * v;
          }
        } else if (ftr.id === 'segment.is_name') {
          score += (lab === 'Name') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_preferred_name') {
          score += (lab === 'PreferredName') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_birthdate') {
          score += (lab === 'Birthdate') ? w * v : -0.5 * w * v;
        } else {
          score += w * v;
        }
      }
      return score;
    }

    // compute current scores
    const scoreTarget = scoreWithWeights(weights, targetLabel);
    const scoreCurr = scoreWithWeights(weights, currLabel as FieldLabel);


    if (scoreTarget > scoreCurr) {
      if (currLabel === targetLabel) return; // already favored and predicted
      // If the target scores higher than the current label but the decoder
      // still didn't choose it (due to joint/global constraints), apply a
      // small corrective nudge to help break ties or overcome linkage.
      const beforeSmall = weights[featureId] ?? 0;
      const smallNud = 0.5 * learningRate * meanConf;
      weights[featureId] = beforeSmall + smallNud;
      // continue with full slope estimation below
    }

    // numerical slope estimation: increase feature by 1 and see score change
    const base = weights[featureId] ?? 0;
    weights[featureId] = base + 1;
    const scoreTargetPlus = scoreWithWeights(weights, targetLabel);
    const scoreCurrPlus = scoreWithWeights(weights, currLabel as FieldLabel);
    // revert
    weights[featureId] = base;

    const slope = (scoreTargetPlus - scoreTarget) - (scoreCurrPlus - scoreCurr);

    if (slope > 1e-9) {
      const needed = (scoreCurr - scoreTarget + 1e-6) / slope;
      const nud = Math.max(needed, 0.5) * learningRate * meanConf; // at least small nudge
      const before = weights[featureId] ?? 0;
      weights[featureId] = before + nud;
    } else {
      // try to find an alternative feature that actually moves the target vs current gap
      let bestFeat: string | null = null;
      let bestSlope = 0;
      for (const ftr of segmentFeaturesArg) {
        const baseF = weights[ftr.id] ?? 0;
        weights[ftr.id] = baseF + 1;
        const sTargetPlus = scoreWithWeights(weights, targetLabel);
        const sCurrPlus = scoreWithWeights(weights, currLabel as FieldLabel);
        weights[ftr.id] = baseF;
        const s = (sTargetPlus - scoreTarget) - (sCurrPlus - scoreCurr);
        if (s > bestSlope) { bestSlope = s; bestFeat = ftr.id; }
      }

      if (bestFeat && bestSlope > 1e-9) {
        const needed = (scoreCurr - scoreTarget + 1e-6) / bestSlope;
        const nud = Math.max(needed, 0.5) * learningRate * meanConf;
        const before = weights[bestFeat] ?? 0;
        weights[bestFeat] = before + nud;
      } else {
        // fallback large nudge on original feature
        const before = weights[featureId] ?? 0;
        weights[featureId] = before + learningRate * meanConf * 8.0;
      }
    }

    // re-run prediction on spansCopy to update pred
    const newPred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, enumerateOptsWithForces);
    for (let i = 0; i < newPred.length; i++) if (newPred[i]) pred[i] = newPred[i]!;
  }

  // Ensure asserted labels become stable predictions by nudging associated features
  function enforceAssertedPredictions(): JointSequence {
    let predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, enumerateOptsWithForces);

    for (let iter = 0; iter < 2; iter++) {
      let changed = false;
      pred = predLocal;

      for (const f of assertedFields.filter((x: any) => x.action !== 'remove')) {
        const defaultStart = (recordAssertions && recordAssertions[0] && recordAssertions[0]!.startLine) ?? 0;
        const li = f.lineIndex ?? defaultStart;
        const spansForLine = spansCopy[li]?.spans ?? [];
        const idx = spansForLine.findIndex(s => s.start === f.start && s.end === f.end);
        if (idx < 0) continue;
        const desired = f.fieldType as FieldLabel | undefined;
        if (!desired) continue;

        const current = predLocal[li]?.fields?.[idx];
        if (current === desired) continue;

        const featId = labelFeatureMap[desired];
        if (featId) {
          tryNudge(featId, desired);
          changed = true;
        }
      }

      if (!changed) break;
      predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, effEnumerateOpts);
    }

    return predLocal;
  }

  // Try targeted nudges for asserted detectors
  tryNudge('segment.is_phone', 'Phone');
  tryNudge('segment.is_email', 'Email');
  tryNudge('segment.is_extid', 'ExtID');

  // Stabilization pass: reinforce uncorrected spans that remain consistent
  // Purpose: prevent weight drift by giving small positive boosts to features
  // associated with spans that (1) weren't corrected by the user (implicitly
  // approved), and (2) are predicted consistently before and after the update.
  if (stabilizationFactor > 0) {
    let stabilizationCount = 0;
    
    for (let li = 0; li < spansPerLine.length; li++) {
      const origSpans = spansPerLine[li]?.spans ?? [];
      const origState = jointSeq[li];
      const newState = pred[li];
      
      if (!origState || !newState) continue;
      
      for (let si = 0; si < origSpans.length; si++) {
        const span = origSpans[si];
        if (!span) continue;
        
        const spanKey = `${li}:${span.start}-${span.end}`;
        
        // Skip if this span was mentioned in feedback
        if (feedbackTouchedSpans.has(spanKey)) continue;
        
        // Get original and new predictions for this span
        const origLabel = origState.fields?.[si];
        
        // Find matching span in new prediction (by coordinates)
        const newSpanIdx = pred[li]?.fields?.findIndex((_, idx) => {
          const newSpan = spansPerLine[li]?.spans[idx];
          return newSpan && newSpan.start === span.start && newSpan.end === span.end;
        }) ?? -1;
        
        const newLabel = newSpanIdx >= 0 ? newState.fields?.[newSpanIdx] : undefined;
        
        // Only stabilize if labels match and it's not NOISE
        if (!origLabel || !newLabel || origLabel !== newLabel || origLabel === schema.noiseLabel) continue;
        
        // Extract feature contributions for this stable span
        const sctx: FeatureContext = { 
          lineIndex: li, 
          lines, 
          candidateSpan: { lineIndex: li, start: span.start, end: span.end } 
        };
        
        for (const f of segmentFeaturesArg) {
          const v = f.apply(sctx);
          if (v === 0) continue; // Skip features that don't fire
          
          const txt = lines[li]?.slice(span.start, span.end) ?? '';
          const exact10or11 = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));
          
          // Apply label-aware contribution (same logic as extraction)
          let contrib = v;
          if (f.id === 'segment.is_phone') {
            contrib = origLabel === 'Phone' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_email') {
            contrib = origLabel === 'Email' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_extid') {
            if (exact10or11) {
              contrib = (origLabel === 'ExtID') ? -0.8 * v : (origLabel === 'Phone' ? 0.7 * v : -0.3 * v);
            } else {
              contrib = origLabel === 'ExtID' ? v : -0.5 * v;
            }
          } else if (f.id === 'segment.is_name') {
            contrib = origLabel === 'Name' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_preferred_name') {
            contrib = origLabel === 'PreferredName' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_birthdate') {
            contrib = origLabel === 'Birthdate' ? v : -0.5 * v;
          }
          
          // Apply small positive boost scaled by learning rate and stabilization factor
          // Only apply for positive contributions to avoid decreasing weights
          if (contrib > 0) {
            weights[f.id] = (weights[f.id] ?? 0) + learningRate * stabilizationFactor * contrib;
          }
        }
        
        stabilizationCount++;
      }
    }
  }

  // Iteratively apply small, conservative boundary nudges for asserted multi-line
  // entities that still exhibit interior 'B' boundaries after the initial update.
  // We only decrease weights for features that positively supported a 'B' (delta<0)
  // and restrict changes to line-level features to avoid wide side-effects.
  const BOUNDARY_NUDGE_SCALE = 0.5;
  const MAX_BOUNDARY_STEP = 0.5;
  const ITER_BOUNDARY = 5;

  for (let iter = 0; iter < ITER_BOUNDARY; iter++) {
    const freshCheck = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, effEnumerateOpts);
    let anyChanged = false;

    for (const ent of feedbackEntities ?? []) {
      if (ent.startLine === undefined) continue;
      const lastLine = (ent.endLine !== undefined && ent.endLine >= ent.startLine) ? ent.endLine : (spansCopy.length - 1);

      // 1) Suppress interior spurious B boundaries by nudging line-level features toward C
      for (let li = ent.startLine + 1; li <= lastLine; li++) {
        if (!freshCheck[li] || freshCheck[li]!.boundary !== 'B') continue;

        const jointPred = freshCheck.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        const jointGold = jointPred.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        jointGold[li] = { boundary: 'C', fields: jointGold[li]!.fields };

        const vPredBoundary = extractJointFeatureVector(lines, spansCopy, jointPred as any, boundaryFeaturesArg, segmentFeaturesArg, schema);
        const vGoldBoundary = extractJointFeatureVector(lines, spansCopy, jointGold as any, boundaryFeaturesArg, segmentFeaturesArg, schema);

        const keys = new Set<string>([...Object.keys(vPredBoundary), ...Object.keys(vGoldBoundary)]);
        for (const k of keys) {
          if (!k.startsWith('line.')) continue; // only adjust line-level features
          const delta = (vGoldBoundary[k] ?? 0) - (vPredBoundary[k] ?? 0);
          const step = Math.max(Math.min(delta, MAX_BOUNDARY_STEP), -MAX_BOUNDARY_STEP);
          const adj = learningRate * meanConf * BOUNDARY_NUDGE_SCALE * step;
          if (Math.abs(adj) > 1e-9) {
            weights[k] = (weights[k] ?? 0) + adj;
            anyChanged = true;
          }
        }
      }

      // 2) Reinforce asserted startLine as B if suppressed
      if (freshCheck[ent.startLine] && freshCheck[ent.startLine]!.boundary !== 'B') {
        const jointPred = freshCheck.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        const jointGold = jointPred.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        jointGold[ent.startLine] = { boundary: 'B', fields: jointGold[ent.startLine]!.fields };

        const vPredBoundary = extractJointFeatureVector(lines, spansCopy, jointPred as any, boundaryFeaturesArg, segmentFeaturesArg, schema);
        const vGoldBoundary = extractJointFeatureVector(lines, spansCopy, jointGold as any, boundaryFeaturesArg, segmentFeaturesArg, schema);

        const keys = new Set<string>([...Object.keys(vPredBoundary), ...Object.keys(vGoldBoundary)]);
        for (const k of keys) {
          if (!k.startsWith('line.')) continue;
          const delta = (vGoldBoundary[k] ?? 0) - (vPredBoundary[k] ?? 0);
          const step = Math.max(Math.min(delta, MAX_BOUNDARY_STEP), -MAX_BOUNDARY_STEP);
          const adj = learningRate * meanConf * BOUNDARY_NUDGE_SCALE * step;
          if (Math.abs(adj) > 1e-9) {
            weights[k] = (weights[k] ?? 0) + adj;
            anyChanged = true;
          }
        }
      }
    }

    if (!anyChanged) break;
  }

  let predAfterUpdate = decodeJointSequence(
    lines,
    spansCopy,
    weights,
    schema,
    boundaryFeaturesArg,
    segmentFeaturesArg,
    enumerateOpts
  );

  predAfterUpdate = enforceAssertedPredictions();

  // Ensure asserted labels are reflected in the returned prediction even if
  // the decoder still disagrees after the weight update. This aligns the
  // immediate output with explicit user intent while the weights continue to
  // adapt over subsequent feedback iterations.
  const labelMapEntries = Object.entries(labelMap);
  // Always apply explicit field labels and entityType assertions to the returned prediction
  predAfterUpdate = predAfterUpdate.map((state, li) => {
    if (!state) return state;
    const spansForLine = spansCopy[li]?.spans ?? [];
    const fields = [...(state.fields ?? [])];

    for (const [key, lab] of labelMapEntries) {
      const [lineStr, range] = key.split(':');
      if (!range) continue;
      const lineIdx = Number(lineStr);
      if (lineIdx !== li || Number.isNaN(lineIdx)) continue;
      const [startStr, endStr] = range.split('-');
      if (!startStr || !endStr) continue;
      const start = Number(startStr);
      const end = Number(endStr);
      const idx = spansForLine.findIndex(s => s.start === start && s.end === end);
      if (idx >= 0) {
        while (fields.length <= idx) fields.push(schema.noiseLabel);
        fields[idx] = lab;
      }
    }

    // Also apply any explicit entityType assertions (ensure UI feedback is reflected immediately)
    // Apply across the full asserted [startLine, endLine] range (inclusive).
    const entityType = (() => {
      const list = (subEntityAssertions ?? []) as any[];
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e || e.entityType === undefined || e.startLine === undefined) continue;
        const startLine = e.startLine as number;
        const endLine = (e.endLine !== undefined && e.endLine >= startLine) ? (e.endLine as number) : startLine;
        if (li >= startLine && li <= endLine) return e.entityType;
      }
      return state.entityType;
    })();

    return { ...state, fields, entityType } as JointState;
  });

  return { updated: weights, pred: predAfterUpdate, spansPerLine: spansCopy };
}

