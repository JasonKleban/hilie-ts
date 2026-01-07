import { pushUniqueFields, buildFeedbackFromHistories, removeEntityConflicts, normalizeFeedbackEntries, normalizeFeedback } from '../lib/feedbackUtils.js'
import { spanGenerator } from '../lib/utils.js'
import { decodeJointSequence, decodeJointSequenceWithFeedback, updateWeightsFromUserFeedback, entitiesFromJointSequence } from '../lib/viterbi.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import type { FieldAssertion, FeedbackEntry } from '../lib/types.js'
import { householdInfoSchema } from './test-helpers.js'
import path from 'path'
import { existsSync, readFileSync } from 'fs'

declare const test: any;

type EntityAssertion = {
  startLine: number;
  endLine: number;
  entityType?: any;
  fields?: FieldAssertion[];
}

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

// buildFeedbackFromHistories merges record/sub-entity assertions and fields
function testBuildFeedback() {
  const entityHist: EntityAssertion[] = [{ startLine: 0, endLine: 0, entityType: 'Primary', fields: [] }]
  const fieldHist: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3, fieldType: 'Name', action: 'add' }, { lineIndex: 1, start: 0, end: 5, fieldType: 'Email', action: 'add' }]
  const fb = buildFeedbackFromHistories(entityHist, fieldHist, new Set([0]))
  const entries = fb.entries
  assert(entries.some(e => e.kind === 'record' && e.startLine === 0 && e.endLine === 0), 'buildFeedback should include a record entry for the boundary line')
  assert(entries.some(e => e.kind === 'subEntity'), 'buildFeedback should include the subEntity entry')
  assert(entries.filter(e => e.kind === 'field').length === 2, 'buildFeedback should include field entries')
}

// removeEntityConflicts removes overlapping items
function testRemoveEntityConflicts() {
  const entityHist: EntityAssertion[] = [{ startLine: 0, endLine: 0, fields: [] }, { startLine: 3, endLine: 3, fields: [] }]
  const fieldHist: FieldAssertion[] = [
    { action: 'add', fieldType: 'Name', lineIndex: 0, start: 0, end: 3 },
    { action: 'add', fieldType: 'Name', lineIndex: 3, start: 0, end: 2 },
    { action: 'add', fieldType: 'Name', lineIndex: 4, start: 0, end: 2 }
  ]
  const boundarySet = new Set([0,3,4])
  const { remainingEntities, newFieldHist, newBoundarySet } = removeEntityConflicts(entityHist, fieldHist, boundarySet, 3, 4)
  assert(remainingEntities.length === 1 && remainingEntities[0]!.startLine === 0, 'removeEntityConflicts removes overlapping entities')
  assert(newFieldHist.length === 1 && newFieldHist[0]!.lineIndex === 0, 'removeEntityConflicts removes overlapping fields')
  assert(!newBoundarySet.has(3) && !newBoundarySet.has(4) && newBoundarySet.has(0), 'removeEntityConflicts cleans up boundaries')
}

function testNormalizeFeedbackEntriesKeepsRemoveFields() {
  const entries: FeedbackEntry[] = [
    { kind: 'field', field: { action: 'remove', lineIndex: 0, start: 0, end: 3, fieldType: 'Name', confidence: 1.0 } },
    { kind: 'field', field: { action: 'add', lineIndex: 0, start: 5, end: 8, fieldType: 'Email', confidence: 1.0 } }
  ]

  const norm = normalizeFeedbackEntries(entries)
  const rec0 = norm.entities.find(e => (e as any).entityType === undefined && e.startLine === 0 && e.endLine === 0)
  assert(Boolean(rec0), 'normalizeFeedbackEntries should create/keep an entity container for field-only feedback')
  const fields: FieldAssertion[] = ((rec0 as any)?.fields ?? []) as FieldAssertion[]
  assert(fields.some((f: FieldAssertion) => (f.action ?? 'add') === 'remove' && f.start === 0 && f.end === 3), 'normalizeFeedbackEntries should preserve remove assertions')
  assert(fields.some((f: FieldAssertion) => (f.action ?? 'add') !== 'remove' && f.start === 5 && f.end === 8), 'normalizeFeedbackEntries should preserve add assertions')
}

