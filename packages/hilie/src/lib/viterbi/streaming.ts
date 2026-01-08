import type { Feature, LineSpans, JointSequence, FieldSchema, EnumerateOptions, Feedback } from '../types.js'
import { decodeJointSequence, prepareDecodeCaches, decodeWindowUsingCaches } from './core.js'
import type { FeatureCandidate } from '../features.js'
import { dynamicCandidatesToFeatures } from '../features.js'
import { buildFeedbackContext } from './feedback.js'

export type DecodeNextOpts = {
  lookaheadLines?: number
  enumerateOpts?: EnumerateOptions
  dynamicCandidates?: FeatureCandidate[]
  dynamicInitialWeights?: Record<string, number>
  beam?: number
  carryover?: boolean
  dynamicCandidateLimit?: number
  feedback?: Feedback
}

export function decodeNextRecord(
  lines: string[],
  spansPerLine: LineSpans[],
  startLine: number,
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  opts?: DecodeNextOpts
): { pred: JointSequence; spansPerLine: LineSpans[]; startLine: number; endLine: number; confidence: number } {
  const lookahead = Math.max(1, opts?.lookaheadLines ?? 32)
  const endExclusive = Math.min(lines.length, startLine + lookahead)

  // If feedback is present, build a feedback-aware spans copy and enumerate options
  let spansToUse = spansPerLine
  let fbEnumOpts = opts?.enumerateOpts
  if (opts?.feedback) {
    const fbCtx = buildFeedbackContext(lines, spansPerLine, opts.feedback as Feedback)
    spansToUse = fbCtx.spansCopy
    const base = opts?.enumerateOpts ?? {}
    const safePrefix = (fbCtx.maxAssertedSpanIdx < 0) ? base.safePrefix : Math.max((base.safePrefix ?? 8), fbCtx.maxAssertedSpanIdx + 1)
    fbEnumOpts = { ...base, ...(safePrefix !== undefined ? { safePrefix } : {}), forcedLabelsByLine: fbCtx.forcedLabelsByLine, forcedBoundariesByLine: fbCtx.forcedBoundariesByLine, forcedEntityTypeByLine: fbCtx.forcedEntityTypeByLine }
  }

  const windowLines = lines.slice(startLine, endExclusive)
  const windowSpans = spansToUse.slice(startLine, endExclusive)

  // Merge dynamic features if present
  let bFeatures = [...boundaryFeaturesArg]
  let sFeatures = [...segmentFeaturesArg]
  if (opts?.dynamicCandidates && opts.dynamicCandidates.length) {
    const dyn = dynamicCandidatesToFeatures(opts.dynamicCandidates)
    bFeatures = bFeatures.concat(dyn.boundaryFeatures)
    sFeatures = sFeatures.concat(dyn.segmentFeatures)
  }

  // Apply dynamic initial weights to local weights copy so dynamic features have defaults
  if (opts?.dynamicInitialWeights) {
    for (const [k, v] of Object.entries(opts.dynamicInitialWeights)) {
      const dynKey = `dyn:${k}`
      if (weights[dynKey] === undefined) weights[dynKey] = v
    }
  }

  // Note: we do not modify global weights here; callers may pass a copy if needed
  const predLocal = decodeJointSequence(windowLines, windowSpans, weights, schema, bFeatures, sFeatures, fbEnumOpts)
  // Find the next 'B' boundary after the first line (i.e., mark record end)
  let nextBIdx = -1
  for (let i = 1; i < predLocal.length; i++) {
    const s = predLocal[i]
    if (s && s.boundary === 'B') {
      nextBIdx = i
      break
    }
  }

  const foundBound = nextBIdx >= 0
  const endLine = foundBound ? (startLine + nextBIdx) : Math.min(lines.length, endExclusive)

  // Simple confidence heuristic: proportion of windows lines around boundary that have boundaryFeatures positive
  let confidence = foundBound ? 1 : 0.5

  return { pred: predLocal, spansPerLine: windowSpans, startLine, endLine, confidence }
}

