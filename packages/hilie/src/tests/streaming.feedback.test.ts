import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { householdInfoSchema } from './test-helpers.js'

declare const test: any;

test('streaming decode honors forced field assertions', () => {
  const lines = ['Foo Bar']
  const spans = [{ lineIndex: 0, spans: [{ start: 0, end: 3 }, { start: 4, end: 7 }] } as any]
  const weights: any = {}
  const fb: any = { entries: [ { kind: 'field', field: { action: 'add', lineIndex: 0, start: 0, end: 3, fieldType: 'Name', confidence: 1.0 } } ] }

  const recs = decodeRecordsStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: 2, feedback: fb })
  if (!recs || recs.length === 0) throw new Error('expected at least one record')
  const first = recs[0]!
  const spansLine = first.spansPerLine[0]!
  const idx = spansLine.spans.findIndex(s => s.start === 0 && s.end === 3)
  if (idx < 0) throw new Error('expected asserted span to be present in spans')
  const lab = first.pred[0]!.fields[idx]
  if (lab !== 'Name') throw new Error(`expected forced label 'Name' at span idx ${idx}, got ${lab}`)
})