// New test: ensure entity-level type assertions (Primary + Guardian) get applied
function testFeedbackTwoEntities() {
  const lines: string[] = [
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
  // Create file-level sub-entity assertions to avoid relying on startLine/endLine
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const fb: any = { entries: [
    { kind: 'subEntity', fileStart: lineStarts[0]!, fileEnd: lineStarts[0]! + lines[0]!.length, entityType: 'Primary' },
    { kind: 'subEntity', fileStart: lineStarts[5]!, fileEnd: lineStarts[5]! + lines[5]!.length, entityType: 'Guardian' }
  ] }

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
    throw err
  }

  const normalizedFb = normalizeFeedback(fb, lines)
  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema, normalizedFb.subEntities)
  assert(records.length >= 2, 'there should be at least two top-level records')
  assert(records[0]!.subEntities[0]!.entityType === 'Primary', 'first sub-entity should be Primary')
  assert(records[1]!.subEntities[0]!.entityType === 'Guardian', 'second sub-entity should be Guardian')
  // New assertion: when file-offset sub-entity feedback is provided, the rendered sub-entity should preserve asserted file offsets (no whole-line snap)
  const fbPrimary = normalizedFb.subEntities.find(s => s.entityType === 'Primary')!
  const fbGuardian = normalizedFb.subEntities.find(s => s.entityType === 'Guardian')!
  assert(Boolean(fbPrimary && records[0]!.subEntities[0]!.fileStart === fbPrimary.fileStart && records[0]!.subEntities[0]!.fileEnd === fbPrimary.fileEnd), 'primary sub-entity should preserve fileStart/fileEnd')
  assert(Boolean(fbGuardian && records[1]!.subEntities[0]!.fileStart === fbGuardian.fileStart && records[1]!.subEntities[0]!.fileEnd === fbGuardian.fileEnd), 'guardian sub-entity should preserve fileStart/fileEnd')


}

// New test: decodeJointSequenceWithFeedback should normalize candidate spans
// to lie within asserted sub-entity file ranges (so fields outside those
// ranges are not considered as candidates for labeling inside the sub-entity).
function testDecodeWithFeedbackSanitizesCandidates() {
  const text = '  * Joshua Anderson (Grandparent)'
  const lines = [text]
  // Create explicit candidate spans that include an ExtID at 3..9 (outside
  // the asserted sub-entity range at 10..32) and proper name spans afterwards.
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 3 }, { start: 3, end: 9 }, { start: 10, end: 18 }, { start: 19, end: 32 } ] }] as any

  const weights: any = {}
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  // Assert a sub-entity by file offsets that starts at 10 and ends at 32.
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const fb = { entries: [ { kind: 'subEntity', fileStart: lineStarts[0]! + 10, fileEnd: lineStarts[0]! + 32, entityType: 'Guardian' } ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb as any)
  const sanitizedSpans = res.spansPerLine[0]!.spans

  // The ExtID span (3..9) is outside the asserted range and does not
  // overlap it, so it should be kept as a non-conflicting candidate
  const hasExt = sanitizedSpans.some(s => s.start === 3 && s.end === 9)
  assert(hasExt, 'Non-overlapping candidate span outside asserted sub-entity should be kept')

  // At least one span inside 10..32 should remain (the sub-entity area)
  const hasInside = sanitizedSpans.some(s => s.start >= 10 && s.end <= 32)
  assert(hasInside, 'There should be candidate spans inside the asserted sub-entity')

  // Additional test: partial-overlap spans should be removed, while
  // non-overlapping spans outside the assertion are kept.
  const spans2 = [{ lineIndex: 0, spans: [ { start: 0, end: 5 }, { start: 8, end: 12 }, { start: 12, end: 22 }, { start: 21, end: 25 } ] }] as any
  // Assert sub-entity 10..20 on the line
  const fb2 = { entries: [ { kind: 'subEntity', fileStart: lineStarts[0]! + 10, fileEnd: lineStarts[0]! + 20, entityType: 'Guardian' } ] }
  const res2 = decodeJointSequenceWithFeedback(lines, spans2, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb2 as any)
  const s2 = res2.spansPerLine[0]!.spans
  // span 0..5 does not intersect 10..20 -> should be kept
  assert(s2.some(x => x.start === 0 && x.end === 5), 'Non-overlapping span outside assertion should be kept')
  // span 8..12 partially overlaps 10..20 -> remove
  assert(!s2.some(x => x.start === 8 && x.end === 12), 'Partially overlapping span should be removed')
  // span 12..22 partially overlaps 10..20 (extends beyond) -> remove
  assert(!s2.some(x => x.start === 12 && x.end === 22), 'Span overlapping assertion end should be removed')
  // span 21..25 is outside and non-overlapping -> should be kept
  assert(s2.some(x => x.start === 21 && x.end === 25), 'Non-overlapping tail span should be kept')

  // Pred should honor the asserted sub-entity entity type on the corresponding line
  assert(Boolean(res.pred[0] && res.pred[0]!.entityType === 'Guardian'), 'Decoder pred should include forced entityType for line 0')



// New test: forced field label assertions should be honored during decoding
function testDecodeWithForcedFieldLabel() {
  const lines = ['Foo Bar']
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 3 }, { start: 4, end: 7 } ] }] as any
  const weights: any = {}
  const fb = { entries: [ { kind: 'field', field: { action: 'add', lineIndex: 0, start: 0, end: 3, fieldType: 'Name', confidence: 1.0 } } ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb as any)
  // Ensure forced label is present in pred for that span index
  const predFields = res.pred[0]!.fields
  // find index for span 0-3
  const idx = res.spansPerLine[0]!.spans.findIndex(s => s.start === 0 && s.end === 3)
  if (idx < 0) throw new Error('expected forced span to be present in spans')
  if (predFields[idx] !== 'Name') throw new Error(`expected forced label 'Name' at span idx ${idx}, got ${predFields[idx]}`)


}

