interface EntityStats {
  meanFieldStart: number;
}

interface SchemaStats {
  entityCount: number;
  tokenFrequency: Record<string, number>;
  optionalFieldProbability?: number;
}


interface FeatureContext {
  lineIndex: number;
  lines: string[];

  candidateSpan?: {
    start: number;
    end: number;
    lineIndex: number;
  };

  previousEntity?: EntityStats;
  schemaStats?: SchemaStats;
}

interface Feature {
  id: string;
  apply(ctx: FeatureContext): number;
}

function clamp(x: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, x));
}

const indentationDelta: Feature = {
  id: "line.indentation_delta",
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    const curr = ctx.lines[ctx.lineIndex];
    const prev = ctx.lines[ctx.lineIndex - 1];

    const indent = (s: string | undefined) => s?.match(/^\s*/)?.[0].length ?? 0;

    const delta = indent(curr) - indent(prev);

    return clamp(delta / 8);
  }
};

const lexicalSimilarityDrop: Feature = {
  id: "line.lexical_similarity_drop",
  apply(ctx) {
    if (ctx.lineIndex === 0) return 0;

    const tokenize = (s: string | undefined) =>
      s?.toLowerCase().split(/\W+/).filter(Boolean) ?? [];

    const a = new Set(tokenize(ctx.lines[ctx.lineIndex - 1]));
    const b = new Set(tokenize(ctx.lines[ctx.lineIndex]));

    const intersection = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size || 1;

    const jaccard = intersection / union;

    return clamp(1 - jaccard);
  }
};

const tokenCountBucket: Feature = {
  id: "segment.token_count_bucket",
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

const numericRatio: Feature = {
  id: "segment.numeric_ratio",
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const text = ctx.lines[lineIndex]?.slice(start, end) ?? "";

    const digits = (text.match(/\d/g) ?? []).length;
    const total = text.length || 1;

    return clamp(digits / total);
  }
};

const tokenRepetitionScore: Feature = {
  id: "token.repetition_score",
  apply(ctx) {
    if (!ctx.candidateSpan || !ctx.schemaStats) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const token = ctx.lines[lineIndex]?.slice(start, end) ?? "";

    const freq = ctx.schemaStats.tokenFrequency[token] ?? 0;
    const entityCount = ctx.schemaStats.entityCount || 1;

    return clamp(freq / entityCount);
  }
};

const delimiterContextIsolation: Feature = {
  id: "token.context_isolation",
  apply(ctx) {
    if (!ctx.candidateSpan) return 0;

    const { lineIndex, start, end } = ctx.candidateSpan;
    const line = ctx.lines[lineIndex];

    const left = line?.[start - 1] ?? "";
    const right = line?.[end] ?? "";

    const score =
      (/\s/.test(left) ? 0.5 : 0) +
      (/\s/.test(right) ? 0.5 : 0);

    return score;
  }
};

const relativePositionConsistency: Feature = {
  id: "field.relative_position_consistency",
  apply(ctx) {
    if (!ctx.candidateSpan || !ctx.previousEntity) return 0;

    const { start } = ctx.candidateSpan;
    const mean = ctx.previousEntity.meanFieldStart;

    const delta = Math.abs(start - mean);

    return clamp(1 - delta / 40);
  }
};

const optionalFieldPenalty: Feature = {
  id: "field.optional_penalty",
  apply(ctx) {
    if (!ctx.schemaStats) return 0;

    const optionalProb = ctx.schemaStats.optionalFieldProbability ?? 0.5;

    return clamp(-1 + optionalProb);
  }
};

function scoreHypothesis(
  features: Feature[],
  weights: Record<string, number>,
  ctx: FeatureContext
): number {
  let score = 0;

  for (const f of features) {
    const w = weights[f.id] ?? 0;
    score += w * f.apply(ctx);
  }

  return score;
}

type BoundaryState = "B" | "C";
type FieldLabel = "F1" | "F2" | "F3" | "NOISE";

interface JointState {
  boundary: BoundaryState;
  fields: FieldLabel[];
}

const STATES: BoundaryState[] = ["B", "C"];

interface TransitionWeights {
  B_to_B: number;
  B_to_C: number;
  C_to_B: number;
  C_to_C: number;
}

const defaultTransitions: TransitionWeights = {
  B_to_B: -0.2,
  B_to_C: 0.8,
  C_to_B: 0.6,
  C_to_C: 0.4
};

interface LineSpans {
  lineIndex: number;
  spans: Array<{
    start: number;
    end: number;
  }>;
}

const segmentFeatures: Feature[] = [
  tokenCountBucket,
  numericRatio,
  relativePositionConsistency,
  optionalFieldPenalty
];


const boundaryFeatures: Feature[] = [
  indentationDelta,
  lexicalSimilarityDrop
];

function emissionScore(
  state: BoundaryState,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  let score = 0;

  for (const f of boundaryFeatures) {
    const value = f.apply(ctx);
    const w = weights[f.id] ?? 0;

    // Features support boundary by default
    if (state === "B") {
      score += w * value;
    } else {
      score -= w * value;
    }
  }

  return score;
}

