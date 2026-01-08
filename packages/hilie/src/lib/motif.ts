// =======================
// Types
// =======================

type RhythmicSubstring = {
  pattern: RegExp
  minLength: number
  maxLength: number
  /** dimensionless, scale-normalized significance of a sequence/pattern. */
  salience: number
  /** Variance measures regularity quality */
  variance: number
  count: number
}

type MotifNode = {
  pattern: RegExp
  minLength: number
  maxLength: number
  salience: number
  variance: number
  count: number

  children: MotifNode[]
  harmonics: MotifNode[]
}

type Occurrence = { pos: number; len: number }

type AnalysisResult = {
  motifs: RhythmicSubstring[]
  occurrences: Map<string, Occurrence[]>
}

export type RankedPattern = {
  pattern: RegExp
  minLength: number
  maxLength: number
  salience: number
  variance: number
  count: number
  strength: number
}

// =======================
// Utilities
// =======================

function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  let v = 0
  for (const x of values) {
    const d = x - mean
    v += d * d
  }
  return v / values.length
}

export function patternKeyForRegex(r: RegExp) {
  return `${r.source}/${r.flags}`
}

function escapeRegexLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}



function collect(node: MotifNode): MotifNode[] {
  return [node, ...node.children.flatMap(collect)]
}

// =======================
// Core Analysis (pattern-based, breaking change)
// =======================

function generalizePatterns(seq: string, atLineStart: boolean): RegExp[] {
  const patterns: RegExp[] = []
  // exact literal
  patterns.push(new RegExp(escapeRegexLiteral(seq), 'g'))

  // digits generalization
  if (/\d/.test(seq)) {
    // const pat = new RegExp(escapeRegexLiteral(seq).replace(/\\\d\+/g, '\\d+').replace(/\\\d/g, '\\d'), 'g')
    // patterns.push(pat)
    // generic digits substitution
    patterns.push(new RegExp(escapeRegexLiteral(seq).replace(/\d+/g, '\\d+'), 'g'))
  }

  // // whitespace generalization
  // if (/\s/.test(seq)) {
  //   patterns.push(new RegExp(escapeRegexLiteral(seq).replace(/\s+/g, '\\s+'), 'g'))
  // }

  // // word char generalization
  // if (/[A-Za-z]/.test(seq)) {
  //   patterns.push(new RegExp(escapeRegexLiteral(seq).replace(/[A-Za-z]+/g, '\\w+'), 'g'))
  // }

  // // combined generalizations
  // patterns.push(new RegExp(escapeRegexLiteral(seq).replace(/\d+/g, '\\d+').replace(/\s+/g, '\\s+'), 'g'))

  if (atLineStart) {
    // anchored variants
    const anchored = patterns.map(p => new RegExp('^' + p.source, p.flags.includes('m') ? p.flags : p.flags + 'm'))
    patterns.push(...anchored)
  }

  const uniq: Map<string, RegExp> = new Map()
  for (const p of patterns) uniq.set(patternKeyForRegex(p), p)
  return [...uniq.values()]
}

