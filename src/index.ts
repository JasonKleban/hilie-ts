// Curated public API
export type { Feature, FeatureContext, JointState, JointSequence, LineSpans, FieldSpan, Feedback, TransitionWeights, BoundaryState } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export {
  decodeJointSequence,
  enumerateStates, extractJointFeatureVector,
  updateWeightsFromUserFeedback, entitiesFromJointSequence,
  annotateEntityTypesInSequence
} from './lib/viterbi.js';
export { spanGenerator } from './lib/utils.js';



