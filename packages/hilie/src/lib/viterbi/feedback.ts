import type {
  BoundaryState,
  EnumerateOptions,
  Feature,
  FieldLabel,
  FieldSchema,
  Feedback,
  JointSequence,
  LineSpans,
  SubEntityType
} from '../types.js';
import { normalizeFeedback } from '../feedbackUtils.js';
import { decodeJointSequence } from './core.js';

export function decodeJointSequenceWithFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  weights: Record<string, number>,
  schema: FieldSchema,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  feedback: Feedback,
  enumerateOpts?: EnumerateOptions
): { pred: JointSequence; spansPerLine: LineSpans[] } {
  const normalizedFeedback = normalizeFeedback(feedback, lines);
  const feedbackEntities = normalizedFeedback.entities;
  const recordAssertions = normalizedFeedback.records;
  const feedbackSubEntities = normalizedFeedback.subEntities;

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

  const entityTypeMap: Record<number, SubEntityType> = {};

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

  for (const ent of feedbackSubEntities ?? []) {
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
      const endLineOffset = lineStarts[endLine] ?? 0
      const endInLine = (fe - 1) - endLineOffset
      
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
        entityTypeMap[li] = ent.entityType as SubEntityType
      }
    } else if (ent.startLine !== undefined) {
      const startLine = ent.startLine
      const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine;
      const boundedEnd = Math.min(endLine, spansCopy.length - 1);
      for (let li = startLine; li <= boundedEnd; li++) {
        entityTypeMap[li] = ent.entityType as SubEntityType;
      }
    }
  }

  // Build allowed intervals per-line from file-anchored assertions (sub-entities,
  // records, and explicit field assertions). These intervals are used to
  // filter candidate spans so that decoding won't consider spans that
  // partially overlap asserted intervals (partial overlaps are conflicts).
  const allowedIntervals: Record<number, Array<{ start: number; end: number }>> = {};

  // Sub-entity assertions first
  for (const fb of feedbackSubEntities ?? []) {
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
      const lineStartOffset = lineStarts[li] ?? 0;
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

  const finalEnumerateOpts: EnumerateOptions | undefined = (() => {
    const base = enumerateOpts ?? {};
    const safePrefix = (maxAssertedSpanIdx < 0)
      ? base.safePrefix
      : Math.max((base.safePrefix ?? 8), maxAssertedSpanIdx + 1);
    return {
      ...base,
      ...(safePrefix !== undefined ? { safePrefix } : {}),
      forcedLabelsByLine,
      forcedBoundariesByLine,
      forcedEntityTypeByLine: entityTypeMap
    } as EnumerateOptions;
  })();

  const pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, finalEnumerateOpts);

  for (let li = 0; li < pred.length; li++) {
    const forcedType = entityTypeMap[li];
    if (!forcedType) continue;
    pred[li] = { ...(pred[li] ?? { boundary: 'C', fields: [] }), entityType: forcedType };
  }

  return { pred, spansPerLine: spansCopy };
}
