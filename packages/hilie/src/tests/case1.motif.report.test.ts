import { test } from 'vitest'
import { analyzeFileLevelFeatures } from '../lib/features.js'
import fs from 'fs'
import path from 'path'

test('report motifs for case1.txt', () => {
  const p = path.join(__dirname, 'data', 'case1.txt')
  const txt = fs.readFileSync(p, 'utf8')
  const analysis = analyzeFileLevelFeatures(txt)

  const total = analysis.candidates.length
  const motifs = analysis.candidates.filter(c => c.kind === 'motif')
  const delimiters = analysis.candidates.filter(c => c.kind === 'delimiter')
  const indents = analysis.candidates.filter(c => c.kind === 'indent')

  // Print concise report
  console.log(`Case1 feature analysis report:`)
  console.log(`  totalCandidates: ${total}`)
  console.log(`  motifCandidates: ${motifs.length}`)
  console.log(`  delimiterCandidates: ${delimiters.length}`)
  console.log(`  indentCandidates: ${indents.length}`)

  console.log(`  top motif samples (count|id|roles):`)
  motifs.sort((a,b) => b.count - a.count)
  for (const m of motifs.slice(0,10)) {
    console.log(`    ${m.count} | ${m.id} | ${m.roles.join(',')} | examples=${m.examples.join('|')}`)
  }

  // Basic sanity asserts to keep test deterministic
  if (analysis.candidates.length === 0) throw new Error('no candidates found')
})