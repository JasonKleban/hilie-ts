import { decodeRecordsStreaming } from '../lib/viterbi/streaming.js'
import { spanGenerator } from '../lib/utils.js'
import { boundaryFeatures, segmentFeatures } from '../lib/features.js'
import { householdInfoSchema } from './test-helpers.js'

declare const test: any;

// Seeded PRNG for repeatability
function mulberry32(seed: number) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

function randInt(r: () => number, lo: number, hi: number) {
  return Math.floor(r() * (hi - lo + 1)) + lo;
}

const FIRST_NAMES = ['Henry','Oliver','James','Emma','Olivia','Ava','Mia','Noah','Liam','Sophia','Isabella']
const LAST_NAMES = ['Johnson','Smith','Brown','Taylor','Anderson','Thomas','Jackson','White']

test('randomized cross-window sub-entity assertions produce coverage and non-overlap', () => {
  const SEED = 123456
  const r = mulberry32(SEED)
  const TRIALS = 40
  for (let t = 0; t < TRIALS; t++) {
    const LINES = 20
    const lines: string[] = []
    for (let i = 0; i < LINES; i++) {
      const name = `${FIRST_NAMES[randInt(r,0,FIRST_NAMES.length-1)]} ${LAST_NAMES[randInt(r,0,LAST_NAMES.length-1)]}`
      const ext = Math.random() < 0.5 ? `${Math.random() < 0.5 ? 'DB' : '45'}${Math.floor(r()*900000).toString(36).toUpperCase()}` : ''
      const extra = Math.random() < 0.3 ? `\t* ${2010 + randInt(r,0,9)}-${String(randInt(r,1,12)).padStart(2,'0')}-${String(randInt(r,1,28)).padStart(2,'0')}` : ''
      const line = ext ? `${name}\t${ext}${extra}` : `${name}${extra}`
      lines.push(line)
    }

    let spans = spanGenerator(lines, { delimiterRegex: /\t/ })

    // Add random container spans on some lines to emulate nested candidates
    for (let li = 0; li < LINES; li++) {
      if (r() < 0.2) {
        const line = lines[li]!;
        if (line.length > 3) {
          const start = 0
          const end = Math.max(1, Math.min(line.length, Math.floor(r() * line.length) + 1))
          spans[li]!.spans.push({ start, end })
        }
      }
      // Add a random superset
      if (r() < 0.1) {
        const line = lines[li]!;
        spans[li]!.spans.push({ start: 0, end: line.length })
      }
      // Ensure deterministic ordering
      spans[li]!.spans.sort((a,b)=>a.start - b.start || a.end - b.end)
    }

    // Choose an asserted sub-entity that likely crosses a window boundary
    const lookahead = randInt(r, 2, 4) // small lookahead to force windows
    const startLine = randInt(r, 0, LINES - 4)
    const length = randInt(r, 1, 4)
    const endLine = Math.min(LINES - 1, startLine + length)

    // Build file-level offsets
    const lineStarts: number[] = []
    let acc = 0
    for (const ln of lines) {
      lineStarts.push(acc)
      acc += ln.length + 1
    }

    const fb: any = {
      entries: [ { kind: 'subEntity', fileStart: lineStarts[startLine]!, fileEnd: lineStarts[endLine]! + lines[endLine]!.length, entityType: 'Guardian' } ]
    }

    // Randomize other decoding options
    const opts: any = { lookaheadLines: lookahead, feedback: fb, carryover: r() < 0.5, beam: randInt(r,1,4) }

    const recs = decodeRecordsStreaming(lines, spans as any, {}, householdInfoSchema, boundaryFeatures, segmentFeatures, opts)
    // Collect per-line spans resulting from decoding
    const lineToSpans: Record<number, {start:number,end:number}[]> = {}
    for (const rec of recs) {
      for (let i = 0; i < rec.spansPerLine.length; i++) {
        const gLi = rec.startLine + i
        if (gLi >= startLine && gLi <= endLine) {
          lineToSpans[gLi] = rec.spansPerLine[i]!.spans
        }
      }
    }

    // Validate
    for (let li = startLine; li <= endLine; li++) {
      const s = lineToSpans[li]
      if (!s) throw new Error(`trial ${t}: missing spans for asserted line ${li}`)
      // Ensure non-nested
      for (let i = 0; i < s.length; i++) {
        for (let j = i+1; j < s.length; j++) {
          const a = s[i]!, b = s[j]!
          if (a.start <= b.start && a.end >= b.end) throw new Error(`trial ${t}: nested spans on line ${li}: ${JSON.stringify(a)} contains ${JSON.stringify(b)}; lookahead=${lookahead} carry=${opts.carryover} beam=${opts.beam}`)
        }
      }
      // Ensure coverage across asserted interval on that line
      const assertStart = Math.max(0, (lineStarts[li]! < lineStarts[startLine]! ? 0 : lineStarts[startLine]! ) - lineStarts[li]!)
      const assertEnd = Math.min(lines[li]!.length, (lineStarts[endLine]! + lines[endLine]!.length) - lineStarts[li]!)
      let cur = assertStart
      for (const sp of s.sort((a,b)=>a.start-b.start)) {
        if (sp.start > cur) throw new Error(`trial ${t}: gap on line ${li}: next start ${sp.start} > cur ${cur}`)
        if (sp.end > cur) cur = sp.end
      }
      if (cur < assertEnd) throw new Error(`trial ${t}: coverage incomplete on line ${li}: reached ${cur} expected ${assertEnd}`)
      // Also ensure non-overlapping spans
      const sorted = [...s].sort((a,b)=>a.start - b.start || a.end - b.end)
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i-1]!, curr = sorted[i]!
        if (prev.end > curr.start) throw new Error(`trial ${t}: overlapping spans on line ${li}: ${prev.start}-${prev.end} vs ${curr.start}-${curr.end}`)
      }
    }
  }
})
