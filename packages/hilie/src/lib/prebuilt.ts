/**
 * Pre-built domain-specific configurations for the household information domain.
 * These provide sensible defaults for callers but are not required—
 * callers can define their own field schemas, features, and validators.
 */

import type { LabelModel, SpanLabelFeatureContext, SpanLabelScoringContext } from './labelModel.js';

export const defaultWeights: Record<string, number> = {
  'line.leading_extid': 1.0,
  'line.has_name': 0.8,
  'line.has_birthdate': 0.5,
  'line.has_key_value_pattern': 0.4,
  'line.has_list_marker': 0.3,
  'line.short_token_count': 0.4,
  'line.next_has_contact': 0.5,
  'line.field_density': 0.6,
  'line.avg_token_length': 0.3,
  'line.indentation_delta': 0.5,
  'line.lexical_similarity_drop': 0.3,
  'line.blank_line': -0.2,
  'line.primary_likely': 1.2,
  'line.guardian_likely': 0.8,

  'segment.is_extid': 1.0,
  'segment.is_name': 1.4,
  'segment.is_preferred_name': 0.9,
  'segment.is_birthdate': 1.2,
  'segment.is_email': 1.5,
  'segment.is_phone': 1.8,
  'segment.all_caps': 0.3,
  'segment.title_case': 0.6,
  'segment.initial_caps': 0.4,
  'segment.mixed_case': 0.2,
  'segment.digit_pattern': 0.4,
  'segment.contains_month': 0.7,
  'segment.contains_day_suffix': 0.6,
  'segment.common_first_name': 0.5,
  'segment.has_special_chars': 0.3,
  'segment.punctuation_ratio': 0.2,
  'segment.char_length_bucket': 0.4,
  'segment.prefix_2': 0.3,
  'segment.suffix_2': 0.2,
  'segment.token_count_bucket': 0.4,
  'segment.numeric_ratio': 0.5,
  'token.repetition_score': -0.3,
  'token.context_isolation': 0.5,
  'field.relative_position_consistency': 0.4,
  'field.optional_penalty': -0.2,

  'transition.B_to_B': -0.5,
  'transition.C_to_C': 0.3,
  'transition.any_to_B': 0.4
};

export const defaultLabelModel: LabelModel = {
  featureContribution({ label, spanText, featureId, featureValue }: SpanLabelFeatureContext): number {
    if (featureId === 'segment.is_phone') {
      return label === 'Phone' ? featureValue : -0.5 * featureValue;
    }
    if (featureId === 'segment.is_email') {
      return label === 'Email' ? featureValue : -0.5 * featureValue;
    }
    if (featureId === 'segment.is_extid') {
      const exact10or11Digits = /^\d{10,11}$/.test(spanText.replace(/\D/g, ''));
      if (exact10or11Digits) {
        return (label === 'ExtID') ? -0.8 * featureValue : (label === 'Phone') ? 0.7 * featureValue : -0.3 * featureValue;
      }
      return label === 'ExtID' ? featureValue : -0.5 * featureValue;
    }
    if (featureId === 'segment.is_name') {
      return label === 'Name' ? featureValue : -0.5 * featureValue;
    }
    if (featureId === 'segment.is_preferred_name') {
      return label === 'PreferredName' ? featureValue : -0.5 * featureValue;
    }
    if (featureId === 'segment.is_birthdate') {
      return label === 'Birthdate' ? featureValue : -0.5 * featureValue;
    }
    return featureValue;
  },

  scoreSpanLabel({ label, spanText, spanFeatures, weights, schema }: SpanLabelScoringContext): number {
    if (label === schema.noiseLabel) return 0;
    let score = 0;
    for (const [fid, v] of Object.entries(spanFeatures)) {
      const transformed = this.featureContribution
        ? this.featureContribution({ label, spanText, featureId: fid, featureValue: v ?? 0, schema })
        : (v ?? 0);
      score += (weights[fid] ?? 0) * transformed;
    }
    return score;
  }
};

