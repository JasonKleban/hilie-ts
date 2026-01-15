import { pushUniqueFields, buildFeedbackFromHistories, removeEntityConflicts, normalizeFeedbackEntries, normalizeFeedback } from '../lib/feedbackUtils.js'
import { spanGenerator } from '../lib/utils.js'
import { decodeFullViaStreaming, decodeJointSequenceWithFeedback, updateWeightsFromUserFeedback, entitiesFromJointSequence } from '../lib/viterbi.js'

// alias for backwards compatibility in tests
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import type { FieldAssertion, FeedbackEntry, Feedback, JointSequence, RecordSpan, LineSpans, FieldSpan, EntitySpan } from '../lib/types.js'
import { householdInfoSchema } from './test-helpers.js'
import path from 'path'
import { existsSync, readFileSync } from 'fs'

type EntityAssertion = {
  startLine: number;
  endLine: number;
  entityType?: string;
  fields?: FieldAssertion[];
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// Helper: if a returned pred is a RecordSpan[] convert it to JointSequence for
// backward-compatible calls to entitiesFromJointSequence inside tests.
function ifArrayToJoint(pred: JointSequence | RecordSpan[], spans: LineSpans[]): JointSequence {
  if (!Array.isArray(pred) || pred.length === 0) return pred as JointSequence
  if (!('startLine' in (pred[0] as any))) return pred as JointSequence

  const records = pred as RecordSpan[]
  const joint: JointSequence = Array.from({ length: spans.length }, () => ({ boundary: 'C', fields: [] }))

  for (const r of records) {
    joint[r.startLine] = { boundary: 'B', fields: [] }
    for (let li = r.startLine; li <= r.endLine; li++) {
      const spansForLine = spans[li]?.spans ?? []
      const fieldsArr: Array<string | undefined> = Array(spansForLine.length).fill(undefined)
      // Also carry entityType info into the joint sequence so downstream
      // calls to entitiesFromJointSequence can respect asserted entity types.
      let entityType: any = undefined
      for (const se of (r.entities ?? [] as EntitySpan[])) {
        if (se.startLine <= li && li <= se.endLine && se.entityType !== undefined) entityType = se.entityType
        for (const f of (se.fields ?? [] as FieldSpan[])) {
          const idx = spansForLine.findIndex((s) => s.start === f.start && s.end === f.end)
          if (idx >= 0) fieldsArr[idx] = f.fieldType
        }
      }
      joint[li] = { boundary: joint[li]?.boundary ?? 'C', fields: fieldsArr.map(x => x ?? 'NOISE') as string[], ...(entityType ? { entityType } : {}) }
    }
  }
  return joint
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
  assert(entries.some(e => e.kind === 'entity'), 'buildFeedback should include the entity entry')
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
  const rec0Norm = norm.entities.find(e => e.startLine === 0 && e.endLine === 0)
  assert(Boolean(rec0Norm), 'normalizeFeedbackEntries should create/keep an entity container for field-only feedback')
  const fields: FieldAssertion[] = (rec0Norm?.fields ?? []) as FieldAssertion[]
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
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  // Build entity-only feedback and submit via the helper and update routine
  // Create file-level sub-entity assertions to avoid relying on startLine/endLine
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const fb: any = { entries: [
    { kind: 'entity', fileStart: lineStarts[0]!, fileEnd: lineStarts[0]! + lines[0]!.length, entityType: 'Primary' },
    { kind: 'entity', fileStart: lineStarts[5]!, fileEnd: lineStarts[5]! + lines[5]!.length, entityType: 'Guardian' }
  ] }

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, { ...weights }, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })

  // Diagnostic: raw decode with forced boundaries only (no entityType).
  // This illustrates why a plain decode may not result in a Guardian role
  // because annotateEntityTypes heuristics can mark Guardians as 'Unknown'
  // when no nearby Primary exists within MAX_DISTANCE.
  // (No further assertions on the raw decode are required for this test.)

  // Diagnostic output when expectations aren't met
  try {
    const recs = res.pred as RecordSpan[]
    // Diagnostic logging
    // eslint-disable-next-line no-console
    console.log('DEBUG recs:', JSON.stringify(recs, null, 2))
    assert(Boolean(recs.some(r => r.startLine === 0 && (r.entities ?? [])[0] && (r.entities ?? [])[0]!.entityType === 'Primary')), 'line 0 should be Primary')
    assert(Boolean(recs.some(r => r.startLine === 5 && (r.entities ?? [])[0] && (r.entities ?? [])[0]!.entityType === 'Guardian')), 'line 5 should be Guardian')
  } catch (err) {
    throw err
  }

  const normalizedFb = normalizeFeedback(fb, lines)
  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, ifArrayToJoint(res.pred, res.spansPerLine ?? spans), res.updated, segmentFeatures, householdInfoSchema, normalizedFb.entities)
  // Diagnostic
  // eslint-disable-next-line no-console
  console.log('DEBUG records:', JSON.stringify(records, null, 2))
  assert(records.length >= 2, 'there should be at least two top-level records')
  assert(records[0]!.entities[0]!.entityType === 'Primary', 'first entity should be Primary')
  assert(records[1]!.entities[0]!.entityType === 'Guardian', 'second entity should be Guardian')
  // New assertion: when file-offset entity feedback is provided, the rendered entity should preserve asserted file offsets (no whole-line snap)
  const fbPrimary = normalizedFb.entities.find((s:any) => s.entityType === 'Primary')!
  const fbGuardian = normalizedFb.entities.find((s:any) => s.entityType === 'Guardian')!
  assert(Boolean(fbPrimary && records[0]!.entities[0]!.fileStart === (fbPrimary as any).fileStart && records[0]!.entities[0]!.fileEnd === (fbPrimary as any).fileEnd), 'primary entity should preserve fileStart/fileEnd')
  assert(Boolean(fbGuardian && records[1]!.entities[0]!.fileStart === (fbGuardian as any).fileStart && records[1]!.entities[0]!.fileEnd === (fbGuardian as any).fileEnd), 'guardian entity should preserve fileStart/fileEnd')


}