function enumerateStates(
  spans: LineSpans,
  maxFields = 3
): JointState[] {
  const states: JointState[] = [];

  const fieldLabels: FieldLabel[] = ["F1", "F2", "F3", "NOISE"];

  function backtrack(i: number, acc: FieldLabel[]) {
    if (i === spans.spans.length) {
      states.push({ boundary: "B", fields: [...acc] });
      states.push({ boundary: "C", fields: [...acc] });
      return;
    }

    for (const f of fieldLabels) {
      if (f !== "NOISE" && acc.includes(f)) continue;
      acc.push(f);
      backtrack(i + 1, acc);
      acc.pop();
    }
  }

  backtrack(0, []);
  return states;
}

function boundaryEmissionScore(
  state: BoundaryState,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  let score = 0;

  for (const f of boundaryFeatures) {
    const v = f.apply(ctx);
    const w = weights[f.id] ?? 0;
    score += state === "B" ? w * v : -w * v;
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
    if (label === "NOISE") continue;

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

function jointEmissionScore(
  state: JointState,
  spans: LineSpans,
  ctx: FeatureContext,
  weights: Record<string, number>
): number {
  return (
    boundaryEmissionScore(state.boundary, ctx, weights) +
    fieldEmissionScore(state.fields, spans, ctx, weights)
  );
}

function transitionScore(
  prev: JointState,
  curr: JointState,
  weights: Record<string, number>
): number {
  let score = 0;

  if (prev.boundary === "B" && curr.boundary === "B") {
    score += weights["transition.B_to_B"] ?? -0.5;
  }

  if (prev.boundary === "C" && curr.boundary === "C") {
    score += weights["transition.C_to_C"] ?? 0.3;
  }

  if (curr.boundary === "B") {
    score += weights["transition.any_to_B"] ?? 0.4;
  }

  return score;
}



interface ViterbiCell {
  score: number;
  prev: BoundaryState | null;
}

function viterbiDecodeBoundaries(
  lines: string[],
  featureWeights: Record<string, number>,
  transitionWeights: TransitionWeights
): BoundaryState[] {
  const T = lines.length;
  const lattice: Record<BoundaryState, ViterbiCell>[] = [];

  // Initialization
  lattice[0] = {
    B: { score: 0, prev: null },
    C: { score: -Infinity, prev: null } // cannot continue at start
  };

  // Dynamic programming
  for (let t = 1; t < T; t++) {
    lattice[t] = {} as any;

    for (const curr of STATES) {
      let bestScore = -Infinity;
      let bestPrev: BoundaryState | null = null;

      for (const prev of STATES) {
        const transition =
          transitionWeights[`${prev}_to_${curr}` as keyof TransitionWeights];

        const ctx: FeatureContext = {
          lineIndex: t,
          lines
        };

        const score =
          lattice[t - 1]![prev].score +
          transition +
          emissionScore(curr, ctx, featureWeights);

        if (score > bestScore) {
          bestScore = score;
          bestPrev = prev;
        }
      }

      lattice[t]![curr] = {
        score: bestScore,
        prev: bestPrev
      };
    }
  }

  // Backtrace
  let lastState: BoundaryState =
    lattice[T - 1]!.B.score > lattice[T - 1]!.C.score ? "B" : "C";

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

function jointViterbiDecode(
  lines: string[],
  spansPerLine: LineSpans[],
  featureWeights: Record<string, number>
): JointState[] {
  const lattice: VCell[][] = [];
  const stateSpaces: JointState[][] = [];

  for (const spans of spansPerLine) {
    stateSpaces.push(enumerateStates(spans));
  }

  // Initialization
  lattice[0] = stateSpaces[0]?.map(() => ({
    score: 0,
    prev: null
  })) ?? [];

  // DP
  for (let t = 1; t < lines.length; t++) {
    lattice[t] = [];

    for (let i = 0; i < stateSpaces[t]!.length; i++) {
      let bestScore = -Infinity;
      let bestPrev: number | null = null;

      for (let j = 0; j < stateSpaces[t - 1]!.length; j++) {
        const ctx: FeatureContext = {
          lineIndex: t,
          lines
        };

        const score =
          lattice[t - 1]![j]!.score +
          transitionScore(
            stateSpaces[t - 1]![j]!,
            stateSpaces[t]![i]!,
            featureWeights
          ) +
          jointEmissionScore(
            stateSpaces[t]![i]!,
            spansPerLine[t]!,
            ctx,
            featureWeights
          );

        if (score > bestScore) {
          bestScore = score;
          bestPrev = j;
        }
      }

      lattice[t]![i] = {
        score: bestScore,
        prev: bestPrev
      };
    }
  }

  // Backtrace
  let lastIndex = lattice[lines.length - 1]!
    .map((c, i) => ({ i, score: c.score }))
    .sort((a, b) => b.score - a.score)[0]!.i;

  const path: JointState[] = [];

  for (let t = lines.length - 1; t >= 0; t--) {
    path.unshift(stateSpaces[t]![lastIndex]!);
    lastIndex = lattice[t]![lastIndex]!.prev!;
  }

  return path;
}


function naiveSpanGenerator(
  lines: string[]
): LineSpans[] {
  return lines.map((line, lineIndex) => {
    const spans: Array<{ start: number; end: number }> = [];
    let cursor = 0;

    for (const part of line.split("|")) {
      const trimmed = part.trim();
      const start = line.indexOf(trimmed, cursor);
      const end = start + trimmed.length;
      spans.push({ start, end });
      cursor = end;
    }

    return { lineIndex, spans };
  });
}

export { viterbiDecodeBoundaries, jointViterbiDecode, naiveSpanGenerator, defaultTransitions };


