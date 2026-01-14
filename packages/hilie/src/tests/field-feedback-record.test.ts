import { test, expect } from 'vitest'
import { updateWeightsFromUserFeedback } from '../lib/viterbi.js'
import { candidateSpanGenerator } from '../lib/utils.js'
const householdInfoSchema = {
  fields: [
    { name: 'ExtID', maxAllowed: 1 },
    { name: 'Name', maxAllowed: 2 },
    { name: 'PreferredName', maxAllowed: 1 },
    { name: 'Phone', maxAllowed: 3 },
    { name: 'Email', maxAllowed: 3 },
    { name: 'GeneralNotes', maxAllowed: 1 },
    { name: 'MedicalNotes', maxAllowed: 1 },
    { name: 'DietaryNotes', maxAllowed: 1 },
    { name: 'Birthdate', maxAllowed: 1 }
  ],
  noiseLabel: 'NOISE'
} as any
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'

// Simple test: a field-only feedback on line 0 should create a RecordSpan
// containing that line and the asserted field.

test('field-only feedback creates a record containing the asserted field', () => {
  const lines = [
    'John Doe, 123-456-7890',
    '',
    'Jane Smith, 987-654-3210'
  ]

  const spans = candidateSpanGenerator(lines)

  // Initial decode (no feedback) - we don't need it for this test, but trainer expects a pred
  const fakePred = Array.from({ length: lines.length }, () => ({ boundary: 'C', fields: [] }))

  const fb = {
    entries: [
      {
        kind: 'field',
        field: {
          action: 'add',
          lineIndex: 0,
          start: 0,
          end: 8,
          fieldType: 'Name',
          confidence: 1
        }
      }
    ]
  }

  const weights: Record<string, number> = {}

  const res = updateWeightsFromUserFeedback(lines, spans, fakePred as any, fb as any, weights, boundaryFeatures, segmentFeatures, householdInfoSchema)

  const records = res.pred
  expect(records.length).toBeGreaterThan(0)
  const rec = records.find(r => r.startLine <= 0 && r.endLine >= 0)
  expect(rec).toBeDefined()
  const hasField = (rec!.entities ?? []).some(se => (se.fields ?? []).some(f => f.lineIndex === 0 && f.start === 0 && f.end === 8 && f.fieldType === 'Name'))
  expect(hasField).toBe(true)
})