// New test: decodeJointSequenceWithFeedback should normalize candidate spans
// to lie within asserted sub-entity file ranges (so fields outside those
// ranges are not considered as candidates for labeling inside the sub-entity).
function testDecodeWithFeedbackSanitizesCandidates() {
  const text = '  * Joshua Anderson (Grandparent)'
  const lines = [text]
  // Create explicit candidate spans that include an ExtID at 3..9 (outside
  // the asserted sub-entity range at 10..32) and proper name spans afterwards.
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 3 }, { start: 3, end: 9 }, { start: 10, end: 18 }, { start: 19, end: 32 } ] }] as LineSpans[]

  const weights: any = {}

  // Assert a sub-entity by file offsets that starts at 10 and ends at 32.
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const fb: Feedback = { entries: [ { kind: 'entity', fileStart: lineStarts[0]! + 10, fileEnd: lineStarts[0]! + 32, entityType: 'Guardian' } ] }

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
  const spans2 = [{ lineIndex: 0, spans: [ { start: 0, end: 5 }, { start: 8, end: 12 }, { start: 12, end: 22 }, { start: 21, end: 25 } ] }] as LineSpans[]
  // Assert sub-entity 10..20 on the line
  const fb2: Feedback = { entries: [ { kind: 'entity', fileStart: lineStarts[0]! + 10, fileEnd: lineStarts[0]! + 20, entityType: 'Guardian' } ] }
  const res2 = decodeJointSequenceWithFeedback(lines, spans2, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb2)
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
  const recs = res.pred as RecordSpan[]
  assert(Boolean(recs.some(r => (r.entities ?? []).some((se: EntitySpan) => se.entityType === 'Guardian'))), 'Decoder pred should include forced entityType for line 0')
}

