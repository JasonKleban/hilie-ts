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

/**
 * FieldLabel can be any string. The special 'NOISE' label represents
 * unknown or non-field spans. All other labels are domain-defined.
 */
export type FieldLabel = string;

/**
 * FieldConfig describes a single field in the schema.
 */
export interface FieldConfig {
  name: FieldLabel;
  /**
   * Whether this field must be present in every record.
   * Defaults to false (field is optional).
   */
  required?: boolean;
  /**
   * Maximum number of times this field can appear.
   * Defaults to 1 (field can appear at most once).
   */
  maxAllowed?: number;
  /**
   * Optional list of feature IDs that should be considered for this field.
   * If not provided, all features are candidate.
   */
  applicableFeatures?: string[];
  /**
   * Optional list of validator function IDs (from validators map) to apply.
   */
  validators?: string[];
}

/**
 * FieldSchema describes the complete field structure for a decoding task.
 */
export interface FieldSchema {
  fields: FieldConfig[];
  /**
   * Special marker field that represents "not a field" or "noise".
   * Usually "NOISE" but can be customized.
   */
  noiseLabel: FieldLabel;
}

/**
 * EnumerateOptions controls the state space generation and constraints.
 */
export interface EnumerateOptions {
  maxUniqueFields?: number; // distinct non-NOISE fields allowed
  maxStatesPerField?: Record<FieldLabel, number>; // per-field multiplicity caps (replaces maxPhones, maxEmails)
  safePrefix?: number; // how many spans to fully enumerate before tailing with NOISE
  maxStates?: number; // overall state cap to avoid explosion
  debugFreshDecode?: boolean; // enable diagnostic logging for decoder path selection
  whitespaceSpanIndices?: Set<number>; // indices of spans that are whitespace-only and should be forced to NOISE
  // Optional per-line forced label map. Keyed by lineIndex -> { "start-end": FieldLabel }
  forcedLabelsByLine?: Record<number, Record<string, FieldLabel>>;
  // Optional per-line forced boundary map. Keyed by lineIndex -> 'B'|'C'
  forcedBoundariesByLine?: Record<number, BoundaryState>;
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
