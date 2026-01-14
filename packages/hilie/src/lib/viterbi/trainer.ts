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
  EntityType,
  RecordSpan
} from '../types.js';
import { normalizeFeedback } from '../feedbackUtils.js';
import { decodeJointSequence, extractJointFeatureVector } from './core.js';
import { entitiesFromJointSequence } from './entities.js';
import type { FeatureCandidate } from '../features.js'
import { dynamicCandidatesToFeatures } from '../features.js'

export function updateWeightsFromUserFeedback(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence | RecordSpan[],
  feedback: Feedback,
  weights: Record<string, number>,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  learningRate = 1.0,
  enumerateOpts?: EnumerateOptions,
  stabilizationFactor = 0.15,
  dynamicCandidates?: FeatureCandidate[],
  dynamicInitialWeights?: Record<string, number>
): { updated: Record<string, number>; pred: RecordSpan[]; spansPerLine?: LineSpans[] } {
  // If the user passed in RecordSpan[] (new API), convert it back to a JointSequence
  let jointSeqLocal: JointSequence
  if (Array.isArray(jointSeq) && jointSeq.length > 0 && (jointSeq[0] as any).startLine !== undefined) {
    // build empty joint
    jointSeqLocal = Array.from({ length: lines.length }, () => ({ boundary: 'C' as BoundaryState, fields: [] as FieldLabel[] }))
    const records = jointSeq as RecordSpan[]
    for (const r of records) {
      const start = r.startLine
      const end = r.endLine
      jointSeqLocal[start] = { boundary: 'B', fields: [] } as any
      for (let li = start; li <= end; li++) {
        jointSeqLocal[li] = jointSeqLocal[li] ?? { boundary: 'C', fields: [] }
      }

      for (const se of r.entities ?? []) {
        for (const f of se.fields ?? []) {
          const li = f.lineIndex ?? 0
          const spans = spansPerLine[li]?.spans ?? []
          const idx = spans.findIndex(s => s.start === f.start && s.end === f.end)
          // ensure the per-line joint state exists
          jointSeqLocal[li] = jointSeqLocal[li] ?? { boundary: 'C' as BoundaryState, fields: [] }
          while (jointSeqLocal[li]!.fields.length <= idx) jointSeqLocal[li]!.fields.push(schema.noiseLabel)
          if (idx >= 0) jointSeqLocal[li]!.fields[idx] = f.fieldType ?? schema.noiseLabel
        }
        // ensure start line marked as B if not already
        const prev = jointSeqLocal[se.startLine] ?? { boundary: 'C' as BoundaryState, fields: [] }
        jointSeqLocal[se.startLine] = { ...prev, boundary: prev.boundary === 'B' ? 'B' : 'C' }
      }
    }
  } else {
    jointSeqLocal = jointSeq as JointSequence
  }

  const normalizedFeedback = normalizeFeedback(feedback, lines);
  const feedbackEntities = normalizedFeedback.entities;
  const recordAssertions = normalizedFeedback.records;
  const entityAssertions = normalizedFeedback.entities;

  const spansCopy: LineSpans[] = spansPerLine.map(s => ({
    lineIndex: s.lineIndex,
    spans: s.spans.map(sp => ({ start: sp.start, end: sp.end }))
  }));

  // Merge dynamic features and default weights if provided (breaking, but convenient)
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
        // also reflect removal in the original spansPerLine if present
        const origIdx = (spansPerLine[li]?.spans ?? []).findIndex(x => x.start === f.start && x.end === f.end);
        if (origIdx >= 0) spansPerLine[li]!.spans.splice(origIdx, 1);
        if (f.confidence !== undefined) confs.push(f.confidence);
      } else {
        if (f.start !== undefined && f.end !== undefined) {
          const line = spansCopy[li] ?? { lineIndex: li, spans: [] };
          line.spans = line.spans.filter(sp => {
            if (sp.start === f.start && sp.end === f.end) return true;
            return !spanRangesOverlap(sp.start, sp.end, f.start!, f.end!);
          });
          spansCopy[li] = line;

          // reflect clipping/removal of overlapping spans in the original spansPerLine
          if (spansPerLine[li]) {
            spansPerLine[li]!.spans = spansPerLine[li]!.spans.filter(sp => {
              if (sp.start === f.start && sp.end === f.end) return true;
              return !spanRangesOverlap(sp.start, sp.end, f.start!, f.end!);
            });
          }
        }

        const idx = findSpanIndex(li, f.start, f.end);
        if (idx < 0) {
          spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] };
          spansCopy[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 });
          spansCopy[li]!.spans.sort((a, b) => a.start - b.start);

          // ensure the original spansPerLine also contains the asserted span
          spansPerLine[li] = spansPerLine[li] ?? { lineIndex: li, spans: [] };
          const origExists = spansPerLine[li]!.spans.some(s => s.start === f.start && s.end === f.end);
          if (!origExists) {
            spansPerLine[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 });
            spansPerLine[li]!.spans.sort((a, b) => a.start - b.start);
          }
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

  const entityTypeMap: Record<number, EntityType> = {};

  // If entity assertions include file offsets, map them to overlapping lines
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

  for (const ent of feedbackEntities ?? []) {
    if (ent.entityType === undefined) continue;

    if (ent.fileStart !== undefined && ent.fileEnd !== undefined) {
      const startLine = offsetToLine(ent.fileStart)
      const endLine = offsetToLine(Math.max(0, ent.fileEnd - 1))
      const boundedEnd = Math.min(endLine, spansCopy.length - 1)
      for (let li = startLine; li <= boundedEnd; li++) entityTypeMap[li] = ent.entityType as EntityType
    } else if (ent.startLine !== undefined) {
      const startLine = ent.startLine
      const endLine = (ent.endLine !== undefined && ent.endLine >= startLine) ? ent.endLine : startLine
      const boundedEnd = Math.min(endLine, spansCopy.length - 1)
      for (let li = startLine; li <= boundedEnd; li++) entityTypeMap[li] = ent.entityType as EntityType
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

  // Treat any feedback 'entities' that were created implicitly due to field-only
  // assertions as record boundaries as well. This ensures a field assertion on
  // a line will produce a visible record even when no explicit record assertion
  // was provided.
  for (const ent of feedbackEntities ?? []) {
    // Only consider implicit per-line record containers (startLine present)
    // that carry at least one asserted field and are not already covered by
    // an explicit record assertion.
    if (ent.startLine === undefined) continue;
    if (!ent.fields || ent.fields.length === 0) continue;

    const contained = (recordAssertions ?? []).some(r => r.startLine !== undefined && r.startLine <= (ent.startLine ?? -1) && r.endLine !== undefined && r.endLine >= (ent.endLine ?? ent.startLine ?? -1))
    if (contained) continue;

    const sLine = ent.startLine
    const eLine = (ent.endLine !== undefined && ent.endLine >= sLine) ? ent.endLine : (spansCopy.length - 1)
    forcedBoundariesByLine[sLine] = 'B'
    for (let li = sLine + 1; li <= eLine; li++) forcedBoundariesByLine[li] = 'C'
    const nextLine = eLine + 1;
    if (nextLine >= 0 && nextLine < spansCopy.length) {
      forcedBoundariesByLine[nextLine] = 'B';
    }
  }

  // Ensure entity-only assertions get implicit record boundaries so
  // they will be rendered even when no explicit record was asserted.
  for (const se of entityAssertions ?? []) {
    if (se.startLine === undefined && (se.fileStart === undefined || se.fileEnd === undefined)) continue;
    const sLine = se.startLine ?? offsetToLine(se.fileStart ?? 0)
    const eLine = se.endLine ?? offsetToLine(Math.max(0, (se.fileEnd ?? 0) - 1))
    if (sLine === undefined || eLine === undefined) continue;
    const contained = recordAssertions && recordAssertions.some(r => r.startLine !== undefined && r.startLine <= sLine && r.endLine !== undefined && r.endLine >= eLine)
    if (contained) continue;
    forcedBoundariesByLine[sLine] = 'B'
    for (let li = sLine + 1; li <= eLine; li++) forcedBoundariesByLine[li] = 'C'
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
        const predLabel = (jointSeqLocal[li] && jointSeqLocal[li]!.fields && jointSeqLocal[li]!.fields[0])
          ? (function findMatching() {
            const origIdx = (spansPerLine[li]?.spans ?? []).findIndex(x => x.start === sp.start && x.end === sp.end);
            if (origIdx >= 0) return jointSeqLocal[li]!.fields[origIdx] ?? schema.noiseLabel;
            return schema.noiseLabel as FieldLabel;
          })()
          : (schema.noiseLabel as FieldLabel);
        fields.push(predLabel);
      }
    }

    const boundary: BoundaryState = (forcedBoundariesByLine[li] as BoundaryState) ??
      (boundarySet.has(li) ? 'B' : (jointSeqLocal[li] ? jointSeqLocal[li]!.boundary : 'C'));

    const entityType = entityTypeMap[li] ?? (jointSeqLocal[li] ? jointSeqLocal[li]!.entityType : undefined);

    if (entityType !== undefined) gold.push({ boundary, fields, entityType });
    else gold.push({ boundary, fields });
  }

  const predUnforced = decodeJointSequence(
    lines,
    spansCopy,
    weights,
    schema,
    boundaryFeatures,
    segmentFeatures,
    effEnumerateOpts
  );



  const vGold = extractJointFeatureVector(lines, spansCopy, gold, boundaryFeatures, segmentFeatures, schema);
  const vPred = extractJointFeatureVector(lines, spansCopy, predUnforced, boundaryFeatures, segmentFeatures, schema);

  let pred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, finalEnumerateOpts);

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

      const spansSingle: LineSpans[] = origSpans.map((_s: LineSpans | undefined, idx: number) => {
        if (idx !== li) return { lineIndex: idx, spans: [] } as LineSpans;
        return { lineIndex: li, spans: [{ start: useStart, end: useEnd }] } as LineSpans;
      });

      const jointPred: JointState[] = spansSingle.map((_s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [f.fieldType as FieldLabel] } as JointState;
      });
      const jointGold: JointState[] = spansSingle.map((_s: LineSpans, idx: number) => {
        if (idx !== li) return { boundary: 'C', fields: [] } as JointState;
        return { boundary: 'C', fields: [schema.noiseLabel] } as JointState;
      });

      const vPredSpan = extractJointFeatureVector(lines, spansSingle, jointPred, boundaryFeatures, segmentFeatures, schema);
      const vGoldSpan = extractJointFeatureVector(lines, spansSingle, jointGold, boundaryFeatures, segmentFeatures, schema);

      const keys = new Set<string>([...Object.keys(vPredSpan), ...Object.keys(vGoldSpan)]);
      for (const k of keys) {
        const delta = (vGoldSpan[k] ?? 0) - (vPredSpan[k] ?? 0);
        weights[k] = (weights[k] ?? 0) + learningRate * (f.confidence ?? 1.0) * delta;
      }
    } else {
      // No matching original span found for this remove assertion; apply a deterministic negative nudge
      const featId = labelFeatureMap[f.fieldType as string];
      if (featId) {
        const beforeVal = weights[featId] ?? 0;
        const nud = -2.0 * learningRate * (f.confidence ?? 1.0);
        weights[featId] = beforeVal + nud;
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

    const newPred = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, enumerateOptsWithForces);
    for (let i = 0; i < newPred.length; i++) if (newPred[i]) pred[i] = newPred[i]!;
  }

  function enforceAssertedPredictions(): JointSequence {
    let predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, enumerateOptsWithForces);

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
      predLocal = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, enumerateOptsWithForces);
    }

    return predLocal;
  }

  tryNudge('segment.is_phone', 'Phone');
  tryNudge('segment.is_email', 'Email');
  tryNudge('segment.is_extid', 'ExtID');

  // Strong direct boosts for asserted fields: when a user explicitly adds a field
  // with high confidence, apply a stronger label-feature bump so the model
  // assigns significant probability to that label immediately.
  for (const af of assertedFields.filter((x: any) => x.action !== 'remove')) {
    const featId = labelFeatureMap[af.fieldType as string];
    if (!featId) continue;
    const boostScale = (af.confidence ?? 1.0) >= 0.8 ? 6.0 : 3.0;
    weights[featId] = (weights[featId] ?? 0) + boostScale * learningRate * (af.confidence ?? 1.0);
  }

  if (stabilizationFactor > 0) {
    for (let li = 0; li < spansPerLine.length; li++) {
      const origSpans = spansPerLine[li]?.spans ?? [];
      const origState = jointSeqLocal[li];
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
    const freshCheck = decodeJointSequence(lines, spansCopy, weights, schema, boundaryFeatures, segmentFeatures, effEnumerateOpts);
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
    boundaryFeatures,
    segmentFeatures,
    enumerateOpts
  );

  predAfterUpdate = enforceAssertedPredictions();

  // Fallback: if the decode produced no record boundaries (no 'B'), ensure
  // that the asserted lines become record starts so returned records include
  // the asserted fields. This guards against pathological weight updates that
  // inadvertently collapse all boundaries.
  if (!predAfterUpdate.some(p => p && p.boundary === 'B')) {
    const fallbackLine = (assertedFields && assertedFields.length > 0) ? (assertedFields[0].lineIndex ?? 0) : 0
    if (fallbackLine >= 0 && fallbackLine < predAfterUpdate.length && predAfterUpdate[fallbackLine]) {
      predAfterUpdate[fallbackLine] = { ...predAfterUpdate[fallbackLine]!, boundary: 'B' }
    } else if (predAfterUpdate.length > 0 && predAfterUpdate[0]) {
      predAfterUpdate[0] = { ...predAfterUpdate[0]!, boundary: 'B' }
    }
  }

  // If only entity assertions were provided (no explicit record assertions),
  // prefer a collapsed record segmentation where only the asserted entity
  // start lines are boundaries. This mirrors legacy behavior where entity
  // feedback alone creates visible records at the asserted starts rather than
  // preserving many other spurious boundaries.
  if ((recordAssertions == null || recordAssertions.length === 0) && (entityAssertions && entityAssertions.length > 0)) {
    const forcedStarts = Object.keys(forcedBoundariesByLine).filter(k => forcedBoundariesByLine[Number(k)] === 'B').map(k => Number(k)).sort((a, b) => a - b)
    if (forcedStarts.length > 0) {
      const minStart = forcedStarts[0]!
      const maxStart = forcedStarts[forcedStarts.length - 1]!
      for (let li = 0; li < predAfterUpdate.length; li++) {
        if (!predAfterUpdate[li]) continue
        if (forcedStarts.includes(li)) continue
        if (li >= minStart && li <= maxStart) {
          predAfterUpdate[li] = { ...predAfterUpdate[li]!, boundary: 'C' }
        }
      }
    }
  }

  const labelMapEntries = Object.entries(labelMap);
  predAfterUpdate = predAfterUpdate.map((state, li) => {
    if (!state) return state;
    const spansForLine = spansCopy[li]?.spans ?? [];
    const fields = [...(state.fields ?? [])];

    // Apply remove assertions by forcing those spans to be noiseLabel in the prediction
    for (const f of assertedFields.filter((x: any) => x.action === 'remove')) {
      const liF = f.lineIndex ?? f.startLine ?? 0;
      if (liF !== li) continue;
      // If an exact span match exists, force it to noise; otherwise, mark overlapping spans as noise
      let matched = false;
      for (let si = 0; si < spansForLine.length; si++) {
        const s = spansForLine[si]!;
        if (s.start === f.start && s.end === f.end) {
          while (fields.length <= si) fields.push(schema.noiseLabel);
          fields[si] = schema.noiseLabel;
          matched = true;
        }
      }
      if (!matched) {
        for (let si = 0; si < spansForLine.length; si++) {
          const s = spansForLine[si]!;
          const overlap = !(s.end <= (f.start ?? 0) || s.start >= (f.end ?? 0));
          if (overlap) {
            while (fields.length <= si) fields.push(schema.noiseLabel);
            fields[si] = schema.noiseLabel;
          }
        }
      }
    }

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
        // Diagnostic: log when we apply a forced label for debugging
        // eslint-disable-next-line no-console
        while (fields.length <= idx) fields.push(schema.noiseLabel);
        fields[idx] = lab;
      }
    }



    const entityType = (() => {
      const list = (entityAssertions ?? []) as any[];
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e || e.entityType === undefined || e.startLine === undefined) continue;
        const startLine = e.startLine as number;
        const endLine = (e.endLine !== undefined && e.endLine >= startLine) ? (e.endLine as number) : startLine;
        if (li >= startLine && li <= endLine) return e.entityType;
      }
      return state.entityType;
    })();

    return { ...state, fields, entityType } as any;
  });

  const records = entitiesFromJointSequence(lines, spansCopy, predAfterUpdate as any, weights, segmentFeaturesArg, schema, entityAssertions)

  // Post-process to enforce asserted field labels and remove overlapping candidates
  const normFields = (normalizedFeedback?.entities ?? []).flatMap((e: any) => e.fields ?? [])
  // (no-op) normalized feedback entities logged during debugging
  for (const af of normFields.filter((x: any) => (x.action ?? 'add') !== 'remove')) {
    const li = af.lineIndex ?? af.startLine
    if (li === undefined || li === null) continue
    const start = af.start
    const end = af.end
    if (start === undefined || end === undefined) continue

    // Find the record that contains this line (or skip if not found)
    const rec = records.find(r => r.startLine <= li && r.endLine >= li)
    if (!rec) continue

    // Prefer an entity container that overlaps the asserted range, otherwise use the first entity on that line
    let se = (rec.entities ?? []).find(s => (s.startLine ?? 0) <= li && (s.endLine ?? 0) >= li)
    if (!se) {
      // create a minimal entity spanning the single line
      se = { startLine: li, endLine: li, fileStart: 0, fileEnd: 0, entityType: af.entityType ?? 'Unknown', fields: [] as any }
      rec.entities = rec.entities ?? []
      rec.entities.push(se)
    }

    // Remove any overlapping fields within this sub-entity
    se.fields = (se.fields ?? []).filter((f: any) => (f.lineIndex !== li) || (f.end <= start || f.start >= end))

    // Ensure the asserted field exists
    let found = (se.fields ?? []).find((f: any) => f.lineIndex === li && f.start === start && f.end === end)
    if (!found) {
      const fileStart = (se.fileStart ?? 0) + start
      const fileEnd = (se.fileStart ?? 0) + end
      const text = lines[li]?.slice(start, end) ?? ''
      found = { lineIndex: li, start, end, text, fileStart, fileEnd, fieldType: af.fieldType, confidence: af.confidence ?? 0.9 }
      se.fields.push(found)
      // Ensure fields ordered
      se.fields.sort((a:any,b:any)=> (a.lineIndex - b.lineIndex) || (a.start - b.start) || (a.end - b.end))
    } else {
      // Override field type and boost confidence
      found.fieldType = af.fieldType
      found.confidence = Math.max(found.confidence ?? 0, af.confidence ?? 0.9, 0.6)
    }
  }

  // Fallback enforcement: also inspect raw feedback entries and ensure any explicitly
  // added field assertions are present in returned records. This handles cases
  // where normalization may have not attached the field as expected.
  const rawFieldEntries = (feedback && Array.isArray((feedback as any).entries)) ? (feedback as any).entries.filter((e: any) => e.kind === 'field').map((e: any) => e.field) : []

  for (const af of rawFieldEntries.filter((x: any) => (x.action ?? 'add') !== 'remove')) {
    const li = af.lineIndex ?? af.startLine
    if (li === undefined || li === null) continue
    const start = af.start
    const end = af.end
    if (start === undefined || end === undefined) continue

    const rec = records.find(r => r.startLine <= li && r.endLine >= li)
    if (!rec) continue

    let se = (rec.entities ?? []).find(s => (s.startLine ?? 0) <= li && (s.endLine ?? 0) >= li)
    if (!se) {
      se = { startLine: li, endLine: li, fileStart: 0, fileEnd: 0, entityType: af.entityType ?? 'Unknown', fields: [] as any }
      rec.entities = rec.entities ?? []
      rec.entities.push(se)
    }

    // Debug: trace when handling the specific asserted email span


    se.fields = (se.fields ?? []).filter((f: any) => (f.lineIndex !== li) || (f.end <= start || f.start >= end))

    let found = (se.fields ?? []).find((f: any) => f.lineIndex === li && f.start === start && f.end === end)
    if (!found) {
      const fileStart = (se.fileStart ?? 0) + start
      const fileEnd = (se.fileStart ?? 0) + end
      const text = lines[li]?.slice(start, end) ?? ''
      found = { lineIndex: li, start, end, text, fileStart, fileEnd, fieldType: af.fieldType, confidence: af.confidence ?? 0.9 }
      se.fields.push(found)
      se.fields.sort((a:any,b:any)=> (a.lineIndex - b.lineIndex) || (a.start - b.start) || (a.end - b.end))

    } else {
      found.fieldType = af.fieldType
      found.confidence = Math.max(found.confidence ?? 0, af.confidence ?? 0.9, 0.6)

    }
  }



  return { updated: weights, pred: records, spansPerLine: spansCopy };
}