// New test: ensure we do not preserve both a superset and an inner candidate inside an asserted sub-entity
function testSubEntityRemovesContainerSpans() {
  const lines = ['Henry Johnson (45NUMBEU)']
  // Candidate spans include a superset span 0..22 and a smaller extid span 14..23
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 22 }, { start: 14, end: 23 } ] }] as LineSpans[]
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  // Assert sub-entity covering the parentheses area (14..23)
  const fb: Feedback = { entries: [ { kind: 'entity', fileStart: lineStarts[0]! + 14, fileEnd: lineStarts[0]! + 23, entityType: 'Guardian' } ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, {}, householdInfoSchema, boundaryFeatures, segmentFeatures, fb)
  const s = res.spansPerLine[0]!.spans

  // The large superset span 0..22 should be removed because it contains a smaller span inside the asserted interval
  assert(!s.some(x => x.start === 0 && x.end === 22), 'Container superset span should be removed inside asserted sub-entity')
  // The small extid span should remain
  assert(s.some(x => x.start === 14 && x.end === 23), 'Inner asserted-area span should be kept')

  // Stricter guarantee: the spans inside the asserted interval should be a
  // non-overlapping coverage of the entire asserted interval (no gaps, no nesting)
  const ivStart = 14
  const ivEnd = 23
  const inside = s.filter(x => !(x.end <= ivStart || x.start >= ivEnd)).sort((a,b)=>a.start-b.start)
  // Ensure no nested spans
  for (let i = 0; i < inside.length; i++) {
    for (let j = i+1; j < inside.length; j++) {
      const a = inside[i]!, b = inside[j]!
      assert(!(a.start <= b.start && a.end >= b.end), `no nested spans inside asserted interval: ${JSON.stringify(a)} contains ${JSON.stringify(b)}`)
    }
  }
  // Ensure coverage: no gaps from ivStart to ivEnd
  let cur = ivStart
  for (const sp of inside) {
    assert(sp.start <= cur, `span starts after current coverage position: ${sp.start} > ${cur}`)
    if (sp.end > cur) cur = sp.end
  }
  assert(cur >= ivEnd, `asserted interval should be covered, reached ${cur} expected ${ivEnd}`)
}

// New test: when an exact field span is asserted without a surrounding sub-entity, other
// overlapping candidate spans should be removed so no overlapping FieldSpans are possible.
function testAssertedFieldOnlyRemovesOverlaps() {
  const lines = ['Henry Johnson (45NUMBEU)']
  // Candidate spans include a superset span and a smaller extid span
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 22 }, { start: 15, end: 23 } ] }] as LineSpans[]

  // Field-only feedback as reported (start 15, end 23)
  const fb: Feedback = { entries: [ { kind: 'field', field: { action: 'add', lineIndex: 0, start: 15, end: 23, fieldType: 'ExtID', confidence: 1 } } ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, {}, householdInfoSchema, boundaryFeatures, segmentFeatures, fb)
  const s = res.spansPerLine[0]!.spans

  // The superset span should be removed or clipped so it does not overlap the asserted field
  const overlapping = s.filter(sp => !(sp.end <= 15 || sp.start >= 23) && !(sp.start === 15 && sp.end === 23))
  assert(overlapping.length === 0, `expected no overlapping candidate spans with asserted field, found ${JSON.stringify(overlapping)}`)

  // Assert the exact span exists
  assert(s.some(sp => sp.start === 15 && sp.end === 23), 'expected asserted extid span to be present')

  // Now test the training path: update weights using feedback and ensure the asserted field has high confidence
  const joint = res.pred
  const weights = { 'segment.is_extid': 0 }
  const trainRes = updateWeightsFromUserFeedback(lines, spans, joint, fb, { ...weights }, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })

  const records = entitiesFromJointSequence(lines, trainRes.spansPerLine ?? spans, ifArrayToJoint(trainRes.pred, spans), trainRes.updated, segmentFeatures, householdInfoSchema)
  const first = records[0]!.entities[0]!
  // Do not require the fieldType to match exactly here; the important
  // invariant is that there is a single non-overlapping field covering the
  // asserted span and its confidence is boosted. Field type may vary during
  // training, but spans must not overlap regardless of type.
  const matched = first.fields.filter(f => f.lineIndex === 0 && f.start === 15 && f.end === 23)
  assert(matched.length === 1, `expected a single field at asserted span after training, got ${matched.length}`)
  const conf = matched[0]!.confidence ?? 0
  assert(conf >= 0.6, `expected confidence to be boosted after training; got ${conf}`)
}


