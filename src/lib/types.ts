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
export type FieldLabel =
  | 'ExtID'
  | 'FullName'
  | 'PreferredName'
  | 'Phone'
  | 'Email'
  | 'GeneralNotes'
  | 'MedicalNotes'
  | 'DietaryNotes'
  | 'Birthdate'
  | 'NOISE';

export interface EnumerateOptions {
  maxUniqueFields?: number; // distinct non-NOISE fields allowed
  maxPhones?: number; // cap for repeatable Phone labels
  maxEmails?: number; // cap for repeatable Email labels
  safePrefix?: number; // how many spans to fully enumerate before tailing with NOISE
  maxStates?: number; // overall state cap to avoid explosion
}

export type EntityType = 'Primary' | 'Guardian' | 'Unknown';

export interface JointState {
  boundary: BoundaryState;
  fields: FieldLabel[];
  entityType?: EntityType;
}

export interface Relationship {
  primaryIndex: number;
  guardianIndex: number;
}

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
  spans: {
    start: number;
    end: number;
  }[];
}
