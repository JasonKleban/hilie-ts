import type { FieldLabel, FieldSchema } from './types.js';

export interface SpanLabelScoringContext {
  label: FieldLabel;
  spanText: string;
  spanFeatures: Record<string, number>;
  weights: Record<string, number>;
  schema: FieldSchema;
}

export interface SpanLabelFeatureContext {
  label: FieldLabel;
  spanText: string;
  featureId: string;
  featureValue: number;
  schema: FieldSchema;
}

export interface LabelModel {
  /**
   * Optionally transform a raw feature value based on the proposed label.
   * This is how label-aware feature coupling (e.g. is_phone -> Phone) is expressed.
   */
  featureContribution?(ctx: SpanLabelFeatureContext): number;
  scoreSpanLabel(ctx: SpanLabelScoringContext): number;
}

export function allLabelsForSchema(schema: FieldSchema): FieldLabel[] {
  return schema.fields.map(f => f.name).concat(schema.noiseLabel);
}

export const naiveLabelModel: LabelModel = {
  featureContribution({ featureValue }): number {
    return featureValue;
  },
  scoreSpanLabel({ label, spanFeatures, weights, schema }): number {
    if (label === schema.noiseLabel) return 0;
    let score = 0;
    for (const [fid, v] of Object.entries(spanFeatures)) {
      score += (weights[fid] ?? 0) * (v ?? 0);
    }
    return score;
  }
};