// =======================
// Record-level training utilities (streaming)
// =======================

export function updateWeightsForRecord(
  lines: string[],
  spansPerLine: LineSpans[],
  startLine: number,
  endLine: number,
  jointGold: JointSequence,
  weights: Record<string, number>,
  boundaryFeaturesArg: Feature[],
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  learningRate = 1.0,
  dynamicCandidates?: FeatureCandidate[],
  dynamicInitialWeights?: Record<string, number>,
  regularizationLambda = 0.0,
  applyUpdates = true
): { updated: Record<string, number>; delta: Record<string, number>; pred: JointSequence } {
  const windowLines = lines.slice(startLine, endLine)
  const windowSpans = spansPerLine.slice(startLine, endLine)

  // Merge dynamic features if provided
  let bFeatures = [...boundaryFeaturesArg]
  let sFeatures = [...segmentFeaturesArg]
  if (dynamicCandidates && dynamicCandidates.length) {
    const dyn = dynamicCandidatesToFeatures(dynamicCandidates)
    bFeatures = bFeatures.concat(dyn.boundaryFeatures)
    sFeatures = sFeatures.concat(dyn.segmentFeatures)
  }

  if (dynamicInitialWeights) {
    for (const [k, v] of Object.entries(dynamicInitialWeights)) {
      const dynKey = `dyn:${k}`
      if (weights[dynKey] === undefined) weights[dynKey] = v
    }
  }

  // Decode current prediction on the record window
  const pred = decodeJointSequence(windowLines, windowSpans, weights, schema, bFeatures, sFeatures)

  // Compute feature vectors
  const vGold = extractJointFeatureVector(windowLines, windowSpans, jointGold, bFeatures, sFeatures, schema)
  const vPred = extractJointFeatureVector(windowLines, windowSpans, pred, bFeatures, sFeatures, schema)

  // Add simple label indicator features so updates can target label biases
  for (let li = 0; li < windowSpans.length; li++) {
    const spans = windowSpans[li] ?? { lineIndex: li, spans: [] } as any
    const goldState = jointGold[li]
    const predState = pred[li]

    for (let si = 0; si < spans.spans.length; si++) {
      const gLabel = (goldState && goldState.fields && goldState.fields[si]) ? goldState.fields[si] : schema.noiseLabel
      const pLabel = (predState && predState.fields && predState.fields[si]) ? predState.fields[si] : schema.noiseLabel

      if (gLabel && gLabel !== schema.noiseLabel) {
        const key = `segment.is_${String(gLabel).toLowerCase()}`
        vGold[key] = (vGold[key] ?? 0) + 1
      }
      if (pLabel && pLabel !== schema.noiseLabel) {
        const key = `segment.is_${String(pLabel).toLowerCase()}`
        vPred[key] = (vPred[key] ?? 0) + 1
      }
    }
  }

  const keys = new Set<string>([...Object.keys(vGold), ...Object.keys(vPred)])
  const delta: Record<string, number> = {}
  for (const k of keys) {
    const d = (vGold[k] ?? 0) - (vPred[k] ?? 0)
    const step = learningRate * d
    delta[k] = step
    if (applyUpdates) weights[k] = (weights[k] ?? 0) + step
  }

  // Ensure label indicator features receive a positive nudge when gold indicates a label
  for (let li = 0; li < windowSpans.length; li++) {
    const spans = windowSpans[li] ?? { lineIndex: li, spans: [] } as any
    const goldState = jointGold[li]

    for (let si = 0; si < spans.spans.length; si++) {
      const gLabel = (goldState && goldState.fields && goldState.fields[si]) ? goldState.fields[si] : schema.noiseLabel
      if (gLabel && gLabel !== schema.noiseLabel) {
        const key = `segment.is_${String(gLabel).toLowerCase()}`
        if ((delta[key] ?? 0) <= 0) {
          const step = learningRate * 1.0
          delta[key] = (delta[key] ?? 0) + step
          if (applyUpdates) weights[key] = (weights[key] ?? 0) + step
        }
      }
    }
  }

  // Apply L2 regularization as a weight decay term across existing weights and any computed deltas
  if ((regularizationLambda ?? 0) > 0) {
    const l2Keys = new Set<string>([...Object.keys(weights), ...Object.keys(delta)])
    for (const k of l2Keys) {
      const w = weights[k] ?? 0
      if (w === 0) continue
      const regStep = -learningRate * (regularizationLambda ?? 0) * w
      delta[k] = (delta[k] ?? 0) + regStep
      if (applyUpdates) weights[k] = (weights[k] ?? 0) + regStep
    }
  }

  return { updated: weights, delta, pred }
}

