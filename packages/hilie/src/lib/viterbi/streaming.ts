import type { Feature, LineSpans, FieldSchema, EnumerateOptions, Feedback, RecordSpan, BoundaryState } from '../types.js'
import { prepareDecodeCaches, decodeWindowUsingCaches } from './core.js'
import { entitiesFromJointSequence, assembleRecordsFromCandidates } from './entities.js'
import type { FeatureCandidate } from '../features.js'
import { dynamicCandidatesToFeatures } from '../features.js'
import { buildFeedbackContext } from './feedback.js'
import { detectDelimiter, candidateSpanGenerator, coverageSpanGenerator } from '../utils.js'

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
): { pred: RecordSpan[]; spansPerLine: LineSpans[]; startLine: number; endLine: number; confidence: number } {
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
  // prepare caches and decode the window with candidates
  const caches = prepareDecodeCaches(lines, spansToUse, weights, schema, bFeatures, sFeatures, fbEnumOpts)
  const res = decodeWindowUsingCaches(startLine, endExclusive, lines, spansToUse, weights, schema, caches, undefined, undefined)
  const predLocal = res.path
  const spanCandidates = res.spanCandidates ?? []

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

  // If feedback is present, fall back to the legacy entities assembler which prefers
  // feedback-preserved sub-entity offsets and assertions to ensure exact parity.
  let records: RecordSpan[]
  if (opts?.feedback) {
    const jointFull = Array.from({ length: lines.length }, () => ({ boundary: 'C' as BoundaryState, fields: [] as string[] }))
    for (let i = 0; i < predLocal.length; i++) jointFull[startLine + i] = predLocal[i] ?? { boundary: 'C' as BoundaryState, fields: [] }
    records = entitiesFromJointSequence(lines, spansToUse, jointFull as any, weights, sFeatures, schema)
  } else {
    records = assembleRecordsFromCandidates(lines, spansToUse, startLine, predLocal, spanCandidates, weights, sFeatures, schema)
  }

  // Return only the records that start within the window range
  const windowRecords = records.filter(r => r.startLine >= startLine && r.startLine <= endLine)

  return { pred: windowRecords, spansPerLine: windowSpans, startLine, endLine, confidence }
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
  const records: Array<{ pred: RecordSpan[]; spansPerLine: LineSpans[]; startLine: number; endLine: number; confidence: number }> = []

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
    const res = decodeWindowUsingCaches(pos, endExclusive, lines, spansToUse, weights, schema, caches, undefined, carryBeam, (opts?.beam ?? 1))
    const predLocal = res.path
    const spanCandidates = res.spanCandidates ?? []

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

    // Assemble records from candidates and the windowed joint path (or fallback for feedback)
    const windowSpans = spansToUse.slice(pos, endExclusive)
    let recs: RecordSpan[]
    if (opts?.feedback) {
      const jointFull = Array.from({ length: lines.length }, () => ({ boundary: 'C' as BoundaryState, fields: [] as string[] }))
      for (let i = 0; i < predLocal.length; i++) jointFull[pos + i] = predLocal[i] ?? { boundary: 'C' as BoundaryState, fields: [] }
      recs = entitiesFromJointSequence(lines, spansToUse, jointFull as any, weights, segmentFeatures.concat(dynSegment), schema)
    } else {
      recs = assembleRecordsFromCandidates(lines, spansToUse, pos, predLocal, spanCandidates, weights, segmentFeatures.concat(dynSegment), schema)
    }
    const localRecords = recs.filter(r => r.startLine >= pos && r.startLine <= endLine)

    records.push({ pred: localRecords, spansPerLine: windowSpans, startLine: pos, endLine, confidence })

    // set carry beam for next window if enabled
    if (opts?.carryover === false || (opts?.beam ?? 1) <= 1) carryBeam = []
    else carryBeam = res.outgoingBeam ?? []

    if (endLine <= pos) break
    pos = endLine
  }

  return records
}

import { recordsFromLines, linesFromChunks, recordsByIndentation } from '../recordSplitter.js'

