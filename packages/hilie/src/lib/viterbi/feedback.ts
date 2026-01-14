import type {
  BoundaryState,
  EnumerateOptions,
  Feature,
  FieldLabel,
  FieldSchema,
  Feedback,
  LineSpans,
  EntityType,
  RecordSpan
} from '../types.js';
import { normalizeFeedback } from '../feedbackUtils.js';
import { decodeJointSequence } from './core.js';
import { entitiesFromJointSequence } from './entities.js';
import type { FeatureCandidate } from '../features.js'
import { dynamicCandidatesToFeatures } from '../features.js'

export function buildFeedbackContext(
  lines: string[],
  spansPerLine: LineSpans[],
  feedback: Feedback
) {
  const normalizedFeedback = normalizeFeedback(feedback, lines);
  const feedbackEntities = normalizedFeedback.entities;
  const recordAssertions = normalizedFeedback.records;
  const feedbackEntitiesExplicit = normalizedFeedback.entities;

  const spansCopy: LineSpans[] = spansPerLine.map(s => ({
    lineIndex: s.lineIndex,
    spans: s.spans.map(sp => ({ start: sp.start, end: sp.end }))
  }));

  function ensureLine(li: number) {
    if (li < 0 || li >= spansCopy.length) return false;
    spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] };
    return true;
  }

  function findSpanIndex(lineIdx: number, start?: number, end?: number) {
    const s = spansCopy[lineIdx];
    if (!s) return -1;
    if (start === undefined || end === undefined) return -1;
    return s.spans.findIndex(x => x.start === start && x.end === end);
  }

  function spanRangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return !(aEnd <= bStart || aStart >= bEnd);
  }

  const labelMap: Record<string, FieldLabel> = {};

  for (const ent of feedbackEntities ?? []) {
    const entStartLine = ent.startLine ?? null;
    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? entStartLine;
      if (li === null || li === undefined) continue;
      if (!ensureLine(li)) continue;

      const action = f.action ?? 'add';
      if (action === 'remove') {
        const idx = findSpanIndex(li, f.start, f.end);
        if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1);
        continue;
      }

      if (f.start !== undefined && f.end !== undefined) {
        const line = spansCopy[li] ?? { lineIndex: li, spans: [] };
        line.spans = line.spans.filter(sp => {
          if (sp.start === f.start && sp.end === f.end) return true;
          return !spanRangesOverlap(sp.start, sp.end, f.start!, f.end!);
        });
        spansCopy[li] = line;
      }

      const idx = findSpanIndex(li, f.start, f.end);
      if (idx < 0 && f.start !== undefined && f.end !== undefined) {
        spansCopy[li]!.spans.push({ start: f.start, end: f.end });
        spansCopy[li]!.spans.sort((a, b) => a.start - b.start);
      }

      if (f.fieldType && f.start !== undefined && f.end !== undefined) {
        labelMap[`${li}:${f.start}-${f.end}`] = f.fieldType;
      }
    }
  }

  const forcedLabelsByLine: Record<number, Record<string, FieldLabel>> = {};
  for (const [key, lab] of Object.entries(labelMap)) {
    const [lineStr, range] = key.split(':');
    if (!range) continue;
    const lineIdx = Number(lineStr);
    if (Number.isNaN(lineIdx)) continue;
    const map = forcedLabelsByLine[lineIdx] ?? (forcedLabelsByLine[lineIdx] = {});
    map[range] = lab;
  }

  const forcedBoundariesByLine: Record<number, BoundaryState> = {};
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined) continue;
    if (r.startLine < 0 || r.startLine >= spansCopy.length) continue;
    forcedBoundariesByLine[r.startLine] = 'B';
    const lastLine = (r.endLine !== undefined && r.endLine >= r.startLine) ? r.endLine : (spansCopy.length - 1);
    const boundedLast = Math.min(lastLine, spansCopy.length - 1);
    for (let li = r.startLine + 1; li <= boundedLast; li++) forcedBoundariesByLine[li] = 'C';
  }
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined || r.endLine === undefined) continue;
    if (r.endLine < r.startLine) continue;
    const nextLine = r.endLine + 1;
    if (nextLine >= 0 && nextLine < spansCopy.length) {
      forcedBoundariesByLine[nextLine] = 'B';
    }
  }

  const entityTypeMap: Record<number, EntityType> = {}; 

  // Helper: map file offsets to lines
  const lineStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) lineStarts.push(0)
    else {
      const prev = lines[i - 1] ?? ''
      const prevStart = lineStarts[i - 1] ?? 0
      lineStarts.push(prevStart + prev.length + 1)
    }
  }
  const offsetToLine = (off: number) => {
    if (lineStarts.length === 0) return 0
    const first = lineStarts[0]!
    if (off < first) return 0
    const lastIdx = lineStarts.length - 1
    const last = lineStarts[lastIdx]!
    if (off >= last) return lastIdx
    let lo = 0, hi = lastIdx
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2)
      const val = lineStarts[mid]!
      if (val <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  for (const ent of feedbackEntitiesExplicit ?? []) {
    if (ent.entityType === undefined) continue;

    if (ent.fileStart !== undefined && ent.fileEnd !== undefined) {
      const fs = ent.fileStart
      const fe = ent.fileEnd
      const startLine = offsetToLine(fs)
      const endLine = offsetToLine(Math.max(0, fe - 1))
      const boundedEnd = Math.min(endLine, spansCopy.length - 1)
      
      // Calculate line-relative positions for the boundaries
      const startLineOffset = lineStarts[startLine] ?? 0
      const startInLine = fs - startLineOffset
      
      
      // Ensure the exact boundary positions exist as spans
      if (ensureLine(startLine)) {
        const line = spansCopy[startLine]!
        // Check if a span exists at this exact start position
        let hasStartSpan = false
        for (const sp of line.spans) {
          if (sp.start === startInLine) {
            hasStartSpan = true
            break
          }
        }
        // If not, create a minimal span at this position
        if (!hasStartSpan && startInLine >= 0) {
          const lineText = lines[startLine] ?? ''
          // Find a reasonable end for this span (next delimiter or end of line)
          let spanEnd = Math.min(startInLine + 1, lineText.length)
          for (let i = startInLine + 1; i < lineText.length; i++) {
            const ch = lineText[i]
            if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\n') {
              spanEnd = i
              break
            }
          }
          line.spans.push({ start: startInLine, end: spanEnd })
          line.spans.sort((a, b) => a.start - b.start)
        }
      }
      
      for (let li = startLine; li <= boundedEnd; li++) {
        entityTypeMap[li] = ent.entityType as EntityType
      }

      // If this sub-entity is not inside an explicit record assertion, create
      // implicit record boundaries so the sub-entity can be rendered as its
      // own record (or part of one) even if no record assertion was provided.
      // This ensures sub-entity-only feedback still results in a visible record
      // that contains the asserted sub-entity.
      const containedInRecord = recordAssertions && recordAssertions.some(r => r.startLine !== undefined && r.startLine <= startLine && r.endLine !== undefined && r.endLine >= endLine)
      if (!containedInRecord) {
        forcedBoundariesByLine[startLine] = 'B'
        for (let li = startLine + 1; li <= boundedEnd; li++) forcedBoundariesByLine[li] = 'C'
      }
    } else if (ent.startLine !== undefined) {
      const startLine = ent.startLine
      const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine;
      const boundedEnd = Math.min(endLine, spansCopy.length - 1);
      for (let li = startLine; li <= boundedEnd; li++) {
        entityTypeMap[li] = ent.entityType as EntityType;
      }

      const containedInRecord = recordAssertions && recordAssertions.some(r => r.startLine !== undefined && r.startLine <= startLine && r.endLine !== undefined && r.endLine >= endLine)
      if (!containedInRecord) {
        forcedBoundariesByLine[startLine] = 'B'
        for (let li = startLine + 1; li <= boundedEnd; li++) forcedBoundariesByLine[li] = 'C'
      }
    }
  }

  // Build allowed intervals per-line from file-anchored assertions (sub-entities,
  // records, and explicit field assertions). These intervals are used to
  // filter candidate spans so that decoding won't consider spans that
  // partially overlap asserted intervals (partial overlaps are conflicts).
  const allowedIntervals: Record<number, Array<{ start: number; end: number }>> = {};

  // Entity assertions first
  for (const fb of feedbackEntitiesExplicit ?? []) {
    if (fb.fileStart === undefined || fb.fileEnd === undefined) continue;
    const fs = fb.fileStart;
    const fe = fb.fileEnd;
    const startLine = offsetToLine(fs);
    const endLine = offsetToLine(Math.max(0, fe - 1));

    for (let li = startLine; li <= Math.min(endLine, spansCopy.length - 1); li++) {
      const lineStartOffset = lineStarts[li] ?? 0;
      const lineText = lines[li] ?? '';
      const liStart = li === startLine ? Math.max(0, fs - lineStartOffset) : 0;
      const liEnd = li === endLine ? Math.min(lineText.length, fe - lineStartOffset) : lineText.length;
      if (liStart >= liEnd) continue;
      const arr = allowedIntervals[li] ?? (allowedIntervals[li] = []);
      arr.push({ start: liStart, end: liEnd });
    }
  }

  // Record assertions: treat the full lines in the record as allowed intervals
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined || r.endLine === undefined) continue;
    const startLine = Math.max(0, Math.min(r.startLine, spansCopy.length - 1));
    const endLine = Math.max(startLine, Math.min(r.endLine, spansCopy.length - 1));
    for (let li = startLine; li <= endLine; li++) {
      const lineText = lines[li] ?? '';
      const liStart = 0;
      const liEnd = lineText.length;
      const arr = allowedIntervals[li] ?? (allowedIntervals[li] = []);
      arr.push({ start: liStart, end: liEnd });
    }
  }

  // Field assertions: ensure exact field intervals are added so the exact
  // asserted spans are considered allowed and protect them from being
  // removed by partial-overlap filtering.
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      if (f.start === undefined || f.end === undefined || f.lineIndex === undefined) continue;
      const li = f.lineIndex;
      if (li < 0 || li >= spansCopy.length) continue;
      const arr = allowedIntervals[li] ?? (allowedIntervals[li] = []);
      arr.push({ start: f.start, end: f.end });
    }
  }

  // If any allowed intervals were defined, filter spans on those lines to
  // remove spans that *partially* overlap an asserted sub-entity interval.
  // Spans that are fully contained in an asserted interval are kept; spans
  // that do not intersect any asserted interval are also kept (they don't
  // conflict). Only spans with a partial overlap are removed.
  if (Object.keys(allowedIntervals).length > 0) {
    for (const [liStr, intervals] of Object.entries(allowedIntervals)) {
      const li = Number(liStr);
      const line = spansCopy[li];
      if (!line) continue;
      // Normalize intervals by sorting
      intervals.sort((a, b) => a.start - b.start);
      line.spans = line.spans.filter(sp => {
        // If the span doesn't intersect any asserted interval, it's safe
        const intersectsAny = intervals.some(iv => !(sp.end <= iv.start || sp.start >= iv.end));
        if (!intersectsAny) return true;
        // If it intersects, require it to be *fully contained* within one of them
        return intervals.some(iv => sp.start >= iv.start && sp.end <= iv.end);
      });
    }
  }

  // Enforce that exact asserted field spans are the canonical candidate for
  // the line: remove any other candidate spans that overlap an asserted
  // field interval so the decoder won't produce overlapping field spans.
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      if (f.action === 'remove') continue;
      if (f.start === undefined || f.end === undefined || f.lineIndex === undefined) continue;
      const li = f.lineIndex;
      if (li < 0 || li >= spansCopy.length) continue;
      const line = spansCopy[li]!;
      line.spans = line.spans.filter(sp => (sp.start === f.start && sp.end === f.end) || sp.end <= f.start || sp.start >= f.end);
    }
  }

  // Additional sanitization: for asserted sub-entity intervals (allowedIntervals),
  // replace candidate spans inside each interval with a coverage-style non-overlapping
  // segmentation derived from the existing candidates so decoding cannot produce
  // overlapping FieldSpans inside an asserted sub-entity.
  for (const [liStr, intervals] of Object.entries(allowedIntervals)) {
    const li = Number(liStr);
    const line = spansCopy[li];
    if (!line) continue;
    const lineText = lines[li] ?? '';

    for (const iv of intervals) {
      const ivStart = Math.max(0, Math.min(iv.start, lineText.length));
      const ivEnd = Math.max(0, Math.min(iv.end, lineText.length));

      // collect spans that intersect the interval and clamp them to the interval
      let inside = line.spans
        .filter(sp => !(sp.end <= ivStart || sp.start >= ivEnd))
        .map(sp => ({ start: Math.max(sp.start, ivStart), end: Math.min(sp.end, ivEnd) }))
      inside.sort((a, b) => a.start - b.start);

      // If no candidates inside, create a single span covering the allowed interval
      if (inside.length === 0) inside = [{ start: ivStart, end: ivEnd }];

      // Fill gaps to ensure coverage of the allowed interval
      const filled: Array<{ start: number; end: number }> = [];
      let pos = ivStart;
      for (const sp of inside) {
        if (pos < sp.start) filled.push({ start: pos, end: sp.start });
        filled.push(sp);
        pos = sp.end;
      }
      if (pos < ivEnd) filled.push({ start: pos, end: ivEnd });

      // Trim leading/trailing whitespace within each filled span and add whitespace
      // sub-spans where necessary to preserve exact coverage (mirrors coverageSpanGenerator logic)
      const trimmed: Array<{ start: number; end: number }> = [];
      for (const sp of filled) {
        const txt = lineText.slice(sp.start, sp.end);
        const isAllWhitespace = /^\s*$/.test(txt);
        if (isAllWhitespace) {
          trimmed.push({ start: sp.start, end: sp.end });
        } else {
          const leadingMatch = txt.match(/^\s*/);
          const trailingMatch = txt.match(/\s*$/);
          const leadingLen = leadingMatch ? leadingMatch[0].length : 0;
          const trailingLen = trailingMatch ? trailingMatch[0].length : 0;
          const tstart = sp.start + leadingLen;
          const tend = sp.end - trailingLen;
          if (tstart < tend) {
            trimmed.push({ start: tstart, end: tend });
            if (leadingLen > 0) trimmed.push({ start: sp.start, end: tstart });
            if (trailingLen > 0) trimmed.push({ start: tend, end: sp.end });
          } else {
            trimmed.push(sp);
          }
        }
      }

      trimmed.sort((a, b) => a.start - b.start);

      // Merge adjacent whitespace-only spans
      const merged: Array<{ start: number; end: number }> = [];
      for (const sp of trimmed) {
        const txt = lineText.slice(sp.start, sp.end);
        const isWs = /^\s*$/.test(txt);
        if (isWs && merged.length > 0) {
          const last = merged[merged.length - 1]!;
          const lastTxt = lineText.slice(last.start, last.end);
          const lastIsWs = /^\s*$/.test(lastTxt);
          if (lastIsWs) {
            last.end = sp.end;
            continue;
          }
        }
        merged.push({ start: sp.start, end: sp.end });
      }

      // Final normalization: ensure the merged spans are non-overlapping and
      // coalesced deterministically (merge any overlapping/adjacent spans).
      const normalized: Array<{ start: number; end: number }> = [];
      for (const sp of merged.sort((a, b) => a.start - b.start)) {
        if (normalized.length === 0) {
          normalized.push({ start: sp.start, end: sp.end });
          continue;
        }
        const last = normalized[normalized.length - 1]!;
        if (sp.start <= last.end) {
          // overlap/adjacent -> extend last
          last.end = Math.max(last.end, sp.end);
        } else {
          normalized.push({ start: sp.start, end: sp.end });
        }
      }

      // Replace spans inside the interval with the normalized coverage segmentation
      const outside = line.spans.filter(sp => sp.end <= ivStart || sp.start >= ivEnd);
      line.spans = [...outside, ...normalized].sort((a, b) => a.start - b.start);
    }
  }

  let maxAssertedSpanIdx = -1;
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? ent.startLine;
      if (li === undefined || li === null) continue;
      if (li < 0 || li >= spansCopy.length) continue;
      const idx = spansCopy[li]?.spans.findIndex(sp => sp.start === f.start && sp.end === f.end) ?? -1;
      if (idx > maxAssertedSpanIdx) maxAssertedSpanIdx = idx;
    }
  }

  return {
    spansCopy,
    forcedLabelsByLine: forcedLabelsByLine,
    forcedBoundariesByLine: forcedBoundariesByLine,
    forcedEntityTypeByLine: entityTypeMap,
    maxAssertedSpanIdx
  };
}