export function analyzeSubstringRhythmicity(
  input: string,
  epsilon = 1e-6,
  minSimpleLength = 5,
  opts?: { maxPatternLen?: number; maxPatterns?: number; minOccurrences?: number }
): AnalysisResult {
  const N = input.length
  const Lmax = Math.floor(N / 4)

  const maxPatternLen = Math.min(opts?.maxPatternLen ?? 32, Lmax)
  const maxPatterns = opts?.maxPatterns ?? 1000
  const minOccurrences = opts?.minOccurrences ?? 3

  const patternMap = new Map<string, RegExp>()
  const simpleCharRe = /^[- a-zA-Z,]+$/

  // For each substring length k up to maxPatternLen, count literal substrings and only
  // generalize those that appear at least `minOccurrences` times. This avoids the
  // combinatorial explosion on large inputs and keeps memory use bounded.
  for (let k = 1; k <= maxPatternLen; k++) {
    // Count literal sequences of length k
    const seqCounts = new Map<string, number>()
    for (let p = 0; p + k <= N; p++) {
      const seq = input.slice(p, p + k)
      if (simpleCharRe.test(seq) && seq.length < minSimpleLength) continue
      seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1)
    }

    if (seqCounts.size === 0) continue

    // If there are too many unique sequences for this k, keep only the top ones by frequency
    const MAX_UNIQUE_SEQS = 5000
    let seqEntries: Array<[string, number]> = [...seqCounts.entries()]
    if (seqEntries.length > MAX_UNIQUE_SEQS) {
      seqEntries.sort((a, b) => b[1] - a[1])
      seqEntries = seqEntries.slice(0, 2000)
    }

    for (const [seq, cnt] of seqEntries) {
      if (cnt < minOccurrences) continue

      // find atLineStart by checking a few occurrence positions
      let atLineStart = false
      let idx = input.indexOf(seq, 0)
      let found = 0
      while (idx !== -1 && found < 10) {
        if (idx === 0 || input[idx - 1] === '\n') {
          atLineStart = true
          break
        }
        found++
        idx = input.indexOf(seq, idx + 1)
      }

      const patterns = generalizePatterns(seq, atLineStart)
      for (const pat of patterns) {
        const key = patternKeyForRegex(pat)
        if (!patternMap.has(key)) patternMap.set(key, pat)
        if (patternMap.size >= maxPatterns) break
      }

      if (patternMap.size >= maxPatterns) break
    }

    if (patternMap.size >= maxPatterns) break
  }

  // Now discover occurrences for each unique pattern by scanning the input
  const occurrences = new Map<string, Occurrence[]>()
  for (const [key, pat] of patternMap) {
    const arr: Occurrence[] = []
    const g = new RegExp(pat.source, pat.flags.replace('g', '') + 'g')
    let m: RegExpExecArray | null
    while ((m = g.exec(input)) !== null) {
      arr.push({ pos: m.index, len: m[0].length })
      // avoid infinite loops for zero-length matches
      if (m.index === g.lastIndex) g.lastIndex++
    }
    occurrences.set(key, arr)
  }

  const results: RhythmicSubstring[] = []

  for (const [key, occs] of occurrences) {
    if (occs.length < 3) continue
    const positions = occs.map(o => o.pos)
    const distances: number[] = []
    for (let i = 1; i < positions.length; i++) distances.push(positions[i]! - positions[i - 1]!)
    const v = variance(distances)
    const count = occs.length
    const pat = patternMap.get(key)!
    const lengths = occs.map(o => o.len)
    const minLen = Math.max(1, Math.min(...lengths))
    const maxLen = Math.max(...lengths)
    const energy = (count / (v + epsilon)) / minLen
    results.push({ pattern: pat, minLength: minLen, maxLength: maxLen, salience: energy, variance: v, count })
  }

  // normalize salience by average energy for same minLength groups
  const byMin = new Map<number, RhythmicSubstring[]>()
  for (const r of results) {
    const arr = byMin.get(r.minLength) ?? []
    arr.push(r)
    byMin.set(r.minLength, arr)
  }

  for (const arr of byMin.values()) {
    const avg = arr.reduce((s, x) => s + x.salience, 0) / arr.length
    for (const x of arr) x.salience = avg > 0 ? x.salience / avg : 0
  }

  results.sort((a, b) => b.salience - a.salience)
  return { motifs: results, occurrences }
}

// =======================
// Hierarchical Motif Tree
// =======================

