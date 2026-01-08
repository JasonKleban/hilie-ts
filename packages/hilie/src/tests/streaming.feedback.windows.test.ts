import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { householdInfoSchema } from './test-helpers.js'
import { spanGenerator } from '../lib/utils.js'

declare const test: any;

// Ensure sub-entity assertions that span multiple windows are sanitized
// deterministically and produce non-overlapping coverage per-line.
test('streaming decode with cross-window sub-entity assertion produces coverage', () => {
  const lines = [
    'Henry Johnson\t45NUMBEU', // line 0
    '\t* Eats most school meals.', // line 1
    '\t* 2014-05-04', // line 2
    'Oliver Smith\tDBYE6KPR' // line 3
  ]

  const spans = spanGenerator(lines, { delimiterRegex: /\t/ })
  const weights: any = {}

  // Build a sub-entity assertion that covers lines 0..2 via file offsets
  const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
  const fb: any = { entries: [ { kind: 'subEntity', fileStart: lineStarts[0]!, fileEnd: lineStarts[2]! + lines[2]!.length, entityType: 'Guardian' } ] }

  // Use small lookahead to force windowed decoding across line 1/2 boundary
  const recs = decodeRecordsStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: 2, feedback: fb, carryover: true, beam: 2 })
  if (!recs || recs.length === 0) throw new Error('expected at least one record')

  // Find lines 0..2 in the returned records and assert per-line non-overlap and coverage
  const lineToSpans: Record<number, { start: number; end: number }[]> = {}
  for (const r of recs) {
    for (let i = 0; i < r.spansPerLine.length; i++) {
      const globalLi = r.startLine + i
      if (globalLi >= 0 && globalLi < lines.length && globalLi <= 2) {
        lineToSpans[globalLi] = r.spansPerLine[i]!.spans
      }
    }
  }

  for (let li = 0; li <= 2; li++) {
    const s = lineToSpans[li]
    if (!s) throw new Error(`expected spans for line ${li}`)
    // non-nested
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const a = s[i]!, b = s[j]!
        if (a.start <= b.start && a.end >= b.end) throw new Error(`nested spans on line ${li}: ${JSON.stringify(a)} contains ${JSON.stringify(b)}`)
      }
    }
    // ensure coverage across the asserted portion of the line
    const lineStart = li === 0 ? Math.max(0, lineStarts[0]!) : 0
    // compute intersection bounds for this li within the asserted interval
    const assertStart = Math.max(lineStart, lineStarts[li]!) - lineStarts[li]!
    const assertEnd = Math.min(lineStarts[2]! + lines[2]!.length, lineStarts[li]! + lines[li]!.length) - lineStarts[li]!

    let cur = assertStart
    for (const sp of s.sort((a,b)=>a.start-b.start)) {
      if (sp.start > cur) throw new Error(`gap in coverage on line ${li}: next start ${sp.start} > cur ${cur}`)
      if (sp.end > cur) cur = sp.end
    }
    if (cur < assertEnd) throw new Error(`asserted interval not fully covered on line ${li}: reached ${cur} expected ${assertEnd}`)
  }
})