testDecodeWithForcedFieldLabel()
}

// Register feedbackUtils test functions with Vitest
// Each helper function is invoked inside a `test(...)` call to register it
// as an explicit test case that Vitest will discover and report.




// New test: mark the first two records in case1.txt and ensure decoder produces two record spans
function testFirstTwoCase1Records() {
  // locate case1.txt relative to common run directories
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)
  const txt = readFileSync(filePath, 'utf8')
  const blocks = txt.split(/\r?\n\s*\r?\n(?=\w)/).map((b: string) => b.split(/\r?\n/).filter((l: string) => l.trim().length > 0))

  assert(Boolean(Array.isArray(blocks) && blocks.length >= 2), 'expected case1 to contain at least two blocks')

  const first = blocks[0] as string[]
  const second = blocks[1] as string[]
  const lines: string[] = [...first, ...second]
  const spans = spanGenerator(lines, {})
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  // Assert the first two records by specifying start/end lines (records still use startLine/endLine)
  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]

  // console.log("FIRST", first, "SECOND", second, "Feedback", fbEntities);

  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  // Keep a copy of weights before calling the updater so we can inspect diffs
  const weightsBefore = { ...weights };

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })



  try {
    assert(Boolean(res.pred[0] && res.pred[0]!.boundary === 'B'), 'first block start should be B')
    assert(Boolean(res.pred[first.length] && res.pred[first.length]!.boundary === 'B'), 'second block start should be B')
  } catch (err) {
    throw err
  }

  const fresh = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })
  const finalRecs = entitiesFromJointSequence(lines, spans, fresh, weights, segmentFeatures, householdInfoSchema)

  assert(finalRecs.length === 2, `expected two top-level records after enforcing feedback, got ${finalRecs.length}`)




}

function testSingleCase1RecordRangeTerminates() {
  // locate case1.txt relative to common run directories
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)
  const txt = readFileSync(filePath, 'utf8')
  const blocks = txt.split(/\r?\n\s*\r?\n(?=\w)/).map((b: string) => b.split(/\r?\n/).filter((l: string) => l.trim().length > 0))

  assert(Boolean(Array.isArray(blocks) && blocks.length >= 2), 'expected case1 to contain at least two blocks')

  const first = blocks[0] as string[]
  const second = blocks[1] as string[]
  const lines: string[] = [...first, ...second]
  const spans = spanGenerator(lines, {})
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  // Assert ONLY the first record by specifying its exact start/end line.
  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })

  assert(Boolean(res.pred[0] && res.pred[0]!.boundary === 'B'), 'single asserted record should start with B')
  assert(Boolean(res.pred[first.length] && res.pred[first.length]!.boundary === 'B'), 'single asserted record range should force next line to B (end+1)')

  const finalRecs = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  assert(finalRecs.length >= 2, `expected at least two records after asserting the first record range, got ${finalRecs.length}`)


}

