import { decodeFullViaStreaming, decodeRecordsStreaming } from '../lib/viterbi.js'
import { spanGenerator } from '../lib/utils.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { householdInfoSchema } from '../tests/test-helpers.js'

function hr() { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6 }

const lines = [
  'Henry Johnson\t45NUMBEU',
  '\t* Eats most school meals.',
  '\t* 2014-05-04',
  'Oliver Smith\tDBYE6KPR',
  '\t* 2014-12-15'
]
const spans = spanGenerator(lines, { delimiterRegex: /\t/ })
const weights: any = {}
const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()
const fb: any = { entries: [ { kind: 'entity', fileStart: lineStarts[0]!, fileEnd: lineStarts[2]! + lines[2]!.length, entityType: 'Guardian' } ] }

const ITER = 200
console.log('Benchmark: decodeFullViaStreaming (no feedback)')
let t0 = hr()
for (let i = 0; i < ITER; i++) decodeFullViaStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures)
console.log('elapsed ms:', hr() - t0)

console.log('Benchmark: decodeFullViaStreaming (with feedback)')
t0 = hr()
for (let i = 0; i < ITER; i++) decodeFullViaStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: lines.length, feedback: fb })
console.log('elapsed ms:', hr() - t0)

console.log('Benchmark: decodeRecordsStreaming (no feedback)')
t0 = hr()
for (let i = 0; i < ITER; i++) decodeRecordsStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: 2 })
console.log('elapsed ms:', hr() - t0)

console.log('Benchmark: decodeRecordsStreaming (with feedback)')
t0 = hr()
for (let i = 0; i < ITER; i++) decodeRecordsStreaming(lines, spans as any, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { lookaheadLines: 2, feedback: fb })
console.log('elapsed ms:', hr() - t0)
