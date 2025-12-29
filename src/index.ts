// Curated public API
export type { Feature, FeatureContext, JointState, LineSpans, TransitionWeights, BoundaryState } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export { jointViterbiDecode, enumerateStates, annotateEntityTypes, inferRelationships, extractFeatureVector, updateWeightsFromExample } from './lib/viterbi.js';
export { naiveSpanGenerator, spanGenerator } from './lib/utils.js';