// New test: asserted record/sub-entity/field ranges must not be subdivided
function testAssertedRangesNotSubdivided() {
  const lines: string[] = [
    'Henry Johnson\t45NUMBEU',
    '\t* Eats most school meals.',
    '\t* 2014-05-04',
    'Oliver Smith\tDBYE6KPR',
    '\t* 2014-12-15'
  ]

  const spans = spanGenerator(lines, { delimiterRegex: /\t/ })
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  const nameSpan = spans[0]!.spans[0]!
  const spanIdx = spans[0]!.spans.findIndex(s => s.start === nameSpan.start && s.end === nameSpan.end)
  assert(spanIdx >= 0, 'expected to find the asserted span index on line 0')

  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const entries: FeedbackEntry[] = [
    { kind: 'record', startLine: 0, endLine: 2 },
    { kind: 'subEntity', fileStart: lineStarts[0]!, fileEnd: lineStarts[2]! + lines[2]!.length, entityType: 'Primary' as any },
    { kind: 'field', field: { action: 'add', lineIndex: 0, start: nameSpan.start, end: nameSpan.end, fieldType: 'Name', confidence: 1.0 } }
  ]

  const res = updateWeightsFromUserFeedback(
    lines,
    spans,
    predBefore,
    { entries },
    { ...weights },
    boundaryFeatures,
    segmentFeatures,
    householdInfoSchema,
    1.0,
    { maxStates: 256 }
  )

  // Record must not be further subdivided: only start line is B, and endLine+1 is B.
  assert(Boolean(res.pred[0] && res.pred[0]!.boundary === 'B'), 'asserted record start should be B')
  assert(Boolean(res.pred[1] && res.pred[1]!.boundary !== 'B'), 'asserted record interior should not be B')
  assert(Boolean(res.pred[2] && res.pred[2]!.boundary !== 'B'), 'asserted record interior should not be B')
  assert(Boolean(res.pred[3] && res.pred[3]!.boundary === 'B'), 'asserted record end should force end+1 boundary (no further subdivision)')

  // Sub-entity must not be further subdivided: all lines in the range share the asserted entityType.
  for (let li = 0; li <= 2; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.entityType === 'Primary'), `line ${li} should be Primary due to sub-entity assertion`)
  }

  // Field must not be subdivided: the asserted span retains the label.
  assert(Boolean(res.pred[0] && res.pred[0]!.fields && res.pred[0]!.fields![spanIdx] === 'Name'), 'asserted field span should remain labeled as Name')

  const finalRecs = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  assert(finalRecs.length >= 2, `expected at least two records after boundary enforcement, got ${finalRecs.length}`)
  const firstRec = finalRecs[0]!
  assert(firstRec.startLine === 0 && firstRec.endLine === 2, `expected first record to be exactly lines 0-2, got ${firstRec.startLine}-${firstRec.endLine}`)
  assert(firstRec.subEntities.length === 1, `expected exactly one sub-entity in asserted range, got ${firstRec.subEntities.length}`)
  const se = firstRec.subEntities[0]!
  assert(se.startLine === 0 && se.endLine === 2 && se.entityType === 'Primary', 'asserted sub-entity range should be a single Primary span')

  const matched = se.fields.filter(f => f.lineIndex === 0 && f.start === nameSpan.start && f.end === nameSpan.end && f.fieldType === 'Name')
  assert(matched.length === 1, `expected exactly one Name field matching the asserted span; got ${matched.length}`)


}

