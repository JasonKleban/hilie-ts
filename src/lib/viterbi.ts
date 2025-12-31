import type { FieldLabel, FeatureContext, JointState, LineSpans, BoundaryState, EnumerateOptions, Relationship, FieldSpan, Feedback, RecordSpan, SubEntitySpan, SubEntityType } from './types.js';
import { boundaryFeatures, segmentFeatures } from './features.js';

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
 * for a single line's spans (used by `jointViterbiDecode` when building the state
 * lattice). To avoid exponential blowup the function enforces caps such as
 * `maxUniqueFields`, `maxPhones`, and `maxStates` and optionally restricts
 * enumeration to an initial safe prefix of spans.
 *
 * Returns: an array of `JointState` objects (each with a `boundary` and a
 * `fields` array) representing candidate per-line assignments.
 */
export function enumerateStates(spans: LineSpans, opts?: EnumerateOptions): JointState[] {
  const states: JointState[] = [];

  const options = {
    maxUniqueFields: opts?.maxUniqueFields ?? 3,
    maxPhones: opts?.maxPhones ?? 3,
    maxEmails: opts?.maxEmails ?? 3,
    safePrefix: opts?.safePrefix ?? 8,
    maxStates: opts?.maxStates ?? 2048
  };

  const fieldLabels: string[] = ['ExtID', 'Name', 'PreferredName', 'Phone', 'Email', 'GeneralNotes', 'MedicalNotes', 'DietaryNotes', 'Birthdate', 'NOISE'];

  const repeatable = new Set(['Name', 'Phone', 'Email']);

  // To avoid exponential blowup, only enumerate over an initial prefix when the span count is large.
  const SAFE_PREFIX = options.safePrefix;
  const prefixLen = Math.min(spans.spans.length, SAFE_PREFIX);

  function countOccurrences(acc: string[], label: string) {
    return acc.filter(x => x === label).length;
  }

  function distinctNonNoiseCount(acc: string[]) {
    return new Set(acc.filter(x => x !== 'NOISE')).size;
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
    if (states.length >= options.maxStates) return;

    if (i === prefixLen) {
      // if we limited to a prefix, fill remaining positions with NOISE
      const tail = spans.spans.slice(prefixLen).map(() => 'NOISE' as const);
      // Push states but guard against exceeding the cap
      if (states.length < options.maxStates) states.push({ boundary: 'B', fields: [...(acc as any), ...tail] });
      if (states.length < options.maxStates) states.push({ boundary: 'C', fields: [...(acc as any), ...tail] });
      return;
    }

    for (const f of fieldLabels) {
      // Another quick cap check to avoid unnecessary work
      if (states.length >= options.maxStates) return;

      const nonNoiseCount = distinctNonNoiseCount(acc);

      // Enforce uniqueness for single-occurrence labels
      if (f !== 'NOISE' && !repeatable.has(f) && acc.includes(f)) continue;

      // Enforce max unique fields
      if (f !== 'NOISE' && !acc.includes(f) && nonNoiseCount >= options.maxUniqueFields) continue;

      // Enforce per-label caps for repeatables
      if (f === 'Phone' && countOccurrences(acc, 'Phone') >= options.maxPhones) continue;
      if (f === 'Email' && countOccurrences(acc, 'Email') >= options.maxEmails) continue;

      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();

      // Safety: if we've generated a large number of states, bail out early.
      if (states.length >= options.maxStates) return;
    }
  }

  backtrack(0, []);

  // Enforce strict cap just in case generation slightly exceeded the threshold
  if (states.length > options.maxStates) states.length = options.maxStates;

  return states;
}

/**
 * Perform joint Viterbi decoding across document lines.
 *
 * Intent: simultaneously infer per-line boundary codes (`B` / `C`) and the
 * per-span field label assignments by building a dynamic programming lattice
 * over enumerated per-line state spaces (produced by `enumerateStates`).
 *
 * Behavior:
 * - Precomputes boundary and segment feature contributions and emission scores
 *   to keep the inner loop efficient.
 * - Uses `transitionScore` to bias transitions between `JointState`s.
 *
 * Returns: the best-scoring `JointState[]` (one entry per input line).
 */
