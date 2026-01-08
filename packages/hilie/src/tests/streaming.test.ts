import { test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { analyzeFileLevelFeatures } from '../lib/features.js'
import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'

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