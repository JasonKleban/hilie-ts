// Curated public API
export type { FieldSchema, Feature, FeatureContext, FieldLabel, JointState, JointSequence, LineSpans, FieldSpan, Feedback, FeedbackEntry, FieldAssertion, EntityType, TransitionWeights, BoundaryState, RecordSpan, EntitySpan } from './lib/types.js';
export { defaultTransitions } from './lib/types.js';
export {
  decodeJointSequenceWithFeedback,
  decodeFullViaStreaming, decodeNextRecord, decodeRecordsStreaming,
  enumerateStates, extractJointFeatureVector,
  updateWeightsFromUserFeedback, entitiesFromJointSequence,
  annotateEntityTypesInSequence
} from './lib/viterbi.js';
export { splitIntoRecordsFromLines, recordsFromLines, recordsByIndentation, linesFromChunks } from './lib/recordSplitter.js'
export { detectDelimiter, spanGenerator, candidateSpanGenerator, coverageSpanGenerator, coverageSpanGeneratorFromCandidates } from './lib/utils.js';
export { boundaryFeatures, segmentFeatures, analyzeFileLevelFeatures, dynamicCandidatesToFeatures } from "./lib/features.js"
export type { FeatureCandidate, FeatureAnalysis } from './lib/features.js'
export { defaultLabelModel, defaultWeights } from './lib/prebuilt.js';
export type { LabelModel, SpanLabelScoringContext, SpanLabelFeatureContext } from './lib/labelModel.js';
export { pushUniqueFields, buildFeedbackFromHistories, normalizeFeedbackEntries, normalizeFeedback, removeEntityConflicts } from './lib/feedbackUtils.js'



