import { pushUniqueFields, buildFeedbackFromHistories, removeEntityConflicts, normalizeFeedbackEntries } from '../lib/feedbackUtils.js'
import { spanGenerator } from '../lib/utils.js'
import { decodeJointSequence, updateWeightsFromUserFeedback, entitiesFromJointSequence } from '../lib/viterbi.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import type { FieldAssertion, EntityAssertion, FeedbackEntry } from '../lib/types.js'
import { householdInfoSchema } from './test-helpers.js'
import path from 'path'
import { existsSync, readFileSync } from 'fs'

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
  // Expect an entry seeded at the boundary (line 0) and an entry for the ungrouped field line (line 1)
  assert((fb.records ?? []).length === 2, 'buildFeedback should include record entries for both lines with either record assertions or fields')
  const ent0 = (fb.records ?? []).find(e => e.startLine === 0)
  const ent1 = (fb.records ?? []).find(e => e.startLine === 1)
  assert(Boolean(ent0 && ent0.fields && ent0.fields.length === 1), 'entity at line 0 should have attached field')
  assert(Boolean(ent1 && ent1.fields && ent1.fields.length === 1), 'entity at line 1 should have attached field')
}

// removeEntityConflicts removes overlapping items
function testRemoveEntityConflicts() {
  const entityHist: EntityAssertion[] = [{ startLine: 0, endLine: 0, fields: [] }, { startLine: 3, endLine: 3, fields: [] }]
  const fieldHist: FieldAssertion[] = [{ lineIndex: 0, start: 0, end: 3 }, { lineIndex: 3, start: 0, end: 2 }, { lineIndex: 4, start: 0, end: 2 }]
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
  const entityHist: EntityAssertion[] = [{ startLine: 0, endLine: 0, entityType: 'Primary', fields: [] }, { startLine: 5, endLine: 5, entityType: 'Guardian', fields: [] }]
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
    throw err
  }

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, res.pred, res.updated, segmentFeatures, householdInfoSchema)
  assert(records.length >= 2, 'there should be at least two top-level records')
  assert(records[0]!.subEntities[0]!.entityType === 'Primary', 'first sub-entity should be Primary')
  assert(records[1]!.subEntities[0]!.entityType === 'Guardian', 'second sub-entity should be Guardian')

  console.log('✓ feedback two-entity assertions respected')
}

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

  // Assert the first two records by specifying start/end lines
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

  console.log('✓ first-two case1 records feedback respected')
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

  console.log('✓ single case1 record range terminates')
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

  const entries: FeedbackEntry[] = [
    { kind: 'record', startLine: 0, endLine: 2 },
    { kind: 'subEntity', startLine: 0, endLine: 2, entityType: 'Primary' as any },
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

  console.log('✓ asserted record/sub-entity/field ranges are not subdivided')
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

  const feedback = {
    entries: [
      { kind: 'record', startLine: 0, endLine: 8 },
      { kind: 'record', startLine: 20, endLine: 25 },
      { kind: 'subEntity', startLine: 5, endLine: 8, entityType: 'Guardian' }
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

  console.log('✓ case1 asserted record with Guardian sub-entity does not split')
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
  const feedback = {
    entries: [
      { kind: 'record', startLine: 10, endLine: 18 },
      { kind: 'subEntity', startLine: 15, endLine: 18, entityType: 'Guardian' },
      { kind: 'subEntity', startLine: 5, endLine: 8, entityType: 'Guardian' }
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

  console.log('✓ case1 sub-entity assertions apply outside record assertions')
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
      { kind: 'subEntity', startLine: 15, endLine: 18, entityType: 'Guardian' }
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

  console.log('✓ case1 Email assertion does not create overlapping spans')
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
  console.log('✓ first-two case3 records feedback respected')
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
  console.log('✓ first-two case4 records feedback respected')
}

// Run tests
testPushUniqueFields()
testBuildFeedback()
testRemoveEntityConflicts()
testNormalizeFeedbackEntriesKeepsRemoveFields()
testFeedbackTwoEntities()
testFirstTwoCase1Records()
testSingleCase1RecordRangeTerminates()
testAssertedRangesNotSubdivided()
testCase1RecordWithGuardianSubEntityDoesNotSplit()
testCase1SubEntityOutsideRecordAssertionIsApplied()
testCase1EmailAssertionDoesNotCreateOverlappingSpans()
testFirstTwoCase3Records()
testFirstTwoCase4Records()

console.log('✓ feedbackUtils tests passed')
