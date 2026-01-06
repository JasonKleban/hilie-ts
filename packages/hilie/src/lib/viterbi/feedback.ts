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
      forcedBoundariesByLine
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