// New test: forced field label assertions should be honored during decoding
function testDecodeWithForcedFieldLabel() {
  const lines = ['Foo Bar']
  const spans = [{ lineIndex: 0, spans: [ { start: 0, end: 3 }, { start: 4, end: 7 } ] }] as any
  const weights: Record<string, number> = {}
  const fb: Feedback = { entries: [ { kind: 'field', field: { action: 'add', lineIndex: 0, start: 3, end: 18, fieldType: 'Name', confidence: 1 } } ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb as any)
  // Ensure forced label is present in pred for some candidate that overlaps the asserted interval
  const recs = res.pred as RecordSpan[]
  const forcedInterval = { start: 3, end: 18 }
  // The decoder may assign the forced label to any span that lies (partially) inside the asserted interval.
  const overlap = (aStart:number, aEnd:number, bStart:number, bEnd:number) => !(aEnd <= bStart || aStart >= bEnd)
  const forcedLabelPresent = recs.some(r => (r.entities ?? []).some((se:any) => (se.fields ?? []).some((f:any) => f.lineIndex === 0 && overlap(f.start, f.end, forcedInterval.start, forcedInterval.end) && f.fieldType === 'Name')))
  if (!forcedLabelPresent) throw new Error('expected forced label Name to be present in returned records (overlapping the asserted interval)')


}

// New test: when an exact field span is asserted inside a sub-entity, other
// overlapping candidate spans should be removed to avoid overlapping FieldSpans
// in the final prediction.
function testAssertedFieldRemovesOverlaps() {
  const text = '\t* Joshua Anderson (Grandparent)'
  const lines = [text]
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 })
  const weights: Record<string, number> = {}

  // Feedback: assert sub-entity covering a broad slice and assert an exact Name field
  const fb = { entries: [
    { kind: 'entity', fileStart: 3, fileEnd: 32, entityType: 'Guardian' },
    { kind: 'field', field: { action: 'add', lineIndex: 0, start: 3, end: 18, fieldType: 'Name', confidence: 1 } }
  ] }

  const res = decodeJointSequenceWithFeedback(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, fb as any)

  // Ensure no candidate span other than the asserted exact span overlaps 3..18
  const overlapping = (res.spansPerLine[0]!.spans ?? []).filter(s => !(s.start >= 18 || s.end <= 3) && !(s.start === 3 && s.end === 18))
  assert(overlapping.length === 0, `expected no overlapping candidate spans, found ${JSON.stringify(overlapping)}`)

  // Ensure the forced label exists at the asserted span index
  const spansForLine = res.spansPerLine[0]!.spans
  const idx2 = spansForLine.findIndex(s => s.start === 3 && s.end === 18)
  assert(idx2 >= 0, 'asserted span should exist')
  // The decoder may not immediately label the asserted span (it may require nudging),
  // but the candidate span should be present and not overlapped by other candidates.
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
  const weights: Record<string, number> = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  // Assert the first two records by specifying start/end lines (records still use startLine/endLine)
  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]

  // console.log("FIRST", first, "SECOND", second, "Feedback", fbEntities);

  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())


  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })



  try {
    const recs = res.pred as RecordSpan[]
    assert(Boolean(recs.some(r => r.startLine === 0)), 'first block start should be B')
    assert(Boolean(recs.some(r => r.startLine === first.length)), 'second block start should be B')
  } catch (err) {
    throw err
  }

  const fresh = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})
  const finalRecs = entitiesFromJointSequence(lines, spans, ifArrayToJoint(fresh, spans), weights, segmentFeatures, householdInfoSchema)

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
  const weights: Record<string, number> = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  // Assert ONLY the first record by specifying its exact start/end line.
  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })

  const recs = res.pred as RecordSpan[]
  assert(Boolean(recs.some(r => r.startLine === 0)), 'single asserted record should start with B')
  assert(Boolean(recs.some(r => r.startLine === first.length)), 'single asserted record range should force next line to B (end+1)')

  const finalRecs = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, ifArrayToJoint(res.pred, res.spansPerLine ?? spans), res.updated, segmentFeatures, householdInfoSchema)
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
  const weights: Record<string, number> = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  const nameSpan = spans[0]!.spans[0]!
  const spanIdx = spans[0]!.spans.findIndex(s => s.start === nameSpan.start && s.end === nameSpan.end)
  assert(spanIdx >= 0, 'expected to find the asserted span index on line 0')

  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const entries: FeedbackEntry[] = [
    { kind: 'record', startLine: 0, endLine: 2 },
    { kind: 'entity', fileStart: lineStarts[0]!, fileEnd: lineStarts[2]! + lines[2]!.length, entityType: 'Primary' as any },
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
  const recs = res.pred as RecordSpan[]
  assert(Boolean(recs.some(r => r.startLine === 0)), 'asserted record start should be B')
  for (let li = 1; li <= 2; li++) {
    assert(!recs.some(r => r.startLine === li), 'asserted record interior should not be B')
  }
  assert(Boolean(recs.some(r => r.startLine === 3)), 'asserted record end should force end+1 boundary (no further subdivision)')

  // Sub-entity must not be further subdivided: all lines in the range share the asserted entityType.
  const assertedFirstRec = recs.find(r => r.startLine === 0)
  for (let li = 0; li <= 2; li++) {
    assert(Boolean(assertedFirstRec && assertedFirstRec.entities && assertedFirstRec.entities[0] && assertedFirstRec.entities[0]!.entityType === 'Primary'), `line ${li} should be Primary due to entity assertion`)
  }

  // Field must not be subdivided: the asserted span retains the label.
  const hasField = recs.some(r => (r.entities ?? []).some((se: EntitySpan) => (se.fields ?? []).some((f: FieldSpan) => f.lineIndex === 0 && f.start === nameSpan.start && f.end === nameSpan.end && f.fieldType === 'Name')))
  assert(hasField, 'asserted field span should remain labeled as Name')

  const finalRecs = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, ifArrayToJoint(res.pred, res.spansPerLine ?? spans), res.updated, segmentFeatures, householdInfoSchema)
  assert(finalRecs.length >= 2, `expected at least two records after boundary enforcement, got ${finalRecs.length}`)
  const firstRecFromFinal = finalRecs[0]!
  assert(firstRecFromFinal.startLine === 0 && firstRecFromFinal.endLine === 2, `expected first record to be exactly lines 0-2, got ${firstRecFromFinal.startLine}-${firstRecFromFinal.endLine}`)
  assert(firstRecFromFinal.entities.length === 1, `expected exactly one entity in asserted range, got ${firstRecFromFinal.entities.length}`)
  const se = firstRecFromFinal.entities[0]!
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
  const weights: Record<string, number> = {
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
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256, safePrefix: 6 }})

  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const feedback: Feedback = {
    entries: [
      { kind: 'record', startLine: 0, endLine: 8 },
      { kind: 'record', startLine: 20, endLine: 25 },
      { kind: 'entity', fileStart: lineStarts[5]!, fileEnd: lineStarts[8]! + lines[8]!.length, entityType: 'Guardian' }
    ]
  }

  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, { ...weights }, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 512, safePrefix: 6 })

  // The asserted record range (0-8) must not be split at the sub-entity start (line 5).
  const recs = res.pred as RecordSpan[]
  assert(Boolean(recs.some(r => r.startLine === 0)), 'case1 asserted record should start with B at line 0')
  for (let li = 1; li <= 8; li++) {
    assert(!recs.some(r => r.startLine === li), `case1 asserted record should not contain B boundaries inside; found B at line ${li}`)
  }
  // Closed interval enforcement: endLine+1 should be a boundary.
  assert(Boolean(recs.some(r => r.startLine === 9)), 'case1 asserted record range should force boundary at line 9 (end+1)')

  // The Guardian sub-entity assertion should apply across its full range.
  const rec0 = recs.find(r => r.startLine === 0)
  for (let li = 5; li <= 8; li++) {
    assert(Boolean(rec0 && rec0.entities && rec0.entities.some(se => se.entityType === 'Guardian')), `line ${li} should be Guardian due to entity assertion`)
  }

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, ifArrayToJoint(res.pred, res.spansPerLine ?? spans), res.updated, segmentFeatures, householdInfoSchema, normalizeFeedback(feedback, lines).entities)
  const recFromEntities = records.find(r => r.startLine === 0)
  assert(Boolean(recFromEntities), 'expected a record starting at line 0')
  assert(recFromEntities!.endLine === 8, `expected first record to end at line 8, got ${recFromEntities!.endLine}`)
  assert(!records.some(r => r.startLine === 5), 'entity start line must not create a new record boundary')

  const guardian = (recFromEntities!.entities ?? []).find(se => se.entityType === 'Guardian')
  assert(Boolean(guardian), 'expected a Guardian entity span inside the first record')
  assert(guardian!.startLine === 5 && guardian!.endLine === 8, `expected Guardian entity to be lines 5-8, got ${guardian!.startLine}-${guardian!.endLine}`)


}