function buildMotifHierarchy(
  input: string,
  analysis: AnalysisResult,
  coverageThreshold = 0.7
): MotifNode[] {
  const N = input.length
  const covered = new Array<boolean>(N).fill(false)

  const nodeMap = new Map<string, MotifNode>()
  for (const m of analysis.motifs) {
    nodeMap.set(patternKeyForRegex(m.pattern), {
      pattern: m.pattern,
      minLength: m.minLength,
      maxLength: m.maxLength,
      salience: m.salience,
      variance: m.variance,
      count: m.count,
      children: [],
      harmonics: []
    })
  }

  const sorted = [...analysis.motifs].sort(
    (a, b) => b.minLength - a.minLength || b.salience - a.salience
  )

  const roots: MotifNode[] = []

  for (const m of sorted) {
    const positions = analysis.occurrences.get(patternKeyForRegex(m.pattern))
    if (!positions) continue

    let coveredChars = 0
    let totalChars = positions.reduce((s, o) => s + o.len, 0)

    for (const o of positions) {
      for (let i = o.pos; i < o.pos + o.len; i++) {
        if (covered[i]) coveredChars++
      }
    }

    const ratio = totalChars === 0 ? 0 : coveredChars / totalChars

    if (ratio < coverageThreshold) {
      const node = nodeMap.get(patternKeyForRegex(m.pattern))!
      roots.push(node)

      for (const o of positions) {
        for (let i = o.pos; i < o.pos + o.len; i++) {
          covered[i] = true
        }
      }
    }
  }

  // establish containment-based children: heuristic using sample matches
  for (const parent of roots) {
    for (const child of roots) {
      if (child.minLength >= parent.minLength) continue
      const childOcc = analysis.occurrences.get(patternKeyForRegex(child.pattern)) ?? []
      const sample = childOcc[0]
      if (!sample) continue
      const sampleText = input.slice(sample.pos, sample.pos + sample.len)
      if (parent.pattern.test(sampleText)) parent.children.push(child)
    }
  }

  return roots
}

// =======================
// Harmonic Alignment
// =======================

function attachHarmonics(
  roots: MotifNode[],
  occurrences: Map<string, Occurrence[]>,
  varianceThreshold = 0.2
) {
  const all = roots.flatMap(r => collect(r))

  for (const a of all) {
    const pa = occurrences.get(patternKeyForRegex(a.pattern))
    if (!pa || pa.length < 2) continue

    const da = pa.slice(1).map((p, i) => p.pos - pa[i]!.pos)

    for (const b of all) {
      if (a === b) continue
      if (b.minLength % a.minLength !== 0) continue

      const pb = occurrences.get(patternKeyForRegex(b.pattern))
      if (!pb || pb.length < 2) continue

      const db = pb.slice(1).map((p, i) => p.pos - pb[i]!.pos)
      const ratio = b.minLength / a.minLength

      const projected = da.map(d => d * ratio)
      const aligned = projected
        .slice(0, Math.min(projected.length, db.length))
        .map((x, i) => x - db[i]!)

      if (variance(aligned) < varianceThreshold) {
        a.harmonics.push(b)
      }
    }
  }
}

// =======================
// One-call convenience API
// =======================

function analyzeMotifs(input: string, minSimpleLength = 5): MotifNode[] {
  const analysis = analyzeSubstringRhythmicity(input, 1e-6, minSimpleLength)
  const roots = buildMotifHierarchy(input, analysis)
  attachHarmonics(roots, analysis.occurrences)
  return roots
}


function harmonicComponents(
  roots: MotifNode[]
): MotifNode[][] {
  const all = roots.flatMap(r => collect(r))
  const visited = new Set<MotifNode>()
  const components: MotifNode[][] = []

  for (const node of all) {
    if (visited.has(node)) continue

    const stack = [node]
    const component: MotifNode[] = []
    visited.add(node)

    while (stack.length > 0) {
      const cur = stack.pop()!
      component.push(cur)

      for (const h of cur.harmonics) {
        if (!visited.has(h)) {
          visited.add(h)
          stack.push(h)
        }
      }
    }

    components.push(component)
  }

  return components
}

function representativeOf(
  family: MotifNode[]
): MotifNode {
  return family.reduce((best, m) => {
    const score = m.salience * m.minLength * m.count
    const bestScore = best.salience * best.minLength * best.count
    return score > bestScore ? m : best
  })
}

function rankPatterns(
  roots: MotifNode[]
): RankedPattern[] {
  const families = harmonicComponents(roots)

  const reps = families.map(representativeOf)

  const ranked = reps.map(m => ({
    pattern: m.pattern,
    minLength: m.minLength,
    maxLength: m.maxLength,
    salience: m.salience,
    variance: m.variance,
    count: m.count,
    strength:
      m.salience *
      Math.log2(1 + m.count) *
      m.minLength
  }))

  ranked.sort((a, b) => b.strength - a.strength)
  return ranked
}

export function findSignificantMotifs(input: string, minSimpleLength = 5) : RankedPattern[] {
  return rankPatterns(analyzeMotifs(input, minSimpleLength));
}