function testCase1RecordWithGuardianSubEntityDoesNotSplit() {
  // locate case1.txt relative to common run directories
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  // Match demo behavior: normalize line endings and keep blank/whitespace-only lines.
  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  // Use the same style of weights as the demo so the decode path matches.
  const weights: any = {
    'line.indentation_delta': 0.5,
    'line.lexical_similarity_drop': 1.0,
    'line.blank_line': 1.0,
    'segment.token_count_bucket': 0.8,
    'segment.numeric_ratio': 1.2,
    'segment.is_email': 2.0,
    'segment.is_phone': 1.5,
    'field.relative_position_consistency': 0.6,
    'field.optional_penalty': -0.4
  }

  const spans = spanGenerator(lines, {})
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 512, safePrefix: 6 })

  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const feedback = {
    entries: [
      { kind: 'record', startLine: 0, endLine: 8 },
      { kind: 'record', startLine: 20, endLine: 25 },
      { kind: 'subEntity', fileStart: lineStarts[5]!, fileEnd: lineStarts[8]! + lines[8]!.length, entityType: 'Guardian' }
    ]
  } as any

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, { ...weights }, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 512, safePrefix: 6 })

  // The asserted record range (0-8) must not be split at the sub-entity start (line 5).
  assert(Boolean(res.pred[0] && res.pred[0]!.boundary === 'B'), 'case1 asserted record should start with B at line 0')
  for (let li = 1; li <= 8; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.boundary !== 'B'), `case1 asserted record should not contain B boundaries inside; found B at line ${li}`)
  }
  // Closed interval enforcement: endLine+1 should be a boundary.
  assert(Boolean(res.pred[9] && res.pred[9]!.boundary === 'B'), 'case1 asserted record range should force boundary at line 9 (end+1)')

  // The Guardian sub-entity assertion should apply across its full range.
  for (let li = 5; li <= 8; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.entityType === 'Guardian'), `line ${li} should be Guardian due to sub-entity assertion`)
  }

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  const rec0 = records.find(r => r.startLine === 0)
  assert(Boolean(rec0), 'expected a record starting at line 0')
  assert(rec0!.endLine === 8, `expected first record to end at line 8, got ${rec0!.endLine}`)
  assert(!records.some(r => r.startLine === 5), 'sub-entity start line must not create a new record boundary')

  const guardian = (rec0!.subEntities ?? []).find(se => se.entityType === 'Guardian')
  assert(Boolean(guardian), 'expected a Guardian sub-entity span inside the first record')
  assert(guardian!.startLine === 5 && guardian!.endLine === 8, `expected Guardian sub-entity to be lines 5-8, got ${guardian!.startLine}-${guardian!.endLine}`)


}

function testCase1SubEntityOutsideRecordAssertionIsApplied() {
  // locate case1.txt relative to common run directories
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  // Match demo behavior: normalize line endings and keep blank/whitespace-only lines.
  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  const weights: any = {
    'line.indentation_delta': 0.5,
    'line.lexical_similarity_drop': 1.0,
    'line.blank_line': 1.0,
    'segment.token_count_bucket': 0.8,
    'segment.numeric_ratio': 1.2,
    'segment.is_email': 2.0,
    'segment.is_phone': 1.5,
    'field.relative_position_consistency': 0.6,
    'field.optional_penalty': -0.4
  }

  const spans = spanGenerator(lines, {})
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 512, safePrefix: 6 })

  // This mirrors the reported payload:
  // - assert the Oliver Smith record (10-18)
  // - assert Guardian in that record (15-18)
  // - ALSO assert Guardian in the *previous* record (5-8) without explicitly asserting that record
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const feedback = {
    entries: [
      { kind: 'record', startLine: 10, endLine: 18 },
      { kind: 'subEntity', fileStart: lineStarts[15]!, fileEnd: lineStarts[18]! + lines[18]!.length, entityType: 'Guardian' },
      { kind: 'subEntity', fileStart: lineStarts[5]!, fileEnd: lineStarts[8]! + lines[8]!.length, entityType: 'Guardian' }
    ]
  } as any

  const res = updateWeightsFromUserFeedback(
    lines,
    spans,
    predBefore,
    feedback,
    { ...weights },
    boundaryFeatures,
    segmentFeatures,
    householdInfoSchema,
    1.0,
    { maxStates: 512, safePrefix: 6 }
  )

  // Record assertion should enforce boundaries for 10-18.
  assert(Boolean(res.pred[10] && res.pred[10]!.boundary === 'B'), 'asserted record (10-18) should start with B at line 10')
  for (let li = 11; li <= 18; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.boundary !== 'B'), `asserted record (10-18) should not contain B inside; found B at line ${li}`)
  }
  assert(Boolean(res.pred[19] && res.pred[19]!.boundary === 'B'), 'asserted record (10-18) should force boundary at line 19 (end+1)')

  // Sub-entity assertions should apply even when they are outside any explicit record assertion.
  for (let li = 5; li <= 8; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.entityType === 'Guardian'), `line ${li} should be Guardian due to sub-entity assertion outside explicit record`) 
  }
  for (let li = 15; li <= 18; li++) {
    assert(Boolean(res.pred[li] && res.pred[li]!.entityType === 'Guardian'), `line ${li} should be Guardian due to sub-entity assertion inside asserted record`) 
  }


}

