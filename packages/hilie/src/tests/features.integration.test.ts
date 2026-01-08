import { describe, it, expect } from 'vitest'
import { analyzeFileLevelFeatures } from '../lib/features.js'
import { updateWeightsFromUserFeedback } from '../lib/viterbi/trainer.js'

describe('integration: dynamic features in trainer', () => {
  it('merges dynamic initial weights and exposes dyn: keys in weights', () => {
    const input = `1. a\n2. b\n3. c`;
    const analysis = analyzeFileLevelFeatures(input)

    const lines = input.split('\n')
    const spans = lines.map((ln, i) => ({ lineIndex: i, spans: [{ start: 0, end: ln.length }] }))
    const jointSeq = lines.map(() => ({ boundary: 'C', fields: ['NOISE'] }))
    const feedback = { entries: [] }
    const weights: Record<string, number> = {}

    const schema = { fields: [{ name: 'F1' }], noiseLabel: 'NOISE' }

    const res = updateWeightsFromUserFeedback(lines, spans, jointSeq as any, feedback as any, weights, [], [], schema as any, 1.0, undefined, 0.15, analysis.candidates, analysis.defaultWeights)

    const sampleDynKey = Object.keys(analysis.defaultWeights)[0]
    expect(sampleDynKey).toBeDefined()
    const dynPrefixed = `dyn:${sampleDynKey}`
    expect(res.updated[dynPrefixed]).toBeDefined()
  })
})