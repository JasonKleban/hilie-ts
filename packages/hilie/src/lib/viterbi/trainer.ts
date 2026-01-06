import type {
  BoundaryState,
  EnumerateOptions,
  Feature,
  FeatureContext,
  FieldLabel,
  FieldSchema,
  Feedback,
  JointSequence,
  JointState,
  LineSpans,
  SubEntityType
} from '../types.js';
import { normalizeFeedback } from '../feedbackUtils.js';
import { decodeJointSequence, extractJointFeatureVector } from './core.js';

export function updateWeightsFromUserFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  feedback: Feedback,
  weights: Record<string, number>,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  learningRate = 1.0,
  enumerateOpts?: EnumerateOptions,
  stabilizationFactor = 0.15
): { updated: Record<string, number>; pred: JointSequence; spansPerLine?: LineSpans[] } {
  const normalizedFeedback = normalizeFeedback(feedback, lines);
  const feedbackEntities = normalizedFeedback.entities;
  const feedbackSubEntities = normalizedFeedback.subEntities;
  const recordAssertions = normalizedFeedback.records;
  const subEntityAssertions = normalizedFeedback.subEntities;

  const spansCopy: LineSpans[] = spansPerLine.map(s => ({
    lineIndex: s.lineIndex,
    spans: s.spans.map(sp => ({ start: sp.start, end: sp.end }))
  }));

  const feedbackTouchedSpans = new Set<string>();

  let confs: number[] = [];

  function findSpanIndex(lineIdx: number, start?: number, end?: number) {
    const s = spansCopy[lineIdx];
    if (!s) return -1;
    if (start === undefined || end === undefined) return -1;
    return s.spans.findIndex(x => x.start === start && x.end === end);
  }

  function spanRangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return !(aEnd <= bStart || aStart >= bEnd);
  }

  for (const ent of feedbackEntities ?? []) {
    const entStartLine = ent.startLine ?? null;

    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? entStartLine;
      if (li === null || li === undefined) continue;

      const spanKey = `${li}:${f.start}-${f.end}`;
      feedbackTouchedSpans.add(spanKey);

      const action = f.action ?? 'add';
      if (action === 'remove') {
        const idx = findSpanIndex(li, f.start, f.end);
        if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1);
        if (f.confidence !== undefined) confs.push(f.confidence);
      } else {
        if (f.start !== undefined && f.end !== undefined) {
          const line = spansCopy[li] ?? { lineIndex: li, spans: [] };
          line.spans = line.spans.filter(sp => {
            if (sp.start === f.start && sp.end === f.end) return true;
            return !spanRangesOverlap(sp.start, sp.end, f.start!, f.end!);
          });
          spansCopy[li] = line;
        }

        const idx = findSpanIndex(li, f.start, f.end);
        if (idx < 0) {
          spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] };
          spansCopy[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 });
          spansCopy[li]!.spans.sort((a, b) => a.start - b.start);
        }
        if (f.confidence !== undefined) confs.push(f.confidence);
      }
    }
  }

  const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 1.0;

  let maxAssertedSpanIdx = -1;
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      const li = f.lineIndex ?? ent.startLine;
      if (li === undefined || li === null) continue;
      const idx = spansCopy[li]?.spans.findIndex(sp => sp.start === f.start && sp.end === f.end) ?? -1;
      if (idx > maxAssertedSpanIdx) maxAssertedSpanIdx = idx;
    }
  }

  const effEnumerateOpts: EnumerateOptions | undefined = (() => {
    if (maxAssertedSpanIdx < 0) return enumerateOpts;
    const safePrefix = Math.max((enumerateOpts?.safePrefix ?? 8), maxAssertedSpanIdx + 1);
    return { ...enumerateOpts, safePrefix };
  })();

  const gold: JointState[] = [];

  const labelMap: Record<string, FieldLabel> = {};
  for (const ent of feedbackEntities ?? []) {
    for (const f of ent.fields ?? []) {
      if (f.action === 'remove') continue;
      if (f.fieldType) {
        const li = f.lineIndex ?? ent.startLine;
        if (li === undefined) continue;
        const key = `${li}:${f.start}-${f.end}`;
        labelMap[key] = f.fieldType;
      }
    }
  }

  const entityTypeMap: Record<number, SubEntityType> = {};

  // If sub-entity assertions include file offsets, map them to overlapping lines
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
      const startLine = offsetToLine(ent.fileStart)
      const endLine = offsetToLine(Math.max(0, ent.fileEnd - 1))
      const boundedEnd = Math.min(endLine, spansCopy.length - 1)
      for (let li = startLine; li <= boundedEnd; li++) entityTypeMap[li] = ent.entityType as SubEntityType
    } else if (ent.startLine !== undefined) {
      const startLine = ent.startLine
      const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine
      const boundedEnd = Math.min(endLine, spansCopy.length - 1)
      for (let li = startLine; li <= boundedEnd; li++) entityTypeMap[li] = ent.entityType as SubEntityType
    }
  }

  const boundarySet = new Set<number>();
  for (const r of recordAssertions ?? []) {
    if (r.startLine !== undefined) boundarySet.add(r.startLine);
  }

  const forcedBoundariesByLine: Record<number, BoundaryState> = {};
  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined) continue;
    forcedBoundariesByLine[r.startLine] = 'B';
    const lastLine = (r.endLine !== undefined && r.endLine >= r.startLine) ? r.endLine : (spansCopy.length - 1);
    for (let li = r.startLine + 1; li <= lastLine; li++) {
      forcedBoundariesByLine[li] = 'C';
    }
  }

  for (const r of recordAssertions ?? []) {
    if (r.startLine === undefined || r.endLine === undefined) continue;
    if (r.endLine < r.startLine) continue;
    const nextLine = r.endLine + 1;
    if (nextLine >= 0 && nextLine < spansCopy.length) {
      forcedBoundariesByLine[nextLine] = 'B';
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

  const finalEnumerateOpts = { ...effEnumerateOpts, forcedLabelsByLine, forcedBoundariesByLine } as EnumerateOptions;
  const enumerateOptsWithForces = finalEnumerateOpts;

  for (let li = 0; li < spansCopy.length; li++) {
    const lineSp = spansCopy[li] ?? { lineIndex: li, spans: [] };
    const fields: FieldLabel[] = [];
    for (const sp of lineSp.spans) {
      const key = `${li}:${sp.start}-${sp.end}`;
      if (labelMap[key]) fields.push(labelMap[key]!);
      else {
        const predLabel = (jointSeq[li] && jointSeq[li]!.fields && jointSeq[li]!.fields[0])
          ? (function findMatching() {
              const origIdx = (spansPerLine[li]?.spans ?? []).findIndex(x => x.start === sp.start && x.end === sp.end);
              if (origIdx >= 0) return jointSeq[li]!.fields[origIdx] ?? schema.noiseLabel;
              return schema.noiseLabel as FieldLabel;
            })()
          : (schema.noiseLabel as FieldLabel);
        fields.push(predLabel);
      }
    }

    const boundary: BoundaryState = (forcedBoundariesByLine[li] as BoundaryState) ??
      (boundarySet.has(li) ? 'B' : (jointSeq[li] ? jointSeq[li]!.boundary : 'C'));

    const entityType = entityTypeMap[li] ?? (jointSeq[li] ? jointSeq[li]!.entityType : undefined);

    if (entityType !== undefined) gold.push({ boundary, fields, entityType });
    else gold.push({ boundary, fields });
  }

  const predUnforced = decodeJointSequence(
    lines,
    spansCopy,
    weights,
    schema,
    boundaryFeaturesArg,
    segmentFeaturesArg,
    effEnumerateOpts
  );

  const vGold = extractJointFeatureVector(lines, spansCopy, gold, boundaryFeaturesArg, segmentFeaturesArg, schema);
  const vPred = extractJointFeatureVector(lines, spansCopy, predUnforced, boundaryFeaturesArg, segmentFeaturesArg, schema);

  let pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, finalEnumerateOpts);

  const assertedFields = ([] as any[]).concat((feedbackEntities ?? []).flatMap((e: any) => e.fields ?? []));

  const labelFeatureMap: Record<string, string> = {
    Phone: 'segment.is_phone',
    Email: 'segment.is_email',
    ExtID: 'segment.is_extid',
    Name: 'segment.is_name',
    PreferredName: 'segment.is_preferred_name',
    Birthdate: 'segment.is_birthdate'
  };

  const keys = new Set<string>([...Object.keys(vGold), ...Object.keys(vPred)]);
  for (const k of keys) {
    const delta = (vGold[k] ?? 0) - (vPred[k] ?? 0);
    weights[k] = (weights[k] ?? 0) + learningRate * meanConf * delta;
  }

  for (const f of assertedFields.filter((x: any) => x.action === 'remove')) {
    const li = f.lineIndex ?? 0;
    const origSpans = spansPerLine;
    const si = (origSpans[li]?.spans ?? []).findIndex((x: any) => x.start === f.start && x.end === f.end);
    if (si >= 0) {
      const origSpan = origSpans[li]!.spans[si]!;
      let useStart = origSpan.start;
      let useEnd = origSpan.end;
      const lineText = lines[li] ?? '';
      const candidateText = lineText.slice(useStart, useEnd);

      if (f.fieldType === 'Phone') {
        const m = candidateText.match(/[0-9()+\-\.\s]{7,}/);
        if (m) {
          const off = candidateText.indexOf(m[0]);
          useStart = useStart + off;
          useEnd = useStart + m[0].length;
        }
      } else if (f.fieldType === 'Email') {
        const m = candidateText.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
        if (m) {
          const off = candidateText.indexOf(m[0]);
          useStart = useStart + off;
          useEnd = useStart + m[0].length;
        }
      } else if (f.fieldType === 'ExtID') {
        const toks = candidateText.split(/\s+/).filter(Boolean);
        let acc = 0;
        for (const tok of toks) {
          const idx = candidateText.indexOf(tok, acc);
          acc = idx + tok.length;
          if (tok && tok.length <= 20 && /^[-_#A-Za-z0-9]+$/.test(tok) && !/^\d{10,11}$/.test(tok)) {
            const off = candidateText.indexOf(tok);
            useStart = useStart + off;
            useEnd = useStart + tok.length;
            break;
          }
        }
      }

      const spansSingle: LineSpans[] = origSpans.map((s: LineSpans | undefined, idx: number) => {
        if (idx !== li) return { lineIndex: idx, spans: [] } as LineSpans;
        return { lineIndex: li, spans: [{ start: useStart, end: useEnd }] } as LineSpans;
      });

      const jointPred: JointState[] = spansSingle.map((s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [f.fieldType as FieldLabel] } as JointState;
      });
      const jointGold: JointState[] = spansSingle.map((s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [schema.noiseLabel] } as JointState;
      });

      const vPredSpan = extractJointFeatureVector(lines, spansSingle, jointPred, boundaryFeaturesArg, segmentFeaturesArg, schema);
      const vGoldSpan = extractJointFeatureVector(lines, spansSingle, jointGold, boundaryFeaturesArg, segmentFeaturesArg, schema);

      const keys = new Set<string>([...Object.keys(vPredSpan), ...Object.keys(vGoldSpan)]);
      for (const k of keys) {
        const delta = (vGoldSpan[k] ?? 0) - (vPredSpan[k] ?? 0);
        weights[k] = (weights[k] ?? 0) + learningRate * (f.confidence ?? 1.0) * delta;
      }
    }
  }

  function tryNudge(featureId: string, targetLabel: FieldLabel) {
    const f = assertedFields.find(x => x.fieldType === targetLabel);
    if (!f) return;
    const li = f.lineIndex ?? 0;
    const si = (spansCopy[li]?.spans ?? []).findIndex(x => x.start === f.start && x.end === f.end);
    if (si < 0) return;

    const currLabel = predUnforced[li] && predUnforced[li]!.fields && predUnforced[li]!.fields[si]
      ? predUnforced[li]!.fields[si]
      : schema.noiseLabel;
    if (currLabel === targetLabel) return;

    function scoreWithWeights(wts: Record<string, number>, lab: FieldLabel) {
      const sctx: FeatureContext = {
        lineIndex: li,
        lines,
        candidateSpan: { lineIndex: li, start: spansCopy[li]!.spans[si]!.start, end: spansCopy[li]!.spans[si]!.end }
      };
      let score = 0;
      for (const ftr of segmentFeaturesArg) {
        const v = ftr.apply(sctx);
        const w = wts[ftr.id] ?? 0;
        if (ftr.id === 'segment.is_phone') {
          score += (lab === 'Phone') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_email') {
          score += (lab === 'Email') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_extid') {
          const txt = lines[li]?.slice(sctx.candidateSpan!.start, sctx.candidateSpan!.end) ?? '';
          const exact = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));
          if (exact) {
            score += (lab === 'ExtID') ? -0.8 * w * v : (lab === 'Phone' ? 0.7 * w * v : -0.3 * w * v);
          } else {
            score += (lab === 'ExtID') ? w * v : -0.5 * w * v;
          }
        } else if (ftr.id === 'segment.is_name') {
          score += (lab === 'Name') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_preferred_name') {
          score += (lab === 'PreferredName') ? w * v : -0.5 * w * v;
        } else if (ftr.id === 'segment.is_birthdate') {
          score += (lab === 'Birthdate') ? w * v : -0.5 * w * v;
        } else {
          score += w * v;
        }
      }
      return score;
    }

    const scoreTarget = scoreWithWeights(weights, targetLabel);
    const scoreCurr = scoreWithWeights(weights, currLabel as FieldLabel);

    if (scoreTarget > scoreCurr) {
      if (currLabel === targetLabel) return;
      const beforeSmall = weights[featureId] ?? 0;
      const smallNud = 0.5 * learningRate * meanConf;
      weights[featureId] = beforeSmall + smallNud;
    }

    const base = weights[featureId] ?? 0;
    weights[featureId] = base + 1;
    const scoreTargetPlus = scoreWithWeights(weights, targetLabel);
    const scoreCurrPlus = scoreWithWeights(weights, currLabel as FieldLabel);
    weights[featureId] = base;

    const slope = (scoreTargetPlus - scoreTarget) - (scoreCurrPlus - scoreCurr);

    if (slope > 1e-9) {
      const needed = (scoreCurr - scoreTarget + 1e-6) / slope;
      const nud = Math.max(needed, 0.5) * learningRate * meanConf;
      const before = weights[featureId] ?? 0;
      weights[featureId] = before + nud;
    } else {
      let bestFeat: string | null = null;
      let bestSlope = 0;
      for (const ftr of segmentFeaturesArg) {
        const baseF = weights[ftr.id] ?? 0;
        weights[ftr.id] = baseF + 1;
        const sTargetPlus = scoreWithWeights(weights, targetLabel);
        const sCurrPlus = scoreWithWeights(weights, currLabel as FieldLabel);
        weights[ftr.id] = baseF;
        const s = (sTargetPlus - scoreTarget) - (sCurrPlus - scoreCurr);
        if (s > bestSlope) {
          bestSlope = s;
          bestFeat = ftr.id;
        }
      }

      if (bestFeat && bestSlope > 1e-9) {
        const needed = (scoreCurr - scoreTarget + 1e-6) / bestSlope;
        const nud = Math.max(needed, 0.5) * learningRate * meanConf;
        const before = weights[bestFeat] ?? 0;
        weights[bestFeat] = before + nud;
      } else {
        const before = weights[featureId] ?? 0;
        weights[featureId] = before + learningRate * meanConf * 8.0;
      }
    }

    const newPred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, enumerateOptsWithForces);
    for (let i = 0; i < newPred.length; i++) if (newPred[i]) pred[i] = newPred[i]!;
  }

  function enforceAssertedPredictions(): JointSequence {
    let predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, enumerateOptsWithForces);

    for (let iter = 0; iter < 2; iter++) {
      let changed = false;
      pred = predLocal;

      for (const f of assertedFields.filter((x: any) => x.action !== 'remove')) {
        const defaultStart = (recordAssertions && recordAssertions[0] && recordAssertions[0]!.startLine) ?? 0;
        const li = f.lineIndex ?? defaultStart;
        const spansForLine = spansCopy[li]?.spans ?? [];
        const idx = spansForLine.findIndex(s => s.start === f.start && s.end === f.end);
        if (idx < 0) continue;
        const desired = f.fieldType as FieldLabel | undefined;
        if (!desired) continue;

        const current = predLocal[li]?.fields?.[idx];
        if (current === desired) continue;

        const featId = labelFeatureMap[desired];
        if (featId) {
          tryNudge(featId, desired);
          changed = true;
        }
      }

      if (!changed) break;
      predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, effEnumerateOpts);
    }

    return predLocal;
  }

  tryNudge('segment.is_phone', 'Phone');
  tryNudge('segment.is_email', 'Email');
  tryNudge('segment.is_extid', 'ExtID');

  if (stabilizationFactor > 0) {
    for (let li = 0; li < spansPerLine.length; li++) {
      const origSpans = spansPerLine[li]?.spans ?? [];
      const origState = jointSeq[li];
      const newState = pred[li];

      if (!origState || !newState) continue;

      for (let si = 0; si < origSpans.length; si++) {
        const span = origSpans[si];
        if (!span) continue;

        const spanKey = `${li}:${span.start}-${span.end}`;
        if (feedbackTouchedSpans.has(spanKey)) continue;

        const origLabel = origState.fields?.[si];

        const newSpanIdx = pred[li]?.fields?.findIndex((_, idx) => {
          const newSpan = spansPerLine[li]?.spans[idx];
          return newSpan && newSpan.start === span.start && newSpan.end === span.end;
        }) ?? -1;

        const newLabel = newSpanIdx >= 0 ? newState.fields?.[newSpanIdx] : undefined;

        if (!origLabel || !newLabel || origLabel !== newLabel || origLabel === schema.noiseLabel) continue;

        const sctx: FeatureContext = {
          lineIndex: li,
          lines,
          candidateSpan: { lineIndex: li, start: span.start, end: span.end }
        };

        for (const f of segmentFeaturesArg) {
          const v = f.apply(sctx);
          if (v === 0) continue;

          const txt = lines[li]?.slice(span.start, span.end) ?? '';
          const exact10or11 = /^\d{10,11}$/.test(txt.replace(/\D/g, ''));

          let contrib = v;
          if (f.id === 'segment.is_phone') {
            contrib = origLabel === 'Phone' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_email') {
            contrib = origLabel === 'Email' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_extid') {
            if (exact10or11) {
              contrib = (origLabel === 'ExtID') ? -0.8 * v : (origLabel === 'Phone' ? 0.7 * v : -0.3 * v);
            } else {
              contrib = origLabel === 'ExtID' ? v : -0.5 * v;
            }
          } else if (f.id === 'segment.is_name') {
            contrib = origLabel === 'Name' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_preferred_name') {
            contrib = origLabel === 'PreferredName' ? v : -0.5 * v;
          } else if (f.id === 'segment.is_birthdate') {
            contrib = origLabel === 'Birthdate' ? v : -0.5 * v;
          }

          if (contrib > 0) {
            weights[f.id] = (weights[f.id] ?? 0) + learningRate * stabilizationFactor * contrib;
          }
        }
      }
    }
  }

  const BOUNDARY_NUDGE_SCALE = 0.5;
  const MAX_BOUNDARY_STEP = 0.5;
  const ITER_BOUNDARY = 5;

  for (let iter = 0; iter < ITER_BOUNDARY; iter++) {
    const freshCheck = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeaturesArg, segmentFeaturesArg, effEnumerateOpts);
    let anyChanged = false;

    for (const ent of feedbackEntities ?? []) {
      if (ent.startLine === undefined) continue;
      const lastLine = (ent.endLine !== undefined && ent.endLine >= ent.startLine) ? ent.endLine : (spansCopy.length - 1);

      for (let li = ent.startLine + 1; li <= lastLine; li++) {
        if (!freshCheck[li] || freshCheck[li]!.boundary !== 'B') continue;

        const jointPred = freshCheck.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        const jointGold = jointPred.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        jointGold[li] = { boundary: 'C', fields: jointGold[li]!.fields };

        const vPredBoundary = extractJointFeatureVector(lines, spansCopy, jointPred as any, boundaryFeaturesArg, segmentFeaturesArg, schema);
        const vGoldBoundary = extractJointFeatureVector(lines, spansCopy, jointGold as any, boundaryFeaturesArg, segmentFeaturesArg, schema);

        const keys = new Set<string>([...Object.keys(vPredBoundary), ...Object.keys(vGoldBoundary)]);
        for (const k of keys) {
          if (!k.startsWith('line.')) continue;
          const delta = (vGoldBoundary[k] ?? 0) - (vPredBoundary[k] ?? 0);
          const step = Math.max(Math.min(delta, MAX_BOUNDARY_STEP), -MAX_BOUNDARY_STEP);
          const adj = learningRate * meanConf * BOUNDARY_NUDGE_SCALE * step;
          if (Math.abs(adj) > 1e-9) {
            weights[k] = (weights[k] ?? 0) + adj;
            anyChanged = true;
          }
        }
      }

      if (freshCheck[ent.startLine] && freshCheck[ent.startLine]!.boundary !== 'B') {
        const jointPred = freshCheck.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        const jointGold = jointPred.map(s => s ? ({ boundary: s.boundary, fields: s.fields.slice() }) : { boundary: 'C', fields: [] });
        jointGold[ent.startLine] = { boundary: 'B', fields: jointGold[ent.startLine]!.fields };

        const vPredBoundary = extractJointFeatureVector(lines, spansCopy, jointPred as any, boundaryFeaturesArg, segmentFeaturesArg, schema);
        const vGoldBoundary = extractJointFeatureVector(lines, spansCopy, jointGold as any, boundaryFeaturesArg, segmentFeaturesArg, schema);

        const keys = new Set<string>([...Object.keys(vPredBoundary), ...Object.keys(vGoldBoundary)]);
        for (const k of keys) {
          if (!k.startsWith('line.')) continue;
          const delta = (vGoldBoundary[k] ?? 0) - (vPredBoundary[k] ?? 0);
          const step = Math.max(Math.min(delta, MAX_BOUNDARY_STEP), -MAX_BOUNDARY_STEP);
          const adj = learningRate * meanConf * BOUNDARY_NUDGE_SCALE * step;
          if (Math.abs(adj) > 1e-9) {
            weights[k] = (weights[k] ?? 0) + adj;
            anyChanged = true;
          }
        }
      }
    }

    if (!anyChanged) break;
  }

  let predAfterUpdate = decodeJointSequence(
    lines,
    spansCopy,
    weights,
    schema,
    boundaryFeaturesArg,
    segmentFeaturesArg,
    enumerateOpts
  );

  predAfterUpdate = enforceAssertedPredictions();

  const labelMapEntries = Object.entries(labelMap);
  predAfterUpdate = predAfterUpdate.map((state, li) => {
    if (!state) return state;
    const spansForLine = spansCopy[li]?.spans ?? [];
    const fields = [...(state.fields ?? [])];

    for (const [key, lab] of labelMapEntries) {
      const [lineStr, range] = key.split(':');
      if (!range) continue;
      const lineIdx = Number(lineStr);
      if (lineIdx !== li || Number.isNaN(lineIdx)) continue;
      const [startStr, endStr] = range.split('-');
      if (!startStr || !endStr) continue;
      const start = Number(startStr);
      const end = Number(endStr);
      const idx = spansForLine.findIndex(s => s.start === start && s.end === end);
      if (idx >= 0) {
        while (fields.length <= idx) fields.push(schema.noiseLabel);
        fields[idx] = lab;
      }
    }

    const entityType = (() => {
      const list = (subEntityAssertions ?? []) as any[];
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e || e.entityType === undefined || e.startLine === undefined) continue;
        const startLine = e.startLine as number;
        const endLine = (e.endLine !== undefined && e.endLine >= startLine) ? (e.endLine as number) : startLine;
        if (li >= startLine && li <= endLine) return e.entityType;
      }
      return state.entityType;
    })();

    return { ...state, fields, entityType } as JointState;
  });

  return { updated: weights, pred: predAfterUpdate, spansPerLine: spansCopy };
}