function testCase1EmailAssertionDoesNotCreateOverlappingSpans() {
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  const weights: any = {
    'line.indentation_delta': 0.5,
    'line.lexical_similarity_drop': 1.0,
    'line.blank_line': 1.0,
    'segment.token_count_bucket': 0.8,
    'segment.numeric_ratio': 1.2,
    'segment.is_email': 2.0,
    'segment.is_phone': 1.5,
    'field.relative_position_consistency': 0.6,
    'field.optional_penalty': -0.4
  }

  const spans = spanGenerator(lines, {})
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 512, safePrefix: 6 })

  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const feedback = {
    entries: [
      {
        kind: 'field',
        field: {
          action: 'add',
          lineIndex: 17,
          start: 4,
          end: 27,
          fieldType: 'Email',
          confidence: 1
        }
      },
      { kind: 'subEntity', fileStart: lineStarts[15]!, fileEnd: lineStarts[18]! + lines[18]!.length, entityType: 'Guardian' }
    ]
  } as any

  const res = updateWeightsFromUserFeedback(
    lines,
    spans,
    predBefore,
    feedback,
    { ...weights },
    boundaryFeatures,
    segmentFeatures,
    householdInfoSchema,
    1.0,
    { maxStates: 512, safePrefix: 6 }
  )

  const lineSpans = (res.spansPerLine ?? spans)[17]!.spans
  // Assert span exists exactly once
  const matches = lineSpans.filter(s => s.start === 4 && s.end === 27)
  assert(matches.length === 1, `expected asserted Email span (4-27) to exist once on line 17; got ${matches.length}`)

  // Assert spans are non-overlapping on that line (sorted by start)
  const sorted = [...lineSpans].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const curr = sorted[i]!
    assert(prev.end <= curr.start, `expected non-overlapping spans on line 17; found overlap ${prev.start}-${prev.end} with ${curr.start}-${curr.end}`)
  }

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  const recWithGuardian = records.find(r => (r.subEntities ?? []).some(se => se.entityType === 'Guardian' && se.startLine <= 17 && se.endLine >= 17))
  assert(Boolean(recWithGuardian), 'expected to find a record containing Guardian sub-entity covering line 17')
  const guardian = (recWithGuardian!.subEntities ?? []).find(se => se.entityType === 'Guardian' && se.startLine <= 17 && se.endLine >= 17)!
  const emailFields = guardian.fields.filter(f => f.lineIndex === 17 && f.start === 4 && f.end === 27 && f.fieldType === 'Email')
  assert(emailFields.length === 1, `expected exactly one Email field span on line 17 (4-27); got ${emailFields.length}`)


}

function testCase1FieldOnlyEmailAssertionIsRendered() {
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  // Use the same style of weights as the demo so the decode path matches.
  const weights: any = {
    'line.indentation_delta': 0.5,
    'line.lexical_similarity_drop': 1.0,
    'line.blank_line': 1.0,
    'segment.token_count_bucket': 0.8,
    'segment.numeric_ratio': 1.2,
    'segment.is_email': 2.0,
    'segment.is_phone': 1.5,
    'field.relative_position_consistency': 0.6,
    'field.optional_penalty': -0.4
  }

  const spans = spanGenerator(lines, {})

  const feedback = {
    entries: [
      {
        kind: 'field',
        field: {
          action: 'add',
          lineIndex: 17,
          start: 4,
          end: 27,
          fieldType: 'Email',
          confidence: 1
        }
      }
    ]
  } as any

  const res = decodeJointSequenceWithFeedback(
    lines,
    spans,
    weights,
    householdInfoSchema,
    boundaryFeatures,
    segmentFeatures,
    feedback,
    { maxStates: 512, safePrefix: 6 }
  )

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, weights, segmentFeatures, householdInfoSchema)

  // Field-only feedback should still result in a renderable field span in some sub-entity and record.
  const matches = records.flatMap(r => r.subEntities.flatMap(se => se.fields))
    .filter(f => f.lineIndex === 17 && f.start === 4 && f.end === 27 && f.fieldType === 'Email')

  assert(matches.length === 1, `expected field-only asserted Email span to be rendered once; got ${matches.length}`)


}