export async function decodeRecordsFromAsyncIterable(
  source: AsyncIterable<string>,
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeatures: Feature[],
  segmentFeatures: Feature[],
  opts?: DecodeNextOpts & { knownLabeledTokens?: string[] }
): Promise<RecordSpan[]> {
  // Iterate records as they are produced by indentation-based splitter,
  // decode each record individually (so the decoder operates on short records
  // and feedback can be applied per-record). We accumulate file-relative
  // offsets so returned RecordSpan.fileStart/fileEnd remain consistent with
  // the full stream concatenated using '\n' as line separators.

  const out: RecordSpan[] = []
  let fileOffset = 0

  // linesFromChunks will consume partial chunks and yield clean lines
  const linesIter = linesFromChunks(source)

  for await (const recordLines of recordsByIndentation(linesIter)) {
    // Join lines to compute local size and enable offset translation
    const joined = recordLines.join('\n')
    const localFileStart = fileOffset
    const localFileEnd = localFileStart + joined.length

    // Heuristic: choose span generation approach depending on layout
    // For single-line wide rows, use delimiter-aware candidate spans
    // For multi-line outline shapes, use coverage spans to capture loose fields
    const delimiterRx = detectDelimiter(recordLines)

    // If the record is a single line or has consistent delimiter-based parts, prefer column split
    const isSingleLine = recordLines.length === 1
    const candidateSpans = candidateSpanGenerator(recordLines, { delimiterRegex: delimiterRx })

    // If the delimiter appears to split into many columns for the single line, prefer candidate spans
    // Otherwise, use coverage spans for loose outline structures
    const totalSpans = candidateSpans.reduce((s, l) => s + (l.spans?.length ?? 0), 0)
    const spansToUse = (isSingleLine && totalSpans >= 2) || (!isSingleLine && totalSpans >= (recordLines.length * 1)) ? candidateSpans : coverageSpanGenerator(recordLines)

    // Call the streaming decoder on the short record. We deliberately pass the record
    // lines as a standalone 'document' so that the decoder's internal line indices start at 0.
    const recResults = decodeRecordsStreaming(recordLines, spansToUse, weights, schema, boundaryFeatures, segmentFeatures, opts)

    // decodeRecordsStreaming returns windowed outputs; flatten the RecordSpan results
    for (const win of recResults) {
      for (const r of win.pred) {
        // Shift file-relative offsets to account for earlier records in stream
        const shift = (deltaRec: RecordSpan) => {
          deltaRec.fileStart = (deltaRec.fileStart ?? 0) + localFileStart
          deltaRec.fileEnd = (deltaRec.fileEnd ?? 0) + localFileStart
          if (deltaRec.subEntities) {
            for (const se of deltaRec.subEntities) {
              se.fileStart = (se.fileStart ?? 0) + localFileStart
              se.fileEnd = (se.fileEnd ?? 0) + localFileStart
              for (const f of se.fields) {
                f.fileStart = (f.fileStart ?? 0) + localFileStart
                f.fileEnd = (f.fileEnd ?? 0) + localFileStart
                if (typeof f.entityStart === 'number') f.entityStart += localFileStart
                if (typeof f.entityEnd === 'number') f.entityEnd += localFileStart
              }
            }
          }
        }

        // Adjust top-level start/end lines to reflect the record's position in the full stream.
        const recCopy: RecordSpan = JSON.parse(JSON.stringify(r))
        recCopy.startLine = recCopy.startLine + 0 // per-record startLine is relative to recordLines
        recCopy.endLine = recCopy.endLine + 0
        shift(recCopy)
        out.push(recCopy)
      }
    }

    // Advance fileOffset: assume original stream used '\n' as separator between lines
    // add +1 for the newline that followed this record when concatenated
    fileOffset = localFileEnd + 1
  }

  return out
}

export function decodeFullViaStreaming(
  lines: string[],
  _spansPerLine: LineSpans[],
  _weights: Record<string, number>,
  _schema: FieldSchema,
  _boundaryFeatures: Feature[],
  _segmentFeatures: Feature[],
  _opts?: DecodeNextOpts
) {
  // New simplified splitter: ignore Viterbi for record segmentation; create
  // lightweight RecordSpan[] objects using indentation-based splitting.
  return recordsFromLines(lines)
}
