import { describe, it, expect } from 'vitest'
import { analyzeFileLevelFeatures, dynamicCandidatesToFeatures } from '../lib/features.js'

describe('file-level feature discovery', () => {
  it('detects indentation levels', () => {
    const input = `Header\n  item1\n  item2\n    sub\n  item3\nFooter`;
    const { candidates } = analyzeFileLevelFeatures(input)
    const indent = candidates.find(c => c.kind === 'indent' && c.indentLevel === 2)
    expect(indent).toBeDefined()
    expect(indent!.count).toBeGreaterThanOrEqual(3)
  })

  it('detects delimiter lines', () => {
    const input = `A\n---\nB\n---\nC`;
    const { candidates } = analyzeFileLevelFeatures(input)
    const delim = candidates.find(c => c.kind === 'delimiter' && c.examples.some(e => /-{3}/.test(e)))
    expect(delim).toBeDefined()
    expect(delim!.count).toBe(2)
  })

  it('converts candidates to runtime features', () => {
    const input = `1. foo\n2. bar\n3. baz`;
    const analysis = analyzeFileLevelFeatures(input)
    const { boundaryFeatures, segmentFeatures } = dynamicCandidatesToFeatures(analysis.candidates)
    expect(boundaryFeatures.length + segmentFeatures.length).toBeGreaterThan(0)
  })
})