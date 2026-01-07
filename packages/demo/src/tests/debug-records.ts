import fs from 'fs'
import path from 'path'
import { candidateSpanGenerator, decodeJointSequence, entitiesFromJointSequence } from 'hilie'
import { boundaryFeatures, segmentFeatures } from 'hilie'
import { householdInfoSchema } from '../schema.js'

console.log('Debug records for 84-85')
const casePath = path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', 'case1.txt')
const text = fs.readFileSync(casePath, 'utf8')
const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const lines = normalized.split('\n')
const spans = candidateSpanGenerator(lines)

const weights = {
  'line.indentation_delta': 0.5,
  'line.lexical_similarity_drop': 1.0,
  'line.blank_line': 1.0,
  'segment.token_count_bucket': 0.8,
  'segment.numeric_ratio': 1.2,
  'segment.is_email': 2.0,
  'segment.is_phone': 1.5,
  'field.relative_position_consistency': 0.6,
  'field.optional_penalty': -0.4
}

const pred = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 512, safePrefix: 6 })
const records = entitiesFromJointSequence(lines, spans, pred, weights, segmentFeatures, householdInfoSchema)

for (const r of records) {
  if (r.fileStart === 84 && r.fileEnd === 97) {
    console.log('Record', r.fileStart, r.fileEnd)
    for (const s of (r.subEntities ?? [])) {
      console.log('  Sub', s.entityType, s.fileStart, s.fileEnd)
      for (const f of (s.fields ?? [])) {
        console.log('    Field', f.fieldType, f.fileStart, f.fileEnd)
      }
    }
  }
}

console.log('Done')
