import { test, expect } from 'vitest'
import { updateWeightsForRecord, trainDocument } from '../lib/viterbi/trainer.js'
import type { Feature, JointSequence, FieldSchema, BoundaryState } from '../lib/types.js'

// Minimal synthetic test: line with a name token
const lines = ['Henry Johnson', '410-555-1234', 'j.h@example.com']
const spans = lines.map((l, i) => ({ lineIndex: i, spans: [{ start: 0, end: l.length }] }))
const schema: FieldSchema = { fields: [{ name: 'Name' }, { name: 'Phone' }, { name: 'Email' }], noiseLabel: 'NOISE' }

const boundaryFeatures: Feature[] = []
const segmentFeatures: Feature[] = []

test('updateWeightsForRecord increases segment.is_name for gold Name', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const jointGold: JointSequence = [{ boundary: 'B' as BoundaryState, fields: ['Name'] }]

  const res = updateWeightsForRecord(lines, spans, 0, 1, jointGold, weights, boundaryFeatures, segmentFeatures, schema, 0.5)

  expect(res.delta['segment.is_name']).toBeGreaterThan(0)
})

test('trainDocument applies updates across records', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  type GoldRecord = { startLine: number; endLine: number; jointGold: JointSequence }
  const goldRecords: GoldRecord[] = [{ startLine: 0, endLine: 1, jointGold: [{ boundary: 'B' as BoundaryState, fields: ['Name'] }] }]

  const res = trainDocument(lines, spans, goldRecords, weights, boundaryFeatures, segmentFeatures, schema, { epochs: 2, learningRate: 0.5 })

  expect(res.updated['segment.is_name']).toBeGreaterThan(0)
})


test('trainDocument minibatch updates weight (batchSize=2)', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const goldRecords = [
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B' as BoundaryState, fields: ['Name'] }] },
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B' as BoundaryState, fields: ['Name'] }] }
  ]

  const res = trainDocument(lines, spans, goldRecords, weights, boundaryFeatures, segmentFeatures, schema, { epochs: 1, learningRate: 0.5, batchSize: 2 })

  expect(res.updated['segment.is_name']).toBeGreaterThan(0)
})


test('learning rate schedule (exponential) decreases per-epoch updates', () => {
  const weights: Record<string, number> = { 'segment.is_name': 0 }
  const goldRecords = [
    { startLine: 0, endLine: 1, jointGold: [{ boundary: 'B' as BoundaryState, fields: ['Name'] }] }
  ]

  const res = trainDocument(lines, spans, goldRecords, weights, boundaryFeatures, segmentFeatures, schema, { epochs: 2, learningRate: 1.0, learningRateSchedule: { type: 'exponential', factor: 0.5 } })

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
  const jointGold = [{ boundary: 'B' as BoundaryState, fields: ['NOISE'] }]

  const res = updateWeightsForRecord(lines, spans, 0, 1, jointGold, weights, boundaryFeatures, segmentFeatures, schema, 1.0, undefined, undefined, 0.1)

  // regularization and model corrections should reduce the weight
  expect(res.delta['segment.is_name']).toBeLessThan(0)
  expect(res.updated['segment.is_name']).toBeLessThan(1.0)
})

test('trainDocument applies L2 across batches', () => {
  const weights: Record<string, number> = { 'segment.is_name': 1.0 }
  const goldRecords = [{ startLine: 0, endLine: 1, jointGold: [{ boundary: 'B' as BoundaryState, fields: ['NOISE'] }] }]

  const res = trainDocument(lines, spans, goldRecords, weights, boundaryFeatures, segmentFeatures, schema, { epochs: 1, learningRate: 1.0, regularizationLambda: 0.1 })

  expect(res.updated['segment.is_name']).toBeLessThan(1.0)
})