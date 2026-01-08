import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { analyzeFileLevelFeatures, boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { decodeNextRecord } from '../lib/viterbi/streaming.js'
import { decodeJointSequence as decodeFull } from '../lib/viterbi/core.js'

function hrMs(n: bigint) { return Number(n) / 1e6 }

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function run() {
  // read from source tests data (compiled dist may not include test files)
  const p = path.join(__dirname, '..', '..', 'src', 'tests', 'data', 'case1.txt')
  const txt = fs.readFileSync(p, 'utf8')
  const lines = txt.split('\n')
  const spans = lines.map((ln, i) => ({ lineIndex: i, spans: [{ start: 0, end: ln.length }] }))

  const analysis = analyzeFileLevelFeatures(txt)
  const dynInit: Record<string, number> = {}
  for (const [k, v] of Object.entries(analysis.defaultWeights)) dynInit[`dyn:${k}`] = v

  const schema = { fields: [{ name: 'F1' }], noiseLabel: 'NOISE' }

  console.log('Case1 lines:', lines.length, 'candidates:', analysis.candidates.length)

  const runs = 3
  const fullTimes: number[] = []
  const fullMems: number[] = []
  for (let i = 0; i < runs; i++) {
    if ((global as any).gc) (global as any).gc()
    const memBefore = process.memoryUsage().heapUsed
    const t0 = process.hrtime.bigint()
    // decode full document using core decode
    const pathFull = decodeFull(lines, spans as any, { ...dynInit }, schema as any, boundaryFeatures, segmentFeatures)
    const t1 = process.hrtime.bigint()
    const memAfter = process.memoryUsage().heapUsed
    fullTimes.push(hrMs(t1 - t0))
    fullMems.push(memAfter - memBefore)
    console.log(`full run ${i}: ${hrMs(t1 - t0).toFixed(2)}ms, deltaHeap ${(memAfter - memBefore) / 1024 | 0}KB, states ${pathFull.length}`)
  }

  async function runStreamingWithWeights(wts: Record<string, number>, label: string, dynCands = analysis.candidates) {
    const streamTimes: number[] = []
    const streamPeakMems: number[] = []
    for (let i = 0; i < runs; i++) {
      if ((global as any).gc) (global as any).gc()
      const baseline = process.memoryUsage().heapUsed
      let peak = baseline
      const t0 = process.hrtime.bigint()
      let pos = 0
      let recs = 0
      while (pos < lines.length) {
        const r = decodeNextRecord(lines, spans as any, pos, { ...wts }, schema as any, boundaryFeatures, segmentFeatures, { lookaheadLines: 120, dynamicCandidates: dynCands })
        recs++
        const mem = process.memoryUsage().heapUsed
        if (mem > peak) peak = mem
        // safety guard
        if (r.endLine <= pos) break
        pos = r.endLine
      }
      const t1 = process.hrtime.bigint()
      streamTimes.push(hrMs(t1 - t0))
      streamPeakMems.push(peak - baseline)
      console.log(`${label} stream run ${i}: ${hrMs(t1 - t0).toFixed(2)}ms, deltaHeap ${(peak - baseline) / 1024 | 0}KB, records ${pos > 0 ? pos : 0}`)
      await new Promise(r => setTimeout(r, 20))
    }

    console.log(`${label} stream summary:`, {
      time: summarize(streamTimes),
      peakHeap: summarize(streamPeakMems)
    })
  }

  await runStreamingWithWeights({}, 'empty-weights')
  await runStreamingWithWeights(dynInit, 'dyn-init')
  // try limiting dynamic candidates to top-K for streaming
  const topK = 50
  const reducedCandidates = analysis.candidates.slice(0, topK)
  await runStreamingWithWeights(dynInit, `dyn-init-top${topK}`, reducedCandidates)
  // also try dyn candidates limited but using empty weights
  await runStreamingWithWeights({}, `empty-weights-top${topK}`, reducedCandidates)


  function summarize(arr: number[]) {
    const min = Math.min(...arr)
    const max = Math.max(...arr)
    const avg = arr.reduce((a,b) => a + b, 0) / arr.length
    return { min, max, avg }
  }

  console.log('\nSummary:')
  console.log('Full decode time (ms):', summarize(fullTimes))
  console.log('Full decode deltaHeap (bytes):', summarize(fullMems))
}

run().catch(err => { console.error(err); process.exit(1) })
