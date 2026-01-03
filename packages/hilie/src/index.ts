// Curated public API
export type { FieldSchema, Feature, FeatureContext, JointState, JointSequence, LineSpans, FieldSpan, Feedback, FieldAssertion, EntityAssertion, TransitionWeights, BoundaryState, RecordSpan, SubEntitySpan } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export {
  decodeJointSequence,
  enumerateStates, extractJointFeatureVector,
  updateWeightsFromUserFeedback, entitiesFromJointSequence,
  annotateEntityTypesInSequence
} from './lib/viterbi.js';
export { spanGenerator } from './lib/utils.js';
export { boundaryFeatures, segmentFeatures } from "./lib/features.js"



