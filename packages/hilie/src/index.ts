// Curated public API
export type { FieldSchema, Feature, FeatureContext, JointState, JointSequence, LineSpans, FieldSpan, Feedback, FeedbackEntry, FieldAssertion, EntityAssertion, RecordAssertion, SubEntityAssertion, EntityType, SubEntityType, TransitionWeights, BoundaryState, RecordSpan, SubEntitySpan } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export {
  decodeJointSequence,
  decodeJointSequenceWithFeedback,
  enumerateStates, extractJointFeatureVector,
  updateWeightsFromUserFeedback, entitiesFromJointSequence,
  annotateEntityTypesInSequence
} from './lib/viterbi.js';
export { spanGenerator } from './lib/utils.js';
export { boundaryFeatures, segmentFeatures } from "./lib/features.js"
export { pushUniqueFields, buildFeedbackFromHistories, normalizeFeedbackEntries, normalizeFeedback, removeEntityConflicts } from './lib/feedbackUtils.js'



