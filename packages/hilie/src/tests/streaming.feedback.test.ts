import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { householdInfoSchema } from './test-helpers.js'
import type { Feedback, LineSpans, RecordSpan, EntitySpan, FieldSpan } from '../lib/types.js' 

declare const test: (name: string, fn: () => void) => void;

test('streaming decode honors forced field assertions', () => {
  const lines = ['Foo Bar']
  const spans = [{ lineIndex: 0, spans: [{ start: 0, end: 3 }, { start: 4, end: 7 }] }] as LineSpans[]
  const weights: Record<string, number> = {}
  const fb: Feedback = { entries: [ { kind: 'field', field: { action: 'add', lineIndex: 0, start: 0, end: 3, fieldType: 'Name', confidence: 1.0 } } ] }

  const recs = decodeRecordsStreaming(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: 2, feedback: fb })
  if (!recs || recs.length === 0) throw new Error('expected at least one record')
  const first = recs[0]!
  const spansLine = first.spansPerLine[0]!
  const idx = spansLine.spans.findIndex(s => s.start === 0 && s.end === 3)
  if (idx < 0) throw new Error('expected asserted span to be present in spans')

  // find the asserted field in the returned record structure
  const recsPred = first.pred as RecordSpan[]
  const labPresent = recsPred.some(r => (r.entities ?? []).some((se: EntitySpan) => (se.fields ?? []).some((f: FieldSpan) => f.lineIndex === 0 && f.start === 0 && f.end === 3 && f.fieldType === 'Name')))
  if (!labPresent) throw new Error(`expected forced label 'Name' present in returned records`)
})
