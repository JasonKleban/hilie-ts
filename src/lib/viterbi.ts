import { STATES, defaultTransitions } from './types.js';
import type { FeatureContext, JointState, LineSpans, TransitionWeights, BoundaryState } from './types.js';
import { boundaryFeatures, segmentFeatures } from './features.js';

interface ViterbiCell {
  score: number;
  prev: BoundaryState | null;
}

export function emissionScore(
  state: BoundaryState,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  let score = 0;

  for (const f of boundaryFeatures) {
    const value = f.apply(ctx);
    const w = weights[f.id] ?? 0;

    if (state === 'B') {
      score += w * value;
    } else {
      score -= w * value;
    }
  }

  return score;
}

export function boundaryEmissionScore(
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

export function fieldEmissionScore(
  fields: string[],
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
      score += w * f.apply(ctx);
    }
  }

  return score;
}

export function jointEmissionScore(
  state: JointState,
  spans: LineSpans,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  return boundaryEmissionScore(state.boundary, ctx, weights) + fieldEmissionScore(state.fields as string[], spans, ctx, weights);
}

export function transitionScore(prev: JointState, curr: JointState, weights: Record<string, number>): number {
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

export function viterbiDecodeBoundaries(
  lines: string[],
  featureWeights: Record<string, number>,
  transitionWeights: TransitionWeights = defaultTransitions
): BoundaryState[] {
  const T = lines.length;
  const lattice: Record<BoundaryState, ViterbiCell>[] = [];

  lattice[0] = {
    B: { score: 0, prev: null },
    C: { score: -Infinity, prev: null }
  };

  for (let t = 1; t < T; t++) {
    lattice[t] = {} as any;

    for (const curr of STATES) {
      let bestScore = -Infinity;
      let bestPrev: BoundaryState | null = null;

      for (const prev of STATES) {
        const transition = transitionWeights[`${prev}_to_${curr}` as keyof TransitionWeights];

        const ctx: FeatureContext = { lineIndex: t, lines };

        const score = lattice[t - 1]![prev].score + transition + emissionScore(curr, ctx, featureWeights);

        if (score > bestScore) {
          bestScore = score;
          bestPrev = prev;
        }
      }

      lattice[t]![curr] = { score: bestScore, prev: bestPrev };
    }
  }

  let lastState: BoundaryState = lattice[T - 1]!.B.score > lattice[T - 1]!.C.score ? 'B' : 'C';

  const path: BoundaryState[] = Array(T);
  path[T - 1] = lastState;

  for (let t = T - 1; t > 0; t--) {
    lastState = lattice[t]![lastState].prev!;
    path[t - 1] = lastState;
  }

  return path;
}

interface VCell {
  score: number;
  prev: number | null;
}

export function enumerateStates(spans: LineSpans, maxFields = 3): JointState[] {
  const states: JointState[] = [];

  const fieldLabels: string[] = ['F1', 'F2', 'F3', 'NOISE'];

  function backtrack(i: number, acc: string[]) {
    if (i === spans.spans.length) {
      states.push({ boundary: 'B', fields: [...(acc as any)] });
      states.push({ boundary: 'C', fields: [...(acc as any)] });
      return;
    }

    for (const f of fieldLabels) {
      if (f !== 'NOISE' && acc.includes(f)) continue;
      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();
    }
  }

  backtrack(0, []);
  return states;
}

export function jointViterbiDecode(lines: string[], spansPerLine: LineSpans[], featureWeights: Record<string, number>): JointState[] {
  const lattice: VCell[][] = [];
  const stateSpaces: JointState[][] = [];

  for (const spans of spansPerLine) {
    stateSpaces.push(enumerateStates(spans));
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