export function trainDocument(
  lines: string[],
  spansPerLine: LineSpans[],
  goldRecords: Array<{ startLine: number; endLine: number; jointGold: JointSequence }>,
  weights: Record<string, number>,
  boundaryFeatures: Feature[],
  segmentFeatures: Feature[],
  schema: FieldSchema,
  opts?: { epochs?: number; learningRate?: number; shuffle?: boolean; batchSize?: number; regularizationLambda?: number; dynamicCandidates?: FeatureCandidate[]; dynamicInitialWeights?: Record<string, number>; learningRateSchedule?: { type: 'constant' | 'exponential' | 'linear'; factor?: number } }
): { updated: Record<string, number>; history: Array<Record<string, number>> } {
  const epochs = opts?.epochs ?? 1
  const lr = opts?.learningRate ?? 1.0
  const shuffle = opts?.shuffle ?? false
  const history: Array<Record<string, number>> = []

  const batchSize = opts?.batchSize ?? 1

  for (let e = 0; e < epochs; e++) {
    // compute learning rate for this epoch according to schedule
    let epochLr = lr
    const sched = opts?.learningRateSchedule
    if (sched) {
      if (sched.type === 'exponential') {
        const factor = sched.factor ?? 0.5
        epochLr = (opts?.learningRate ?? lr) * Math.pow(factor, e)
      } else if (sched.type === 'linear') {
        const base = opts?.learningRate ?? lr
        const denom = Math.max(1, epochs - 1)
        epochLr = base * (1 - (e / denom))
      } else {
        epochLr = opts?.learningRate ?? lr
      }
    }

    let records = [...goldRecords]
    if (shuffle) {
      for (let i = records.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = records[i] as typeof records[number]
        records[i] = records[j] as typeof records[number]
        records[j] = tmp
      }
    }

    if (batchSize <= 1) {
      for (const r of records) {
        updateWeightsForRecord(
          lines,
          spansPerLine,
          r.startLine,
          r.endLine,
          r.jointGold,
          weights,
          boundaryFeatures,
          segmentFeatures,
          schema,
          epochLr,
          opts?.dynamicCandidates,
          opts?.dynamicInitialWeights,
          opts?.regularizationLambda ?? 0
        )
      }
    } else {
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize)
        const baseWeights = { ...weights }
        const deltaSum: Record<string, number> = {}

        for (const r of batch) {
          const res = updateWeightsForRecord(
            lines,
            spansPerLine,
            r.startLine,
            r.endLine,
            r.jointGold,
            baseWeights,
            boundaryFeatures,
            segmentFeatures,
            schema,
            epochLr,
            opts?.dynamicCandidates,
            opts?.dynamicInitialWeights,
            opts?.regularizationLambda ?? 0,
            false // do not apply updates while computing batch deltas
          )

          for (const [k, v] of Object.entries(res.delta)) {
            deltaSum[k] = (deltaSum[k] ?? 0) + v
          }
        }

        // apply average delta across batch
        for (const [k, v] of Object.entries(deltaSum)) {
          const avg = v / batch.length
          weights[k] = (weights[k] ?? 0) + avg
        }
      }
    }

    // push snapshot of weights into history after epoch
    history.push({ ...weights })
  }

  return { updated: weights, history }
}
