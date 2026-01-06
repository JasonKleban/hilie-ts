// Curated public API
export type { FieldSchema, Feature, FeatureContext, FieldLabel, JointState, JointSequence, LineSpans, FieldSpan, Feedback, FeedbackEntry, FieldAssertion, EntityType, SubEntityType, TransitionWeights, BoundaryState, RecordSpan, SubEntitySpan } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export {
  decodeJointSequence,
  decodeJointSequenceWithFeedback,
  enumerateStates, extractJointFeatureVector,
  updateWeightsFromUserFeedback, entitiesFromJointSequence,
  annotateEntityTypesInSequence
} from './lib/viterbi.js';
export { detectDelimiter, spanGenerator, candidateSpanGenerator, coverageSpanGenerator, coverageSpanGeneratorFromCandidates } from './lib/utils.js';
export { boundaryFeatures, segmentFeatures } from "./lib/features.js"
export { defaultLabelModel, defaultWeights } from './lib/prebuilt.js';
export type { LabelModel, SpanLabelScoringContext, SpanLabelFeatureContext } from './lib/labelModel.js';
export { pushUniqueFields, buildFeedbackFromHistories, normalizeFeedbackEntries, normalizeFeedback, removeEntityConflicts } from './lib/feedbackUtils.js'



