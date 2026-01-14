import { test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { analyzeFileLevelFeatures } from '../lib/features.js'
import { decodeRecordsStreaming, decodeRecordsFromAsyncIterable } from '../lib/viterbi/streaming.js'

test('streaming decode yields multiple records on case1.txt', () => {
  const p = path.join(__dirname, 'data', 'case1.txt')
  const txt = fs.readFileSync(p, 'utf8')
  const lines = txt.split('\n')

  // simple spans: one span covering each line (coarse, but decoder still finds boundaries)
  const spans = lines.map((ln, i) => ({ lineIndex: i, spans: [{ start: 0, end: ln.length }] }))

  const schema = { fields: [{ name: 'F1' }], noiseLabel: 'NOISE' }

  const analysis = analyzeFileLevelFeatures(txt)
  const weights: Record<string, number> = {}

  const recs = decodeRecordsStreaming(lines, spans, weights, schema as any, [], [], { lookaheadLines: 60, dynamicCandidates: analysis.candidates })

  // We expect many records (case1 is a list of records); check sequenced progress
  expect(recs.length).toBeGreaterThan(10)
  // Ensure records are non-overlapping and cover from 0 to end
  expect(recs[0]?.startLine).toBe(0)
  expect(recs[recs.length - 1]?.endLine).toBe(lines.length)
})

test('decodeRecordsFromAsyncIterable handles chunked Readable-like input', async () => {
  async function* chunks() {
    yield 'FirstName,Email\n' // header-like single-line wide layout
    yield 'John Doe,john@example.com\nAlice,alice@example.org\n' // two rows
    // and a small outline block
    yield '\n- Note: first record additional info\n  more text continued\n- Secondary: Bob\n'
  }

  const schema = { fields: [{ name: 'FirstName' }, { name: 'Email' }], noiseLabel: 'NOISE' }
  const weights: Record<string, number> = {}
  const analysis = analyzeFileLevelFeatures('')

  const recs = await decodeRecordsFromAsyncIterable(chunks(), weights, schema as any, [], [], { lookaheadLines: 60, dynamicCandidates: analysis.candidates })

  // We expect at least two row records (John and Alice) and at least one outline record
  expect(recs.length).toBeGreaterThanOrEqual(3)

  // Check file offsets are non-overlapping and increasing
  for (let i = 1; i < recs.length; i++) {
    expect(recs[i]!.fileStart).toBeGreaterThanOrEqual(recs[i - 1]!.fileEnd)
  }
})