export function decodeJointSequenceWithFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  feedback: Feedback,
  enumerateOpts?: EnumerateOptions,
  dynamicCandidates?: FeatureCandidate[],
  dynamicInitialWeights?: Record<string, number>
): { pred: RecordSpan[]; spansPerLine: LineSpans[] } {
  const fbCtx = buildFeedbackContext(lines, spansPerLine, feedback)
  const spansCopy = fbCtx.spansCopy

  let boundaryFeatures = [...boundaryFeaturesArg]
  let segmentFeatures = [...segmentFeaturesArg]

  if (dynamicCandidates && dynamicCandidates.length) {
    const dyn = dynamicCandidatesToFeatures(dynamicCandidates)
    boundaryFeatures = boundaryFeatures.concat(dyn.boundaryFeatures)
    segmentFeatures = segmentFeatures.concat(dyn.segmentFeatures)
  }

  if (dynamicInitialWeights) {
    for (const [k, v] of Object.entries(dynamicInitialWeights)) {
      const dynKey = `dyn:${k}`
      if (weights[dynKey] === undefined) weights[dynKey] = v
    }
  }

  const finalEnumerateOpts: EnumerateOptions | undefined = (() => {
    const base = enumerateOpts ?? {};
    const safePrefix = (fbCtx.maxAssertedSpanIdx < 0)
      ? base.safePrefix
      : Math.max((base.safePrefix ?? 8), fbCtx.maxAssertedSpanIdx + 1);
    const res = {
      ...base,
      ...(safePrefix !== undefined ? { safePrefix } : {}),
      forcedLabelsByLine: fbCtx.forcedLabelsByLine,
      forcedBoundariesByLine: fbCtx.forcedBoundariesByLine,
      forcedEntityTypeByLine: fbCtx.forcedEntityTypeByLine
    } as EnumerateOptions;
    return res;
  })();

  const pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, finalEnumerateOpts);


  for (let li = 0; li < pred.length; li++) {
    const forcedType = fbCtx.forcedEntityTypeByLine[li];
    if (!forcedType) continue;
    pred[li] = { ...(pred[li] ?? { boundary: 'C', fields: [] }), entityType: forcedType };
  }

  const records = entitiesFromJointSequence(lines, spansCopy, pred, weights, segmentFeatures, schema)

  return { pred: records, spansPerLine: spansCopy };
}
