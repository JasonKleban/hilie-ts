// Curated public API
export type { Feature, FeatureContext, JointState, LineSpans, FieldSpan, EntitySpan, Feedback, TransitionWeights, BoundaryState } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export { jointViterbiDecode, enumerateStates, extractFeatureVector, updateWeightsFromExample, updateWeightsFromFeedback, entitiesFromJoint, annotateEntityTypes, inferRelationships } from './lib/viterbi.js';
export { spanGenerator } from './lib/utils.js';



