export interface EntityStats {
  meanFieldStart: number;
}

export interface SchemaStats {
  entityCount: number;
  tokenFrequency: Record<string, number>;
  optionalFieldProbability?: number;
}

export interface FeatureContext {
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

export interface Feature {
  id: string;
  apply(ctx: FeatureContext): number;
}

export type BoundaryState = "B" | "C";
export type FieldLabel = "F1" | "F2" | "F3" | "NOISE";

export interface JointState {
  boundary: BoundaryState;
  fields: FieldLabel[];
}

export const STATES: BoundaryState[] = ["B", "C"];

export interface TransitionWeights {
  B_to_B: number;
  B_to_C: number;
  C_to_B: number;
  C_to_C: number;
}

export const defaultTransitions: TransitionWeights = {
  B_to_B: -0.2,
  B_to_C: 0.8,
  C_to_B: 0.6,
  C_to_C: 0.4
};

export interface LineSpans {
  lineIndex: number;
  spans: Array<{
    start: number;
    end: number;
  }>;
}
