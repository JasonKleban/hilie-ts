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
  | 'Name'
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

// A sequence of per-line joint assignments; use this alias for clarity when
// passing around an entire document's joint decode result.
export type JointSequence = JointState[];

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

// Richer span and entity types for external API
export interface FieldSpan {
  // line relative positions
  lineIndex: number;
  start: number;
  end: number;
  text: string;

  // file-relative positions (character offsets)
  fileStart: number;
  fileEnd: number;

  // entity-relative positions (character offsets relative to entity start)
  entityStart?: number;
  entityEnd?: number;

  // assigned label and confidence (0..1)
  fieldType?: FieldLabel | undefined;
  confidence?: number | undefined;
}

// New: sub-entity and top-level record types
export type SubEntityType = 'Primary' | 'Guardian' | 'Unknown';

export interface SubEntitySpan {
  startLine: number;
  endLine: number;
  fileStart: number;
  fileEnd: number;
  entityType?: SubEntityType;
  fields: FieldSpan[];
}

export interface RecordSpan {
  // top-level record contains one Primary and zero or more Guardian sub-entities
  startLine: number;
  endLine: number;
  fileStart: number;
  fileEnd: number;
  subEntities: SubEntitySpan[];
}

export interface FieldAssertion extends Partial<FieldSpan> {
  // action: 'add' to assert new span; 'remove' to remove an existing span
  action?: 'add' | 'remove';
  // asserted confidence (0..1)
  confidence?: number;
}

export interface EntityAssertion {
  startLine?: number;
  endLine?: number;
  fileStart?: number;
  fileEnd?: number;
  entityType?: EntityType;
  fields?: FieldAssertion[];
}

export interface Feedback {
  // list of asserted entity-level edits
  entities: EntityAssertion[];
}