// Additional robustness tests to prevent overfitting to case1
function testFirstTwoCase3Records() {
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case3.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case3.txt')
  assert(Boolean(existsSync(filePath)), `case3.txt not found at ${filePath}`)
  const txt = readFileSync(filePath, 'utf8')
  const linesArr = txt.split(/\r?\n/).filter(l=>l.trim().length>0)
  assert(linesArr.length >= 2, 'expected case3 to contain at least two lines')

  // In case3 each input line is its own record; use first two lines as separate records
  const first = [ linesArr[0]! ]
  const second = [ linesArr[1]! ]
  const lines: string[] = [...first, ...second]
  const spans = spanGenerator(lines, { delimiterRegex: /\t/ })
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })
  const fresh = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })
  const finalRecs = entitiesFromJointSequence(lines, spans, fresh, weights, segmentFeatures, householdInfoSchema)

  assert(finalRecs.length === 2, `case3: expected two top-level records after enforcing feedback, got ${finalRecs.length}`)

}

function testFirstTwoCase4Records() {
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case4.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case4.txt')
  assert(Boolean(existsSync(filePath)), `case4.txt not found at ${filePath}`)
  const txt = readFileSync(filePath, 'utf8')
  const linesArr = txt.split(/\r?\n/).filter(l=>l.length > 0)
  assert(linesArr.length >= 4, 'expected case4 to contain at least 4 lines')

  // Case4: records start at zero-indentation lines. Find first two record ranges.
  const starts = linesArr.map((l, i) => ({ i, l })).filter(x => /^\S/.test(x.l)).map(x => x.i)
  assert(starts.length >= 2, 'expected at least two zero-indented record starts in case4')

  const firstStart = starts[0]
  const secondStart = starts[1]
  const thirdStart = starts[2] ?? linesArr.length

  const first = linesArr.slice(firstStart, secondStart)
  const second = linesArr.slice(secondStart, thirdStart)
  const lines: string[] = [...first, ...second]
  const spans = spanGenerator(lines, {})
  const weights: any = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })

  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })
  const fresh = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 256 })
  const finalRecs = entitiesFromJointSequence(lines, spans, fresh, weights, segmentFeatures, householdInfoSchema)

  assert(finalRecs.length === 2, `case4: expected two top-level records after enforcing feedback, got ${finalRecs.length}`)

}

// Register tests with Vitest unconditionally — we no longer need the node fallback
test('pushUniqueFields dedupes', () => testPushUniqueFields());
test('buildFeedback merges histories', () => testBuildFeedback());
test('removeEntityConflicts removes overlaps', () => testRemoveEntityConflicts());
test('normalizeFeedbackEntries preserves remove fields', () => testNormalizeFeedbackEntriesKeepsRemoveFields());
test('feedback two entities respected', () => testFeedbackTwoEntities());
test('first two case1 records', () => testFirstTwoCase1Records());
test('single case1 record range terminates', () => testSingleCase1RecordRangeTerminates());
test('asserted ranges not subdivided', () => testAssertedRangesNotSubdivided());
test('case1 record guardian subentity does not split', () => testCase1RecordWithGuardianSubEntityDoesNotSplit());
test('case1 sub-entity outside record assertion applied', () => testCase1SubEntityOutsideRecordAssertionIsApplied());
test('case1 email assertion does not create overlapping spans', () => testCase1EmailAssertionDoesNotCreateOverlappingSpans());
test('case1 field-only Email assertion is rendered', () => testCase1FieldOnlyEmailAssertionIsRendered());
test('first two case3 records', () => testFirstTwoCase3Records());
test('first two case4 records', () => testFirstTwoCase4Records());
test('decode sanitization preserves non-overlapping candidates', () => testDecodeWithFeedbackSanitizesCandidates());
