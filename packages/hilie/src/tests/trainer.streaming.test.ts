import { test, expect } from 'vitest'
import { updateWeightsForRecord, trainDocument } from '../lib/viterbi/trainer.js'

// Minimal synthetic test: line with a name token
const lines = ['Henry Johnson', '410-555-1234', 'j.h@example.com']
const spans = lines.map((l, i) => ({ lineIndex: i, spans: [{ start: 0, end: l.length }] }))
const schema = { fields: [{ name: 'Name' }, { name: 'Phone' }, { name: 'Email' }], noiseLabel: 'NOISE' }

const boundaryFeatures: any[] = []
const segmentFeatures: any[] = []

test('updateWeightsForRecord increases segment.is_name for gold Name', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const jointGold = [{ boundary: 'B', fields: ['Name'] }]

  const res = updateWeightsForRecord(lines, spans, 0, 1, jointGold as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, 0.5)

  expect(res.delta['segment.is_name']).toBeGreaterThan(0)
})

test('trainDocument applies updates across records', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const goldRecords = [{ startLine: 0, endLine: 1, jointGold: [{ boundary: 'B', fields: ['Name'] }] }]

  const res = trainDocument(lines, spans, goldRecords as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, { epochs: 2, learningRate: 0.5 })

  expect(res.updated['segment.is_name']).toBeGreaterThan(0)
})


test('trainDocument minibatch updates weight (batchSize=2)', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const goldRecords = [
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B', fields: ['Name'] }] },
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B', fields: ['Name'] }] }
  ]

  const res = trainDocument(lines, spans, goldRecords as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, { epochs: 1, learningRate: 0.5, batchSize: 2 })

  expect(res.updated['segment.is_name']).toBeGreaterThan(0)
})


test('learning rate schedule (exponential) decreases per-epoch updates', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const goldRecords = [
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B', fields: ['Name'] }] }
  ]

  const res = trainDocument(lines, spans, goldRecords as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, { epochs: 2, learningRate: 1.0, learningRateSchedule: { type: 'exponential', factor: 0.5 } })

  // history contains per-epoch snapshots
  const h0 = res.history[0]?.['segment.is_name'] ?? 0
  const h1 = res.history[1]?.['segment.is_name'] ?? 0
  const d0 = h0 - 0
  const d1 = h1 - h0

  expect(d0).toBeGreaterThan(0)
  expect(d1).toBeGreaterThan(0)
  expect(d0).toBeGreaterThan(d1)
})


test('updateWeightsForRecord applies L2 regularization', () => {
  const weights: Record<string, number> = { 'segment.is_name': 1.0 }
  const jointGold = [{ boundary: 'B', fields: ['NOISE'] }]

  const res = updateWeightsForRecord(lines, spans, 0, 1, jointGold as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, 1.0, undefined, undefined, 0.1)

  // regularization and model corrections should reduce the weight
  expect(res.delta['segment.is_name']).toBeLessThan(0)
  expect(res.updated['segment.is_name']).toBeLessThan(1.0)
})

test('trainDocument applies L2 across batches', () => {
  const weights: Record<string, number> = { 'segment.is_name': 1.0 }
  const goldRecords = [{ startLine: 0, endLine: 1, jointGold: [{ boundary: 'B', fields: ['NOISE'] }] }]

  const res = trainDocument(lines, spans, goldRecords as any, weights, boundaryFeatures as any, segmentFeatures as any, schema as any, { epochs: 1, learningRate: 1.0, regularizationLambda: 0.1 })

  expect(res.updated['segment.is_name']).toBeLessThan(1.0)
})