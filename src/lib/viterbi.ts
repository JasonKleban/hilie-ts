import type { FieldLabel, FeatureContext, JointState, LineSpans, BoundaryState, EnumerateOptions, Relationship } from './types.js';
import { boundaryFeatures, segmentFeatures } from './features.js';

function boundaryEmissionScore(
  state: BoundaryState,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  let score = 0;

  for (const f of boundaryFeatures) {
    const v = f.apply(ctx);
    const w = weights[f.id] ?? 0;
    score += state === 'B' ? w * v : -w * v;
  }

  return score;
}

function fieldEmissionScore(
  fields: FieldLabel[],
  spans: LineSpans,
  ctxBase: FeatureContext,
  weights: Record<string, number>
): number {
  let score = 0;

  for (let i = 0; i < spans.spans.length; i++) {
    const label = fields[i];
    if (label === 'NOISE') continue;

    const span = spans.spans[i]!;
    const ctx: FeatureContext = {
      ...ctxBase,
      candidateSpan: {
        lineIndex: spans.lineIndex,
        start: span.start,
        end: span.end
      }
    };

    for (const f of segmentFeatures) {
      const w = weights[f.id] ?? 0;
      const v = f.apply(ctx);

      // extract span text for heuristics like numeric-length checks
      const spanText = ctx.candidateSpan ? ctx.lines[ctx.candidateSpan.lineIndex]?.slice(ctx.candidateSpan.start, ctx.candidateSpan.end) ?? '' : '';
      const exact10or11Digits = /^\d{10,11}$/.test(spanText.replace(/\D/g, ''));

      // Label-aware biases for specific segment detectors
      if (f.id === 'segment.is_phone') {
        score += (label === 'Phone') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_email') {
        score += (label === 'Email') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_extid') {
        // prefer ExtID label when extid-like; but penalize assigning ExtID to exact 10/11 digit values (likely phones)
        if (exact10or11Digits) {
          score += (label === 'ExtID') ? -0.8 * w * v : (label === 'Phone' ? 0.7 * w * v : -0.3 * w * v);
        } else {
          score += (label === 'ExtID') ? w * v : -0.5 * w * v;
        }
      } else if (f.id === 'segment.is_fullname') {
        score += (label === 'FullName') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_preferred_name') {
        score += (label === 'PreferredName') ? w * v : -0.5 * w * v;
      } else if (f.id === 'segment.is_birthdate') {
        score += (label === 'Birthdate') ? w * v : -0.5 * w * v;
      } else {
        score += w * v;
      }
    }
  }

  return score;
}

function jointEmissionScore(
  state: JointState,
  spans: LineSpans,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  return boundaryEmissionScore(state.boundary, ctx, weights) + fieldEmissionScore(state.fields, spans, ctx, weights);
}

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

interface VCell {
  score: number;
  prev: number | null;
}

export function enumerateStates(spans: LineSpans, opts?: EnumerateOptions): JointState[] {
  const states: JointState[] = [];

  const options = {
    maxUniqueFields: opts?.maxUniqueFields ?? 3,
    maxPhones: opts?.maxPhones ?? 3,
    maxEmails: opts?.maxEmails ?? 3,
    safePrefix: opts?.safePrefix ?? 8,
    maxStates: opts?.maxStates ?? 2048
  };

  const fieldLabels: string[] = ['ExtID', 'FullName', 'PreferredName', 'Phone', 'Email', 'GeneralNotes', 'MedicalNotes', 'DietaryNotes', 'Birthdate', 'NOISE'];

  const repeatable = new Set(['Phone', 'Email']);

  // To avoid exponential blowup, only enumerate over an initial prefix when the span count is large.
  const SAFE_PREFIX = options.safePrefix;
  const prefixLen = Math.min(spans.spans.length, SAFE_PREFIX);

  function countOccurrences(acc: string[], label: string) {
    return acc.filter(x => x === label).length;
  }

  function distinctNonNoiseCount(acc: string[]) {
    return new Set(acc.filter(x => x !== 'NOISE')).size;
  }

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

export function jointViterbiDecode(lines: string[], spansPerLine: LineSpans[], featureWeights: Record<string, number>, enumerateOpts?: import('./types.js').EnumerateOptions): JointState[] {
  const lattice: VCell[][] = [];
  const stateSpaces: JointState[][] = [];

  for (const spans of spansPerLine) {
    stateSpaces.push(enumerateStates(spans, enumerateOpts));
  }

  lattice[0] = stateSpaces[0]?.map(() => ({ score: 0, prev: null })) ?? [];

  for (let t = 1; t < lines.length; t++) {
    lattice[t] = [];

    for (let i = 0; i < stateSpaces[t]!.length; i++) {
      let bestScore = -Infinity;
      let bestPrev: number | null = null;

      for (let j = 0; j < stateSpaces[t - 1]!.length; j++) {
        const ctx: FeatureContext = { lineIndex: t, lines };

        const score = lattice[t - 1]![j]!.score + transitionScore(stateSpaces[t - 1]![j]!, stateSpaces[t]![i]!, featureWeights) + jointEmissionScore(stateSpaces[t]![i]!, spansPerLine[t]!, ctx, featureWeights);

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

// --- Feature vector extraction and lightweight trainer (structured perceptron-like) ---
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
        } else if (f.id === 'segment.is_fullname') {
          contrib = label === 'FullName' ? v : -0.5 * v;
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

// Heuristic entity-type detection (post-decode)
export function annotateEntityTypes(lines: string[], joint: JointState[]): JointState[] {
  return joint.map((state, idx) => {
    const line = lines[idx] ?? '';
    const fields = state.fields;

    // Guardian heuristics: explicit tokens
    if (/\bparent\b|\bguardian\b/i.test(line)) {
      return { ...state, entityType: 'Guardian' };
    }

    // Primary heuristics: leading numeric ID or comma-separated Last, First
    if (/^\s*\d+\b/.test(line) || /^\s*[A-Za-z]+,\s*[A-Za-z]+/.test(line)) {
      return { ...state, entityType: 'Primary' };
    }

    // If fields looks like multiple populated fields (F1 and F2 non-NOISE), prefer Primary
    const nonNoise = fields.filter(f => f !== 'NOISE').length;
    if (nonNoise >= 2) return { ...state, entityType: 'Primary' };

    return { ...state, entityType: 'Unknown' };
  });
}

export function inferRelationships(joint: JointState[]): Relationship[] {
  const rels: Relationship[] = [];

  // Build index of primary lines
  const primaries = joint.map((s, i) => ({ s, i })).filter(x => x.s.entityType === 'Primary');
  const guardians = joint.map((s, i) => ({ s, i })).filter(x => x.s.entityType === 'Guardian');

  // Simple heuristic: assign each guardian to the nearest preceding primary within 6 lines
  for (const g of guardians) {
    let closest: { s: JointState; i: number } | null = null;
    for (const p of primaries) {
      if (p.i <= g.i && (closest === null || g.i - p.i < g.i - closest.i)) closest = p;
    }
    if (closest && g.i - closest.i <= 6) {
      rels.push({ primaryIndex: closest.i, guardianIndex: g.i });
    }
  }

  return rels;
}
