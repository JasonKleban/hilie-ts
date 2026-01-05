import { pushUniqueFields, buildFeedbackFromHistories, removeEntityConflicts } from '../lib/feedbackUtils.js'
import { spanGenerator } from '../lib/utils.js'
import { decodeJointSequence, updateWeightsFromUserFeedback, entitiesFromJointSequence } from '../lib/viterbi.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import type { FieldAssertion, EntityAssertion } from '../lib/types.js'
import { householdInfoSchema } from './test-helpers.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// pushUniqueFields dedupes and merges
function testPushUniqueFields() {
  const a: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3, fieldType: 'Name', action: 'add' }]
  const b: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3, fieldType: 'Name', action: 'add' }, { lineIndex: 1, start: 5, end: 10, fieldType: 'Email', action: 'add' }]
  const res = pushUniqueFields(a, b)
  assert(res.length === 2, 'pushUniqueFields merges and dedupes')
}

// buildFeedbackFromHistories merges entities and fields
function testBuildFeedback() {
  const entityHist: EntityAssertion[] = [{ startLine: 0, entityType: 'Primary' }]
  const fieldHist: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3, fieldType: 'Name', action: 'add' }, { lineIndex: 1, start: 0, end: 5, fieldType: 'Email', action: 'add' }]
  const fb = buildFeedbackFromHistories(entityHist, fieldHist, new Set([0]))
  // Expect an entry seeded at the boundary (line 0) and an entry for the ungrouped field line (line 1)
  assert(fb.entities.length === 2, 'buildFeedback should include entity entries for both lines with either entities or fields')
  const ent0 = fb.entities.find(e => e.startLine === 0)
  const ent1 = fb.entities.find(e => e.startLine === 1)
  assert(Boolean(ent0 && ent0.fields && ent0.fields.length === 1), 'entity at line 0 should have attached field')
  assert(Boolean(ent1 && ent1.fields && ent1.fields.length === 1), 'entity at line 1 should have attached field')
}

// removeEntityConflicts removes overlapping items
function testRemoveEntityConflicts() {
  const entityHist: EntityAssertion[] = [{ startLine: 0 }, { startLine: 3 }]
  const fieldHist: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3 }, { lineIndex: 3, start: 0, end: 2 }, { lineIndex: 4, start: 0, end: 2 }]
  const boundarySet = new Set([0,3,4])
  const { remainingEntities, newFieldHist, newBoundarySet } = removeEntityConflicts(entityHist, fieldHist, boundarySet, 3, 4)
  assert(remainingEntities.length === 1 && remainingEntities[0]!.startLine === 0, 'removeEntityConflicts removes overlapping entities')
  assert(newFieldHist.length === 1 && newFieldHist[0]!.lineIndex === 0, 'removeEntityConflicts removes overlapping fields')
  assert(!newBoundarySet.has(3) && !newBoundarySet.has(4) && newBoundarySet.has(0), 'removeEntityConflicts cleans up boundaries')
}

// New test: ensure entity-level type assertions (Primary + Guardian) get applied
function testFeedbackTwoEntities() {
  const lines = [
    'ID1 Alice\t410-111-1111\talice@example.com',
    'Other info line 1',
    'Other info line 2',
    'Other info line 3',
    'Other info line 4',
    'Parent: Bob\t555-222-2222\tbob@example.com'
  ]
  const spans = spanGenerator(lines, { delimiterRegex: /\t/ })
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  // Build entity-only feedback and submit via the helper and update routine
  const entityHist: EntityAssertion[] = [{ startLine: 0, entityType: 'Primary' }, { startLine: 5, entityType: 'Guardian' }]
  const fb = buildFeedbackFromHistories(entityHist, [], new Set())

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, { ...weights }, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })

  // Diagnostic: raw decode with forced boundaries only (no entityType) —
  // this demonstrates why a plain decode may not result in a Guardian role
  // (annotateEntityTypes heuristics may mark Guardians as 'Unknown' if no
  // nearby Primary exists within MAX_DISTANCE)
  const forcedOpts = { forcedBoundariesByLine: { 0: 'B', 5: 'B' } }
  const rawPred = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, forcedOpts as any)
  const rawRecords = entitiesFromJointSequence(lines, spans, rawPred, weights, segmentFeatures, householdInfoSchema)
  // rawRecords[1] may have a subEntity entityType of 'Unknown' due to heuristics

  // Diagnostic output when expectations aren't met
  try {
    assert(Boolean(res.pred[0] && res.pred[0]!.entityType === 'Primary'), 'line 0 should be Primary')
    assert(Boolean(res.pred[5] && res.pred[5]!.entityType === 'Guardian'), 'line 5 should be Guardian')
  } catch (err) {
    // print helpful context
    // eslint-disable-next-line no-console
    console.error('DBG: pred after update:', JSON.stringify(res.pred, null, 2))
    // eslint-disable-next-line no-console
    console.error('DBG: rawPred (forced boundaries only):', JSON.stringify(rawPred, null, 2))
    // eslint-disable-next-line no-console
    console.error('DBG: rawRecords:', JSON.stringify(rawRecords, null, 2))
    // eslint-disable-next-line no-console
    console.error('DBG: feedback submitted:', JSON.stringify(fb, null, 2))
    const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
    // eslint-disable-next-line no-console
    console.error('DBG: records from entitiesFromJointSequence:', JSON.stringify(records, null, 2))
    throw err
  }

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  assert(records.length >= 2, 'there should be at least two top-level records')
  assert(records[0]!.subEntities[0]!.entityType === 'Primary', 'first sub-entity should be Primary')
  assert(records[1]!.subEntities[0]!.entityType === 'Guardian', 'second sub-entity should be Guardian')

  console.log('✓ feedback two-entity assertions respected')
}

// Run tests
testPushUniqueFields()
testBuildFeedback()
testRemoveEntityConflicts()
testFeedbackTwoEntities()

console.log('✓ feedbackUtils tests passed')