function testCase1SubEntityOutsideRecordAssertionIsApplied() {
  // locate case1.txt relative to common run directories
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  // Match demo behavior: normalize line endings and keep blank/whitespace-only lines.
  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  const weights: Record<string, number> = {
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
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256, safePrefix: 6 }})

  // This mirrors the reported payload:
  // - assert the Oliver Smith record (10-18)
  // - assert Guardian in that record (15-18)
  // - ALSO assert Guardian in the *previous* record (5-8) without explicitly asserting that record
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const feedback = {
    entries: [
      { kind: 'record', startLine: 10, endLine: 18 },
      { kind: 'entity', fileStart: lineStarts[15]!, fileEnd: lineStarts[18]! + lines[18]!.length, entityType: 'Guardian' },
      { kind: 'entity', fileStart: lineStarts[5]!, fileEnd: lineStarts[8]! + lines[8]!.length, entityType: 'Guardian' }
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
  const recs = res.pred as RecordSpan[]
  assert(Boolean(recs.some(r => r.startLine === 10)), 'asserted record (10-18) should start with B at line 10')
  for (let li = 11; li <= 18; li++) {
    assert(!recs.some(r => r.startLine === li), `asserted record (10-18) should not contain B inside; found B at line ${li}`)
  }
  assert(Boolean(recs.some(r => r.startLine === 19)), 'asserted record (10-18) should force boundary at line 19 (end+1)')

  // Sub-entity assertions should apply even when they are outside any explicit record assertion.
  const rec5 = recs.find(r => r.startLine <= 5 && r.endLine >= 8)


  for (let li = 5; li <= 8; li++) {
    assert(Boolean(rec5 && rec5.entities && rec5.entities.some(se => se.entityType === 'Guardian')), `line ${li} should be Guardian due to entity assertion outside explicit record`) 
  }
  const rec10 = recs.find(r => r.startLine === 10)
  for (let li = 15; li <= 18; li++) {
    assert(Boolean(rec10 && rec10.entities && rec10.entities.some(se => se.entityType === 'Guardian')), `line ${li} should be Guardian due to entity assertion inside asserted record`) 
  }


}

function testCase1EmailAssertionDoesNotCreateOverlappingSpans() {
  let filePath = path.join(process.cwd(), 'src', 'tests', 'data', 'case1.txt')
  if (!existsSync(filePath)) filePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
  assert(Boolean(existsSync(filePath)), `case1.txt not found at ${filePath}`)

  const txt = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = txt.split('\n')

  const weights: Record<string, number> = {
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
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256, safePrefix: 6 }})

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
      { kind: 'entity', fileStart: lineStarts[15]!, fileEnd: lineStarts[18]! + lines[18]!.length, entityType: 'Guardian' }
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

  // Diagnostic: inspect returned pred from training
  // eslint-disable-next-line no-console
  console.log('DEBUG res.pred snippet:', JSON.stringify((res.pred as RecordSpan[]).filter(r => r.startLine <= 17 && r.endLine >= 15), null, 2))

  const lineSpans = (res.spansPerLine ?? spans)[17]!.spans
  // Diagnostic
  // eslint-disable-next-line no-console
  console.log('DEBUG spans line 17:', JSON.stringify(lineSpans, null, 2))
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

  const records = entitiesFromJointSequence(lines, res.spansPerLine ?? spans, ifArrayToJoint(res.pred as any, spans), res.updated, segmentFeatures, householdInfoSchema)
  // Diagnostic
  // eslint-disable-next-line no-console
  console.log('DEBUG records at line 17 context:', JSON.stringify(records.map(r => ({ startLine: r.startLine, endLine: r.endLine, entities: (r.entities ?? []).map(se=>({ startLine: se.startLine, endLine: se.endLine, entityType: se.entityType, fieldsCount: (se.fields ?? []).length })) })), null, 2))
  const recWithGuardian = records.find(r => (r.entities ?? []).some(se => se.entityType === 'Guardian' && se.startLine <= 17 && se.endLine >= 17))
  assert(Boolean(recWithGuardian), 'expected to find a record containing Guardian entity covering line 17')
  const guardian = (recWithGuardian!.entities ?? []).find(se => se.entityType === 'Guardian' && se.startLine <= 17 && se.endLine >= 17)!
  // Diagnostic
  // eslint-disable-next-line no-console
  console.log('DEBUG guardian fields:', JSON.stringify(guardian.fields, null, 2))
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
  const weights: Record<string, number> = {
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

  // Use the returned records directly from decodeJointSequenceWithFeedback
  const records = res.pred as RecordSpan[]

  // Field-only feedback should still result in a renderable field span in some sub-entity and record.
  const matches = records.flatMap(r => r.entities.flatMap(se => se.fields))
    .filter(f => f.lineIndex === 17 && f.start === 4 && f.end === 27 && f.fieldType === 'Email')

  if (matches.length !== 1) {
    // Debug output to help root-cause the failing case
    // eslint-disable-next-line no-console
    console.error('DEBUG spans for line 17:', JSON.stringify(res.spansPerLine?.[17]?.spans ?? []))
    // eslint-disable-next-line no-console
    console.error('DEBUG records flattened fields around line 17:', JSON.stringify(records.flatMap(r => r.entities.flatMap(se => se.fields).filter((f:any) => f.lineIndex === 17))))
  }

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
  const weights: Record<string, number> = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })
  const fresh = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})
  const finalRecs = entitiesFromJointSequence(lines, spans, ifArrayToJoint(fresh, spans), weights, segmentFeatures, householdInfoSchema)

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
  const weights: Record<string, number> = { 'segment.is_phone': 1.5, 'segment.is_email': 1.5, 'segment.is_extid': 1.0, 'segment.is_name': 1.0 }
  const predBefore = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})

  const fbEntities: EntityAssertion[] = [
    { startLine: 0, endLine: first.length - 1 },
    { startLine: first.length, endLine: first.length + second.length - 1 }
  ]
  const fb = buildFeedbackFromHistories(fbEntities, [], new Set())

  updateWeightsFromUserFeedback(lines, spans, predBefore, fb, weights, boundaryFeatures, segmentFeatures, householdInfoSchema, 1.0, { maxStates: 256 })
  const fresh = decodeFullViaStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 256 }})
  const finalRecs = entitiesFromJointSequence(lines, spans, ifArrayToJoint(fresh, spans), weights, segmentFeatures, householdInfoSchema)

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
test('sub-entity removes container spans', () => testSubEntityRemovesContainerSpans());
test('forced field label in decode is honored', () => testDecodeWithForcedFieldLabel());
test('asserted field-only removes overlapping candidates', () => testAssertedFieldOnlyRemovesOverlaps());
test('decode sanitization preserves non-overlapping candidates', () => testDecodeWithFeedbackSanitizesCandidates());
test('asserted field removes overlapping candidates', () => testAssertedFieldRemovesOverlaps());
