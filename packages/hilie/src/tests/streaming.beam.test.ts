import { test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { analyzeFileLevelFeatures } from '../lib/features.js'
import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'

const p = path.join(__dirname, 'data', 'case1.txt')
const txt = fs.readFileSync(p, 'utf8')
const lines = txt.split('\n')
const spans = lines.map((ln, i) => ({ lineIndex: i, spans: [{ start: 0, end: ln.length }] }))
const schema = { fields: [{ name: 'F1' }], noiseLabel: 'NOISE' }
const analysis = analyzeFileLevelFeatures(txt)

test('streaming with beam carryover runs and produces records', () => {
  const weights: Record<string, number> = {}

  const recsNoCarry = decodeRecordsStreaming(lines, spans, weights, schema as any, [], [], { lookaheadLines: 60, beam: 1, carryover: false })
  const recsCarry = decodeRecordsStreaming(lines, spans, weights, schema as any, [], [], { lookaheadLines: 60, beam: 4, carryover: true, dynamicCandidates: analysis.candidates })

  expect(recsNoCarry.length).toBeGreaterThan(10)
  expect(recsCarry.length).toBeGreaterThan(10)

  // Ensure coverage from start to end
  expect(recsNoCarry[0]?.startLine).toBe(0)
  expect(recsNoCarry[recsNoCarry.length - 1]?.endLine).toBe(lines.length)
  expect(recsCarry[0]?.startLine).toBe(0)
  expect(recsCarry[recsCarry.length - 1]?.endLine).toBe(lines.length)
})