export function jointViterbiDecode(lines: string[], spansPerLine: LineSpans[], featureWeights: Record<string, number>, enumerateOpts?: EnumerateOptions): JointState[] {
  const lattice: VCell[][] = [];
  const stateSpaces: JointState[][] = [];

  // Precompute state spaces
  for (const spans of spansPerLine) {
    stateSpaces.push(enumerateStates(spans, enumerateOpts));
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
    for (const f of boundaryFeatures) {
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

      for (const f of segmentFeatures) {
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
        if (label === 'NOISE') continue;
        const featsRec: Record<string, number> = spanFeatureCache[t]?.[k] ?? {};
        const txt: string = spanTextCache[t]?.[k] ?? '';
        const exact10or11: boolean = spanExact10or11[t]?.[k] ?? false;

        for (const fid of Object.keys(featsRec)) {
          const w = featureWeights[fid] ?? 0;
          const v = featsRec[fid] ?? 0;

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
  lattice[0] = stateSpaces[0]?.map((s, idx) => ({ score: emissionScores[0]![idx] ?? -Infinity, prev: null })) ?? [];

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
 * the labels present in `joint` so that learning updates can compare
 * gold vs. predicted vectors.
 *
 * Returns: a sparse map from feature id to numeric contribution.
 */
export function extractFeatureVector(lines: string[], spansPerLine: LineSpans[], joint: JointState[]): Record<string, number> {
  const vec: Record<string, number> = {};

  // boundary features (line-level)
  for (let i = 0; i < joint.length; i++) {
    const state = joint[i]!;
    const ctx: FeatureContext = { lineIndex: i, lines };
    for (const f of boundaryFeatures) {
      const v = f.apply(ctx);
      const contrib = state.boundary === 'B' ? v : -v;
      vec[f.id] = (vec[f.id] ?? 0) + contrib;
    }
  }

  // segment features (span-level)
  for (let i = 0; i < joint.length; i++) {
    const state = joint[i]!;
    const spans = spansPerLine[i]!;

    for (let si = 0; si < spans.spans.length; si++) {
      const span = spans.spans[si]!;
      const label = state.fields[si];
      const ctx: FeatureContext = { lineIndex: i, lines, candidateSpan: { lineIndex: i, start: span.start, end: span.end } };

      for (const f of segmentFeatures) {
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
 * Update model weights from a fully-specified gold example (perceptron-style).
 *
 * Responsibility: Given `gold` joint labels, run the decoder under current
 * `weights` to get `pred`, compute feature vectors for `gold` and `pred`, and
 * apply a simple additive update `w += lr * (vGold - vPred)`. The update
 * mutates the provided `weights` object and returns it along with the
 * prediction used for the update.
 */
export function updateWeightsFromExample(lines: string[], spansPerLine: LineSpans[], gold: JointState[], weights: Record<string, number>, lr = 1.0, enumerateOpts?: EnumerateOptions): { updated: Record<string, number>; pred: JointState[] } {
  // Predict with current weights
  const pred = jointViterbiDecode(lines, spansPerLine, weights, enumerateOpts);

  // Extract feature vectors for gold and pred
  const vGold = extractFeatureVector(lines, spansPerLine, gold);
  const vPred = extractFeatureVector(lines, spansPerLine, pred);

  // Apply perceptron-like update: w += lr * (vGold - vPred)
  const keys = new Set<string>([...Object.keys(vGold), ...Object.keys(vPred)]);
  for (const k of keys) {
    const delta = (vGold[k] ?? 0) - (vPred[k] ?? 0);
    weights[k] = (weights[k] ?? 0) + lr * delta;
  }

  return { updated: weights, pred };
}

/**
 * Heuristically assign `entityType` hints (Primary / Guardian / Unknown) to
 * lines marked as record boundaries.
 *
 * Intent: use lightweight boundary features and role-keyword signals to label
 * boundary lines with likely entity roles, then enforce simple contiguity
 * constraints (e.g., Guardians should have a nearby Primary). Returns a new
 * `JointState[]` array with `entityType` set for boundary entries.
 */
export function annotateEntityTypes(lines: string[], joint: JointState[]): JointState[] {
  // Compute per-line feature scores using boundaryFeatures
  const featuresPerLine: Record<number, Record<string, number>> = {};

  for (let i = 0; i < joint.length; i++) {
    const ctx: FeatureContext = { lineIndex: i, lines };
    const feats: Record<string, number> = {};
    for (const f of boundaryFeatures) {
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
  const assigned = joint.map((s) => ({ ...s }));

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
 * Purpose: take a predicted or gold `joint` (per-line boundary+fields assignments)
 * and produce an array of `RecordSpan` objects where each top-level record contains
 * grouped `SubEntitySpan` children (Primary/Guardian) with `FieldSpan` entries.
 * The function computes file-relative offsets, per-field confidences (when
 * `featureWeights` are provided), and skips `Unknown` sub-entities.
 *
 * Parameters:
 * - lines: array of document lines
 * - spansPerLine: candidate spans for each line
 * - joint: per-line `JointState[]` assignments (may or may not include entityType)
 * - featureWeights: optional weights used to compute softmax confidences per field
 *
 * Returns: a `RecordSpan[]` describing the inferred records and their sub-entities.
 */
export function entitiesFromJoint(lines: string[], spansPerLine: LineSpans[], joint: JointState[], featureWeights?: Record<string, number>): RecordSpan[] {
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
    let score = 0;
    for (const f of segmentFeatures) {
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

  // If entityType is not present in the joint, annotate it using heuristics
  const jointAnnotated = (!joint.some(s => s && s.entityType !== undefined)) ? annotateEntityTypes(lines, joint) : joint;
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
        const assignedLabel = (joint[li] && joint[li]!.fields && joint[li]!.fields[si]) ? joint[li]!.fields[si] : undefined;

        // approximate confidence via softmax over label scores if weights provided
        let confidence = 1;
        if (featureWeights) {
          const labelScores: number[] = [];
          const labels: FieldLabel[] = ['ExtID','Name','PreferredName','Phone','Email','GeneralNotes','MedicalNotes','DietaryNotes','Birthdate','NOISE'];
          for (const lab of labels) labelScores.push(scoreLabelForSpan(li, si, lab as FieldLabel));
          const max = Math.max(...labelScores);
          const exps = labelScores.map(sv => Math.exp(sv - max));
          const ssum = exps.reduce((a,b) => a+b, 0);
          const probs = exps.map(e => e / ssum);
          const idx = labels.indexOf(assignedLabel ?? 'NOISE');
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
 * Update model weights using user feedback (fields added or removed).
 *
 * Purpose: incorporate feedback by constructing gold joints from asserted
 * additions/removals, computing feature vector deltas between gold and
 * predicted joints, and applying perceptron-style updates. Supports
 * deterministic negative updates for removals, and targeted feature nudges
 * when straightforward updates do not flip predictions.
 *
 * Parameters:
 * - lines: the document lines
 * - spansPerLine: candidate spans per line (may be modified internally)
 * - joint: current predicted joint assignment
 * - feedback: user-supplied feedback with entity/field add/remove assertions
 * - weights: mutable feature weight map to be updated in-place
 * - lr: learning rate (default 1.0)
 * - enumerateOpts: optional enumeration constraints passed to the decoder
 *
 * Returns: object containing the updated weights and the post-update prediction.
 */
export function updateWeightsFromFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  joint: JointState[],
  feedback: Feedback,
  weights: Record<string, number>,
  lr = 1.0,
  enumerateOpts?: EnumerateOptions
): { updated: Record<string, number>; pred: JointState[] } {
  // Clone spans so we can modify
  const spansCopy: LineSpans[] = spansPerLine.map(s => ({ lineIndex: s.lineIndex, spans: s.spans.map(sp => ({ start: sp.start, end: sp.end })) }));

  // apply feedback: additions/removals
  let confs: number[] = [];

  // helper to find matching span index by line/start/end
  function findSpanIndex(lineIdx: number, start?: number, end?: number) {
    const s = spansCopy[lineIdx];
    if (!s) return -1;
    if (start === undefined || end === undefined) return -1;
    return s.spans.findIndex(x => x.start === start && x.end === end);
  }

  for (const ent of feedback.entities ?? []) {
    const entStartLine = ent.startLine ?? null;
    const entEndLine = ent.endLine ?? null;

    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? entStartLine;
      if (li === null || li === undefined) continue;
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

  // Build gold JointState[] aligned with spansCopy
  const gold: JointState[] = [];

  // create a quick mapping from feedback assertions to labels per-line/start/end
  const labelMap: Record<string, FieldLabel> = {}; // key = `${line}:${start}-${end}`
  for (const ent of feedback.entities ?? []) {
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

  // Determine boundary choices: prefer feedback entity starts when provided, otherwise fall back to joint
  const boundarySet = new Set<number>();
  for (const ent of feedback.entities ?? []) {
    if (ent.startLine !== undefined) boundarySet.add(ent.startLine);
  }

  for (let li = 0; li < spansCopy.length; li++) {
    const lineSp = spansCopy[li] ?? { lineIndex: li, spans: [] };
    const fields: FieldLabel[] = [];
    for (const sp of lineSp.spans) {
      const key = `${li}:${sp.start}-${sp.end}`;
      if (labelMap[key]) fields.push(labelMap[key]!);
      else {
        // fallback to predicted label if present at same index, otherwise NOISE
        const predLabel = (joint[li] && joint[li]!.fields && joint[li]!.fields[0]) ? (function findMatching(){
          // try to find span with same coords in original joint spans
          const origIdx = (spansPerLine[li]?.spans ?? []).findIndex(x=>x.start===sp.start && x.end===sp.end);
          if (origIdx >= 0) return joint[li]!.fields[origIdx] ?? 'NOISE';
          // else fallback to NOISE
          return 'NOISE' as FieldLabel;
        })() : 'NOISE' as FieldLabel;
        fields.push(predLabel);
      }
    }
    const boundary: BoundaryState = boundarySet.has(li) ? 'B' : (joint[li] ? joint[li]!.boundary : 'C');
    gold.push({ boundary, fields });
  }

  // Re-run prediction on the augmented spans
  const pred = jointViterbiDecode(lines, spansCopy, weights, enumerateOpts);

  // extract feature vectors
  const vGold = extractFeatureVector(lines, spansCopy, gold);
  const vPred = extractFeatureVector(lines, spansCopy, pred);

  // apply scaled update: w += lr * meanConf * (vGold - vPred)
  const keys = new Set<string>([...Object.keys(vGold), ...Object.keys(vPred)]);
  for (const k of keys) {
    const delta = (vGold[k] ?? 0) - (vPred[k] ?? 0);
    weights[k] = (weights[k] ?? 0) + lr * meanConf * delta;
  }

  // Heuristic safety net: if user explicitly asserted a Phone/Email/ExtID but
  // the corresponding weighted delta ended up non-positive, attempt a targeted
  // nudge that is large enough to flip the score for the asserted span.
  const assertedFields = (feedback.entities ?? []).flatMap(e => e.fields ?? []);

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
    const li = f.lineIndex ?? (feedback.entities && feedback.entities[0] && feedback.entities[0]!.startLine) ?? 0;
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
        return { boundary: 'C', fields: [ 'NOISE' ] } as JointState;
      });

      const vPredSpan = extractFeatureVector(lines, spansSingle, jointPred);
      const vGoldSpan = extractFeatureVector(lines, spansSingle, jointGold);

      // Phone-specific debug removed

      const keys = new Set<string>([...Object.keys(vPredSpan), ...Object.keys(vGoldSpan)]);
      for (const k of keys) {
        const delta = (vGoldSpan[k] ?? 0) - (vPredSpan[k] ?? 0);
        const beforeVal = (weights[k] ?? 0);
        // Use the field's confidence as the scaling factor for the removal
        // update so users can provide weaker/stronger signals.
        weights[k] = (weights[k] ?? 0) + lr * (f.confidence ?? 1.0) * delta;
        const afterVal = weights[k];
        // removal update diagnostic removed
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
  async function tryNudge(featureId: string, targetLabel: FieldLabel) {
    // find first asserted span with this label
    const f = assertedFields.find(x => x.fieldType === targetLabel);
    if (!f) return;
    const li = f.lineIndex ?? (feedback.entities && feedback.entities[0] && feedback.entities[0]!.startLine) ?? 0;
    const si = (spansCopy[li]?.spans ?? []).findIndex(x => x.start === f.start && x.end === f.end);
    if (si < 0) return;

    // If already predicted as target, nothing to do
    const currLabel = pred[li] && pred[li]!.fields && pred[li]!.fields[si] ? pred[li]!.fields[si] : 'NOISE';
    if (currLabel === targetLabel) return;

    // Compute score for target and current label under current weights
    function scoreWithWeights(wts: Record<string, number>, lab: FieldLabel) {
      const sctx: FeatureContext = { lineIndex: li, lines, candidateSpan: { lineIndex: li, start: spansCopy[li]!.spans[si]!.start, end: spansCopy[li]!.spans[si]!.end } };
      let score = 0;
      for (const ftr of segmentFeatures) {
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

    // debug info
    // console.log(`nudge check for ${featureId} @ line ${li} span ${si}: scoreTarget=${scoreTarget}, scoreCurr=${scoreCurr}, currLabel=${currLabel}`);

    if (scoreTarget > scoreCurr) return; // already favored

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
      const nud = Math.max(needed, 0.5) * lr * meanConf; // at least small nudge
      weights[featureId] = (weights[featureId] ?? 0) + nud;
    } else {
      // try to find an alternative feature that actually moves the target vs current gap
      let bestFeat: string | null = null;
      let bestSlope = 0;
      for (const ftr of segmentFeatures) {
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
        const nud = Math.max(needed, 0.5) * lr * meanConf;
        weights[bestFeat] = (weights[bestFeat] ?? 0) + nud;
        // console.log(`nudged alternative feature ${bestFeat} by ${nud} to favor ${targetLabel}`);
      } else {
        // fallback large nudge on original feature
        weights[featureId] = (weights[featureId] ?? 0) + lr * meanConf * 8.0;
      }
    }

    // re-run prediction on spansCopy to update pred
    const newPred = jointViterbiDecode(lines, spansCopy, weights, enumerateOpts);
    for (let i = 0; i < newPred.length; i++) if (newPred[i]) pred[i] = newPred[i]!;
  }

  // Try targeted nudges for asserted detectors
  tryNudge('segment.is_phone', 'Phone');
  tryNudge('segment.is_email', 'Email');
  tryNudge('segment.is_extid', 'ExtID');


  return { updated: weights, pred };
}