export function decodeRecordsStreaming(
  lines: string[],
  spansPerLine: LineSpans[],
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeatures: Feature[],
  segmentFeatures: Feature[],
  opts?: DecodeNextOpts
) {
  const records: Array<{ pred: JointSequence; spansPerLine: LineSpans[]; startLine: number; endLine: number; confidence: number }> = []

  // If feedback is present, build context and produce a modified spans copy
  let spansToUse = spansPerLine
  let fbEnumOpts = opts?.enumerateOpts
  if (opts?.feedback) {
    const fbCtx = buildFeedbackContext(lines, spansPerLine, opts.feedback as Feedback)
    spansToUse = fbCtx.spansCopy
    const base = opts?.enumerateOpts ?? {}
    const safePrefix = (fbCtx.maxAssertedSpanIdx < 0) ? base.safePrefix : Math.max((base.safePrefix ?? 8), fbCtx.maxAssertedSpanIdx + 1)
    fbEnumOpts = { ...base, ...(safePrefix !== undefined ? { safePrefix } : {}), forcedLabelsByLine: fbCtx.forcedLabelsByLine, forcedBoundariesByLine: fbCtx.forcedBoundariesByLine, forcedEntityTypeByLine: fbCtx.forcedEntityTypeByLine }
  }

  // Pre-merge dynamic features once to avoid repeated allocations in loop
  let dynBoundary: Feature[] = []
  let dynSegment: Feature[] = []
  if (opts?.dynamicCandidates && opts.dynamicCandidates.length) {
    // allow streaming to limit number of dynamic candidates (default: 50)
    const limit = (opts as any).dynamicCandidateLimit ?? 50
    const sorted = opts.dynamicCandidates.slice().sort((a, b) => ((b.count ?? 0) * (b.salience ?? 1)) - ((a.count ?? 0) * (a.salience ?? 1)))
    const chosen = sorted.slice(0, limit)
    const dyn = dynamicCandidatesToFeatures(chosen)
    dynBoundary = dyn.boundaryFeatures
    dynSegment = dyn.segmentFeatures
  }

  // Apply dynamic initial weights (if provided) to the weights object so dyn features have defaults
  if (opts?.dynamicInitialWeights) {
    for (const [k, v] of Object.entries(opts.dynamicInitialWeights)) {
      const dynKey = `dyn:${k}`
      if (weights[dynKey] === undefined) weights[dynKey] = v
    }
  }

  // Prepare caches once to avoid recomputing features for each window
  const caches = prepareDecodeCaches(lines, spansToUse, weights, schema, boundaryFeatures.concat(dynBoundary), segmentFeatures.concat(dynSegment), fbEnumOpts)

  // carry beam between windows
  let carryBeam: Array<import('./core.js').BeamEntry> = []

  let pos = 0
  while (pos < lines.length) {
    const lookahead = Math.max(1, opts?.lookaheadLines ?? 32)
    const endExclusive = Math.min(lines.length, pos + lookahead)

    // Use feedback-aware spans and enumerate options if available
    const res = decodeWindowUsingCaches(pos, endExclusive, lines, weights, schema, caches, undefined, carryBeam, (opts?.beam ?? 1))
    const predLocal = res.path

    // Find the next 'B' boundary after the first line
    let nextBIdx = -1
    for (let i = 1; i < predLocal.length; i++) {
      const s = predLocal[i]
      if (s && s.boundary === 'B') {
        nextBIdx = i
        break
      }
    }

    const foundBound = nextBIdx >= 0
    const endLine = foundBound ? (pos + nextBIdx) : Math.min(lines.length, endExclusive)
    let confidence = foundBound ? 1 : 0.5

    let windowSpans = spansToUse.slice(pos, endExclusive)


    records.push({ pred: predLocal, spansPerLine: windowSpans, startLine: pos, endLine, confidence })

    // set carry beam for next window if enabled
    if (opts?.carryover === false || (opts?.beam ?? 1) <= 1) carryBeam = []
    else carryBeam = res.outgoingBeam ?? []

    if (endLine <= pos) break
    pos = endLine
  }

  return records
}

export function decodeFullViaStreaming(
  lines: string[],
  spansPerLine: LineSpans[],
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeatures: Feature[],
  segmentFeatures: Feature[],
  opts?: DecodeNextOpts
) {
  const recs = decodeRecordsStreaming(lines, spansPerLine, weights, schema, boundaryFeatures, segmentFeatures, { ...(opts ?? {}), lookaheadLines: lines.length })
  return recs[0]?.pred ?? []
}
