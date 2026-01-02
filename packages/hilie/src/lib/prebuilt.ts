/**
 * Pre-built domain-specific configurations for the household information domain.
 * These provide sensible defaults for callers but are not required—
 * callers can define their own field schemas, features, and validators.
 */

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

