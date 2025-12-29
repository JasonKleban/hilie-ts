// Curated public API
export type { Feature, FeatureContext, JointState, LineSpans, TransitionWeights, BoundaryState } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export { jointViterbiDecode, enumerateStates } from './lib/viterbi.js';
export { naiveSpanGenerator } from './lib/utils.js';



