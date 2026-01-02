// Curated public API
export type { Feature, FeatureContext, JointState, JointSequence, LineSpans, FieldSpan, Feedback, TransitionWeights, BoundaryState } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export { decodeJointSequence as jointViterbiDecode, enumerateStates, extractJointFeatureVector as extractFeatureVector, updateWeightsFromGoldSequence as updateWeightsFromExample, updateWeightsFromUserFeedback as updateWeightsFromFeedback, entitiesFromJointSequence, annotateEntityTypesInSequence as annotateEntityTypes } from './lib/viterbi.js';
export { spanGenerator } from './lib/utils.js';



