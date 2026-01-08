import type {
  BoundaryState,
  EnumerateOptions,
  Feature,
  FeatureContext,
  FieldLabel,
  FieldSchema,
  JointSequence,
  JointState,
  LineSpans
} from '../types.js';
import type { LabelModel, SpanLabelFeatureContext } from '../labelModel.js';
import { defaultLabelModel } from '../prebuilt.js';

interface VCell {
  score: number;
  prev: number | null;
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

export function enumerateStates(spans: LineSpans, schema: FieldSchema, opts?: EnumerateOptions): JointState[] {
  const states: JointState[] = [];

  const enumerateOpts = {
    maxUniqueFields: opts?.maxUniqueFields ?? 3,
    maxStatesPerField: opts?.maxStatesPerField ?? {},
    safePrefix: opts?.safePrefix ?? 8,
    maxStates: opts?.maxStates ?? 2048,
    whitespaceSpanIndices: opts?.whitespaceSpanIndices ?? new Set<number>(),
    forcedLabelsByLine: opts?.forcedLabelsByLine ?? {},
    forcedBoundariesByLine: opts?.forcedBoundariesByLine ?? {},
    forcedEntityTypeByLine: opts?.forcedEntityTypeByLine ?? {}
  };

  const repeatable = new Set<FieldLabel>();
  const fieldMaxAllowed = new Map<FieldLabel, number>();

  for (const field of schema.fields) {
    const maxAllowed = field.maxAllowed ?? 1;
    fieldMaxAllowed.set(field.name, maxAllowed);
    if (maxAllowed > 1) repeatable.add(field.name);
  }

  const fieldLabels = schema.fields.map(f => f.name);
  const noiseLabel = schema.noiseLabel;

  const SAFE_PREFIX = enumerateOpts.safePrefix;
  const prefixLen = Math.min(spans.spans.length, SAFE_PREFIX);

  function countOccurrences(acc: string[], label: string) {
    return acc.filter(x => x === label).length;
  }

  function distinctNonNoiseCount(acc: string[]) {
    return new Set(acc.filter(x => x !== noiseLabel)).size;
  }

  function backtrack(i: number, acc: string[]) {
    if (states.length >= enumerateOpts.maxStates) return;

    if (i === prefixLen) {
      const tail = spans.spans.slice(prefixLen).map(() => noiseLabel);
      const forcedBoundary = enumerateOpts.forcedBoundariesByLine?.[spans.lineIndex ?? -1];
      const forcedEntity = enumerateOpts.forcedEntityTypeByLine?.[spans.lineIndex ?? -1];
      if (forcedBoundary !== undefined) {
        if (states.length < enumerateOpts.maxStates) {
          states.push({ boundary: forcedBoundary as BoundaryState, fields: [...(acc as any), ...tail], ...(forcedEntity ? { entityType: forcedEntity } : {}) });
        }
      } else {
        if (states.length < enumerateOpts.maxStates) states.push({ boundary: 'B', fields: [...(acc as any), ...tail], ...(forcedEntity ? { entityType: forcedEntity } : {}) });
        if (states.length < enumerateOpts.maxStates) states.push({ boundary: 'C', fields: [...(acc as any), ...tail], ...(forcedEntity ? { entityType: forcedEntity } : {}) });
      }
      return;
    }

    if (enumerateOpts.whitespaceSpanIndices?.has(i)) {
      acc.push(noiseLabel);
      backtrack(i + 1, acc);
      acc.pop();
      return;
    }

    const forcedForLine = (enumerateOpts.forcedLabelsByLine ?? {})[spans.lineIndex ?? -1] ?? {};
    const spanKey = `${spans.spans[i]!.start}-${spans.spans[i]!.end}`;
    const forcedLabel = forcedForLine[spanKey];
    if (forcedLabel !== undefined) {
      if (forcedLabel === noiseLabel) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }
      if (!fieldLabels.includes(forcedLabel)) {
        acc.push(noiseLabel);
        backtrack(i + 1, acc);
        acc.pop();
        return;
      }

      const f = forcedLabel;
      const nonNoiseCount = distinctNonNoiseCount(acc);
      if (f !== noiseLabel && !repeatable.has(f) && acc.includes(f)) {
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

    // no forced label; continue enumerating options

    for (const f of fieldLabels) {
      if (states.length >= enumerateOpts.maxStates) return;

      const nonNoiseCount = distinctNonNoiseCount(acc);

      if (f !== noiseLabel && !repeatable.has(f) && acc.includes(f)) continue;
      if (f !== noiseLabel && !acc.includes(f) && nonNoiseCount >= enumerateOpts.maxUniqueFields) continue;

      const fieldLimit = enumerateOpts.maxStatesPerField[f] ?? (fieldMaxAllowed.get(f) ?? 1);
      if (f !== noiseLabel && countOccurrences(acc, f) >= fieldLimit) continue;

      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();

      if (states.length >= enumerateOpts.maxStates) return;
    }

    if (states.length < enumerateOpts.maxStates) {
      acc.push(noiseLabel);
      backtrack(i + 1, acc);
      acc.pop();
    }
  }

  backtrack(0, []);

  if (states.length > enumerateOpts.maxStates) states.length = enumerateOpts.maxStates;

  return states;
}

export function prepareDecodeCaches(
  lines: string[],
  spansPerLine: LineSpans[],
  featureWeights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  enumerateOpts?: EnumerateOptions
) {
  const stateSpaces: JointState[][] = [];

  for (let t = 0; t < spansPerLine.length; t++) {
    const spans = spansPerLine[t]!;

    const whitespaceSpanIndices = new Set<number>();
    for (let i = 0; i < spans.spans.length; i++) {
      const span = spans.spans[i]!;
      const spanText = lines[t]?.slice(span.start, span.end) ?? '';
      if (/^\s*$/.test(spanText)) whitespaceSpanIndices.add(i);
    }

    stateSpaces.push(enumerateStates(spans, schema, { ...enumerateOpts, whitespaceSpanIndices }));
  }

  const boundaryBase: number[] = [];
  const spanFeatureCache: Array<Array<Record<string, number>>> = [];
  const spanTextCache: Array<string[]> = [];

  for (let t = 0; t < lines.length; t++) {
    const ctxBase: FeatureContext = { lineIndex: t, lines };

    let bsum = 0;
    for (const f of boundaryFeaturesArg) {
      const v = f.apply(ctxBase);
      const w = featureWeights[f.id] ?? 0;
      bsum += w * v;
    }
    boundaryBase[t] = bsum;

    const spans = spansPerLine[t]!;
    const spanFeatArray: Array<Record<string, number>> = [];
    const textArray: string[] = [];

    for (let si = 0; si < (spans?.spans.length ?? 0); si++) {
      const span = spans.spans[si]!;
      const sctx: FeatureContext = { lineIndex: t, lines, candidateSpan: { lineIndex: t, start: span.start, end: span.end } };
      const featsRec: Record<string, number> = {};

      for (const f of segmentFeaturesArg) featsRec[f.id] = f.apply(sctx);

      const txt = sctx.candidateSpan ? lines[t]?.slice(sctx.candidateSpan.start, sctx.candidateSpan.end) ?? '' : '';
      spanFeatArray.push(featsRec);
      textArray.push(txt);
    }

    spanFeatureCache.push(spanFeatArray);
    spanTextCache.push(textArray);
  }

  return { stateSpaces, boundaryBase, spanFeatureCache, spanTextCache };
}

export type BeamEntry = { state: JointState; score: number }

export function decodeWindowUsingCaches(
  start: number,
  endExclusive: number,
  lines: string[],
  featureWeights: Record<string, number>,
  schema: FieldSchema,
  caches: ReturnType<typeof prepareDecodeCaches>,
  labelModel?: LabelModel,
  incomingBeam?: BeamEntry[],
  beamSize?: number
): { path: JointState[]; outgoingBeam?: BeamEntry[] } {
  const lm: LabelModel = labelModel ?? defaultLabelModel;
  const windowSize = Math.max(1, endExclusive - start);
  const lattice: VCell[][] = [];

  // alias for caches
  const { stateSpaces, boundaryBase, spanFeatureCache, spanTextCache } = caches;

  const emissionScores: Array<number[]> = [];

  for (let t = start; t < endExclusive; t++) {
    emissionScores[t - start] = [];
    for (let si = 0; si < stateSpaces[t]!.length; si++) {
      const s = stateSpaces[t]![si]!;

      const bbase = boundaryBase[t] ?? 0;
      const bcontrib = s.boundary === 'B' ? bbase : -bbase;

      let fcontrib = 0;
      for (let k = 0; k < s.fields.length; k++) {
        const label = s.fields[k] ?? schema.noiseLabel;
        const txt: string = spanTextCache[t]?.[k] ?? '';
        if (label === schema.noiseLabel) continue;

        const featsRec: Record<string, number> = spanFeatureCache[t]?.[k] ?? {};
        for (const fid of Object.keys(featsRec)) {
          const w = featureWeights[fid] ?? 0;
          const v = featsRec[fid] ?? 0;
          const ctx: SpanLabelFeatureContext = { label, spanText: txt, featureId: fid, featureValue: v, schema };
          const transformed = lm.featureContribution ? lm.featureContribution(ctx) : v;
          fcontrib += w * transformed;
        }
      }

      emissionScores[t - start]![si] = bcontrib + fcontrib;
    }
  }

  // Build lattice for window
  if (incomingBeam && incomingBeam.length > 0) {
    // initialize from incoming beam using transition scores
    lattice[0] = stateSpaces[start]?.map((s, idx) => {
      let best = -Infinity
      for (const be of incomingBeam) {
        const tscore = transitionScore(be.state, s, featureWeights)
        const emit = emissionScores[0]![idx] ?? -Infinity
        const sc = be.score + tscore + emit
        if (sc > best) best = sc
      }
      return { score: best, prev: null }
    }) ?? []
  } else {
    lattice[0] = stateSpaces[start]?.map((s, idx) => {
      const baseScore = emissionScores[0]![idx] ?? -Infinity;
      const startLineHasContent = (lines[start]?.trim().length ?? 0) > 0;
      const bias = s.boundary === 'B' ? (startLineHasContent ? 0.75 : 0) : 0;
      return { score: baseScore + bias, prev: null };
    }) ?? [];
  }

  for (let t = 1; t < windowSize; t++) {
    lattice[t] = [];
    for (let i = 0; i < stateSpaces[start + t]!.length; i++) {
      let bestScore = -Infinity;
      let bestPrev: number | null = null;

      const emit = emissionScores[t]![i] ?? -Infinity;

      for (let j = 0; j < stateSpaces[start + t - 1]!.length; j++) {
        const trans = transitionScore(stateSpaces[start + t - 1]![j]!, stateSpaces[start + t]![i]!, featureWeights);
        const score = lattice[t - 1]![j]!.score + trans + emit;
        if (score > bestScore) {
          bestScore = score;
          bestPrev = j;
        }
      }

      lattice[t]![i] = { score: bestScore, prev: bestPrev };
    }
  }

  // capture top-K beam at last timestep if requested
  const lastCol = lattice[windowSize - 1] ?? []
  const top = lastCol.map((c, i) => ({ i, score: c.score })).sort((a, b) => b.score - a.score)

  if (top.length === 0) {
    return { path: [], outgoingBeam: [] }
  }

  const outgoingBeam: BeamEntry[] = []
  const k = Math.max(1, beamSize ?? 1)
  for (let ii = 0; ii < Math.min(k, top.length); ii++) {
    const entry = top[ii]!
    const st = stateSpaces[start + windowSize - 1]![entry.i]
    if (st) outgoingBeam.push({ state: st, score: entry.score })
  }

  let lastIndex = top[0]!.i
  const path: JointState[] = [];
  for (let t = windowSize - 1; t >= 0; t--) {
    path.unshift(stateSpaces[start + t]![lastIndex]!);
    lastIndex = lattice[t]![lastIndex]!.prev!;
  }

  return { path, outgoingBeam };
}

export function decodeJointSequence(
  lines: string[],
  spansPerLine: LineSpans[],
  featureWeights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  enumerateOpts?: EnumerateOptions,
  labelModel?: LabelModel
): JointSequence {
  const caches = prepareDecodeCaches(lines, spansPerLine, featureWeights, schema, boundaryFeaturesArg, segmentFeaturesArg, enumerateOpts)
  const res = decodeWindowUsingCaches(0, lines.length, lines, featureWeights, schema, caches, labelModel)
  return res.path
}

export function extractJointFeatureVector(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  labelModel?: LabelModel
): Record<string, number> {
  const lm: LabelModel = labelModel ?? defaultLabelModel;
  const vec: Record<string, number> = {};

  for (let i = 0; i < jointSeq.length; i++) {
    const state = jointSeq[i]!;
    const ctx: FeatureContext = { lineIndex: i, lines };
    for (const f of boundaryFeaturesArg) {
      const v = f.apply(ctx);
      const contrib = state.boundary === 'B' ? v : -v;
      vec[f.id] = (vec[f.id] ?? 0) + contrib;
    }
  }

  for (let i = 0; i < jointSeq.length; i++) {
    const state = jointSeq[i]!;
    const spans = spansPerLine[i]!;

    for (let si = 0; si < spans.spans.length; si++) {
      const span = spans.spans[si]!;
      const label = state.fields[si] ?? schema.noiseLabel;
      const ctx: FeatureContext = { lineIndex: i, lines, candidateSpan: { lineIndex: i, start: span.start, end: span.end } };

      for (const f of segmentFeaturesArg) {
        const v = f.apply(ctx);
        const spanText = ctx.candidateSpan
          ? ctx.lines[ctx.candidateSpan.lineIndex]?.slice(ctx.candidateSpan.start, ctx.candidateSpan.end) ?? ''
          : '';
        const ctx2: SpanLabelFeatureContext = { label, spanText, featureId: f.id, featureValue: v, schema };
        const contrib = lm.featureContribution ? lm.featureContribution(ctx2) : v;
        vec[f.id] = (vec[f.id] ?? 0) + contrib;
      }
    }
  }

  return vec;
}
