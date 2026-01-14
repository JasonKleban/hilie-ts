import type {
  Feature,
  FeatureContext,
  FieldLabel,
  FieldSchema,
  FieldSpan,
  JointSequence,
  LineSpans,
  RecordSpan,
  EntitySpan,
  EntityType
} from '../types.js';
import type { LabelModel, SpanLabelFeatureContext } from '../labelModel.js';
import { boundaryFeatures } from '../features.js';
import { defaultLabelModel } from '../prebuilt.js';

export function annotateEntityTypesInSequence(
  lines: string[],
  jointSeq: JointSequence,
  boundaryFeaturesArg?: Feature[]
): JointSequence {
  const bFeatures = boundaryFeaturesArg ?? boundaryFeatures;

  const featuresPerLine: Record<number, Record<string, number>> = {};

  for (let i = 0; i < jointSeq.length; i++) {
    const ctx: FeatureContext = { lineIndex: i, lines };
    const feats: Record<string, number> = {};
    for (const f of bFeatures) feats[f.id] = f.apply(ctx);

    const line = lines[i] ?? '';
    feats['line.role_keyword'] = /\bParent\b|\bGuardian\b|\bGrandparent\b|\bAunt\/Uncle\b|\bFoster\b|\bEmergency Contact\b/i.test(line)
      ? 1
      : 0;

    featuresPerLine[i] = feats;
  }

  const primaryWeights: Record<string, number> = {
    'line.primary_likely': 2.0,
    'line.leading_extid': 1.6,
    'line.has_name': 1.6,
    'line.has_preferred': 1.2,
    'line.has_birthdate': 1.0,
    'line.has_label': 1.0,
    'line.next_has_contact': 1.2,
    'line.short_token_count': 0.6,
    'line.leading_structural': 0.2,
    'line.indentation_delta': 0.2
  };

  const guardianWeights: Record<string, number> = {
    'line.guardian_likely': 2.0,
    'line.role_keyword': 2.0,
    'line.leading_structural': 0.6,
    'line.has_label': 0.4,
    'line.short_token_count': 0.2
  };

  const assigned = jointSeq.map(s => ({ ...s }));

  for (let i = 0; i < assigned.length; i++) {
    const cell = assigned[i]!;
    if (!cell || cell.boundary !== 'B') {
      if (cell) cell.entityType = 'Unknown';
      continue;
    }

    const feats = featuresPerLine[i] ?? {};
    let pScore = 0;
    let gScore = 0;

    for (const k of Object.keys(feats)) {
      pScore += (primaryWeights[k] ?? 0) * (feats[k] ?? 0);
      gScore += (guardianWeights[k] ?? 0) * (feats[k] ?? 0);
    }

    if ((feats['line.has_name'] ?? 0) > 0) pScore += 0.5;

    if (pScore >= 1.0 && pScore > gScore) cell.entityType = 'Primary';
    else if (gScore >= 0.8 && gScore >= pScore) cell.entityType = 'Guardian';
    else cell.entityType = 'Unknown';
  }

  const MAX_DISTANCE = 3;

  for (let i = 0; i < assigned.length; i++) {
    const cell = assigned[i]!;
    if (!cell || cell.entityType !== 'Guardian') continue;

    let foundPrimary: number | null = null;
    for (let d = 1; d <= MAX_DISTANCE; d++) {
      const j = i - d;
      if (j < 0) break;
      const other = assigned[j]!;
      if (other && other.entityType === 'Primary') {
        foundPrimary = j;
        break;
      }
      if (other && other.boundary !== 'B') break;
    }

    if (foundPrimary === null) {
      for (let d = 1; d <= 1; d++) {
        const j = i + d;
        if (j >= assigned.length) break;
        const other = assigned[j]!;
        if (other && other.entityType === 'Primary') {
          foundPrimary = j;
          break;
        }
        if (other && other.boundary !== 'B') break;
      }
    }

    if (foundPrimary === null) cell.entityType = 'Unknown';
  }

  return assigned;
}

export function entitiesFromJointSequence(
  lines: string[],
  spansPerLine: LineSpans[],
  jointSeq: JointSequence,
  featureWeights: Record<string, number> | undefined,
  segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  // Optional normalized entity assertions coming from feedback (file ranges + entityType).
  feedbackEntities?: { fileStart?: number; fileEnd?: number; startLine?: number; endLine?: number; entityType?: EntityType }[],
  labelModel?: LabelModel
): RecordSpan[] {
  const lm: LabelModel = labelModel ?? defaultLabelModel;

  const offsets: number[] = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(off);
    off += (lines[i]?.length ?? 0) + 1;
  }

  function scoreLabelForSpan(lineIndex: number, spanIdx: number, label: FieldLabel): number {
    const span = spansPerLine[lineIndex]!.spans[spanIdx]!;
    const sctx: FeatureContext = {
      lineIndex,
      lines,
      candidateSpan: { lineIndex, start: span.start, end: span.end }
    };

    const txt = lines[lineIndex]?.slice(sctx.candidateSpan!.start, sctx.candidateSpan!.end) ?? '';

    const isWhitespace = /^\s*$/.test(txt);
    if (isWhitespace && label !== schema.noiseLabel) return -100;

    let score = 0;
    for (const f of segmentFeaturesArg) {
      const v = f.apply(sctx);
      const w = (featureWeights && featureWeights[f.id]) ?? 0;
      const ctx2: SpanLabelFeatureContext = { label, spanText: txt, featureId: f.id, featureValue: v, schema };
      const transformed = lm.featureContribution ? lm.featureContribution(ctx2) : v;
      score += w * transformed;
    }

    return score;
  }

  const records: RecordSpan[] = [];

  const jointAnnotated = !jointSeq.some(s => s && s.entityType !== undefined)
    ? annotateEntityTypesInSequence(lines, jointSeq)
    : jointSeq;
  const jointLocal = jointAnnotated;

  for (let i = 0; i < jointLocal.length; i++) {
    if (jointLocal[i]!.boundary !== 'B') continue;

    let j = i + 1;
    while (j < jointLocal.length && jointLocal[j]!.boundary !== 'B') j++;

    const startLine = i;
    const endLine = j - 1;

    const entities: EntitySpan[] = [];

    for (let li = startLine; li <= endLine; li++) {
      const role = (jointLocal[li] && jointLocal[li]!.entityType)
        ? (jointLocal[li]!.entityType as EntityType)
        : 'Unknown';
      const spans = spansPerLine[li]?.spans ?? [];

      if (role === 'Unknown') {
        let hasNonNoise = false;
        for (let si = 0; si < spans.length; si++) {
          const assignedLabel = (jointSeq[li] && jointSeq[li]!.fields && jointSeq[li]!.fields[si])
            ? jointSeq[li]!.fields[si]
            : undefined;
          if (assignedLabel !== undefined && assignedLabel !== schema.noiseLabel) {
            hasNonNoise = true;
            break;
          }
        }
        if (!hasNonNoise) continue;
      }

      const lineFields: FieldSpan[] = [];
      for (let si = 0; si < spans.length; si++) {
        const s = spans[si]!;
        const fileStart = offsets[li]! + s.start;
        const fileEnd = offsets[li]! + s.end;
        const text = lines[li]?.slice(s.start, s.end) ?? '';
        const assignedLabel = (jointSeq[li] && jointSeq[li]!.fields && jointSeq[li]!.fields[si])
          ? jointSeq[li]!.fields[si]
          : undefined;

        let confidence = 0.5;
        if (featureWeights) {
          const labelScores: number[] = [];
          const labels: FieldLabel[] = schema.fields.map(f => f.name).concat(schema.noiseLabel);
          for (const lab of labels) labelScores.push(scoreLabelForSpan(li, si, lab));
          const max = Math.max(...labelScores);
          const exps = labelScores.map(sv => Math.exp(sv - max));
          const ssum = exps.reduce((a, b) => a + b, 0);
          const probs = exps.map(e => e / ssum);
          const idx = labels.indexOf(assignedLabel ?? schema.noiseLabel);
          confidence = probs[idx] ?? 0;
        }

        lineFields.push({
          lineIndex: li,
          start: s.start,
          end: s.end,
          text,
          fileStart,
          fileEnd,
          fieldType: assignedLabel,
          confidence
        });
      }

      // Enforce non-overlap among final assigned (non-NOISE) field spans.
      // When the model has labeled multiple overlapping candidate spans on the
      // same line, we deterministically select a subset to guarantee that the
      // rendered fields never overlap, regardless of fieldType. Selection is
      // greedy by descending confidence, with stable tie-breakers for
      // determinism.
      if (lineFields.length > 1) {
        const nonNoise = lineFields.filter(f => f.fieldType !== schema.noiseLabel);
        if (nonNoise.length > 1) {
          // Sort by confidence desc, then start asc, then end desc to be deterministic
          nonNoise.sort((a, b) => ((b.confidence ?? 0) - (a.confidence ?? 0)) || (a.start - b.start) || (b.end - a.end));
          const chosen: { start: number; end: number }[] = [];
          const keepSet = new Set<string>();
          const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => !(aEnd <= bStart || aStart >= bEnd);
          for (const f of nonNoise) {
            let ok = true;
            for (const c of chosen) {
              if (overlaps(f.start, f.end, c.start, c.end)) { ok = false; break }
            }
            if (ok) {
              chosen.push({ start: f.start, end: f.end });
              keepSet.add(`${f.start}:${f.end}`);
            }
          }
          // Rebuild lineFields preserving noise spans and only the chosen non-noise spans
          const rebuilt = lineFields.filter(f => (f.fieldType === schema.noiseLabel) || keepSet.has(`${f.start}:${f.end}`));
          // Preserve original ordering by start then end
          rebuilt.sort((a, b) => a.start - b.start || a.end - b.end);
          // replace
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          // (we shadow lineFields purposely)
          // @ts-ignore
          lineFields.length = 0;
          for (const rf of rebuilt) lineFields.push(rf);
        }
      }

      const last = subEntities[subEntities.length - 1];

      // Compute tight line bounds from any *non-NOISE* fields on this line. We
      // ignore NOISE-only spans for tight bounds so that user-selected mid-line
      // offsets are respected even when a line contains only NOISE tokens.
      const nonNoiseFields = lineFields.filter(f => f.fieldType !== schema.noiseLabel)
      const lineHasFields = nonNoiseFields.length > 0
      const lineMinStart = lineHasFields ? Math.min(...nonNoiseFields.map(f => f.fileStart)) : (offsets[li] ?? 0)
      const lineMaxEnd = lineHasFields ? Math.max(...nonNoiseFields.map(f => f.fileEnd)) : ((offsets[li] ?? 0) + (lines[li]?.length ?? 0))

      if (last && last.entityType === role) {
        last.endLine = li;
        // When extending an existing entity, extend its fileEnd to include
        // any fields on this line, otherwise extend to the full line end.
        last.fileEnd = lineHasFields ? Math.max(last.fileEnd ?? 0, lineMaxEnd) : ((offsets[li] ?? 0) + (lines[li]?.length ?? 0));
        // Also ensure fileStart remains the earliest seen field start when possible.
        if (lineHasFields) last.fileStart = Math.min(last.fileStart ?? lineMinStart, lineMinStart);

        for (const f of lineFields) last.fields.push(f);
      } else {
        const fileStart = lineHasFields ? lineMinStart : (offsets[li] ?? 0);
        const fileEnd = lineHasFields ? lineMaxEnd : ((offsets[li] ?? 0) + (lines[li]?.length ?? 0));
        entities.push({ startLine: li, endLine: li, fileStart, fileEnd, entityType: role, fields: lineFields });
      }
    }

    // Prefer precise feedback file offsets for aggregated sub-entities when available.
    function spansOverlap(aStart?: number, aEnd?: number, bStart?: number, bEnd?: number) {
      if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) return false
      return !(aEnd <= bStart || aStart >= bEnd)
    }

    // Compute record-level file bounds early so we can clamp sub-entities to them
    const recFileStart = offsets[startLine] ?? 0;
    const recFileEnd = (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0);

    if (feedbackEntities && feedbackEntities.length > 0) {
      for (const fb of feedbackEntities) {
        if (fb.fileStart === undefined || fb.fileEnd === undefined || fb.entityType === undefined) continue
        for (const se of entities) {
          if (!spansOverlap(se.fileStart, se.fileEnd, fb.fileStart, fb.fileEnd)) continue

          // Preserve the asserted file offsets (end-exclusive) and honor the
          // asserted entity type even when the decoder disagreed.
          se.fileStart = fb.fileStart
          se.fileEnd = fb.fileEnd
          se.entityType = fb.entityType as EntityType

          // Recompute line bounds to be consistent with the preserved offsets.
          const offsetToLine = (off: number) => {
            if (offsets.length === 0) return 0
            if (off < offsets[0]!) return 0
            const lastIdx = offsets.length - 1
            if (off >= offsets[lastIdx]!) return lastIdx
            let lo = 0, hi = lastIdx
            while (lo < hi) {
              const mid = Math.floor((lo + hi + 1) / 2)
              if ((offsets[mid] ?? 0) <= off) lo = mid
              else hi = mid - 1
            }
            return lo
          }
          se.startLine = offsetToLine(se.fileStart)
          se.endLine = offsetToLine(Math.max(0, se.fileEnd - 1))

          // Clamp preserved ty ranges to the containing record range
          if (se.fileStart < recFileStart) se.fileStart = recFileStart
          if (se.fileEnd > recFileEnd) se.fileEnd = recFileEnd
        }
      }
    }

    // Ensure fields are strictly inside their parent sub-entity bounds, and compute
    // entity-relative offsets based on the sub-entity's file start (not record).
    for (const se of subEntities) {
      // Clamp sub-entities to record bounds as a safety measure
      if (se.fileStart < recFileStart) se.fileStart = recFileStart
      if (se.fileEnd > recFileEnd) se.fileEnd = recFileEnd

      // Filter out fields that fall outside the precise bounds of the sub-entity
      se.fields = (se.fields ?? []).filter(f => (f.fileStart ?? 0) >= (se.fileStart ?? 0) && (f.fileEnd ?? 0) <= (se.fileEnd ?? 0))

      for (const f of se.fields) {
        f.entityStart = f.fileStart - (se.fileStart ?? 0);
        f.entityEnd = f.fileEnd - (se.fileStart ?? 0);
      }
    }

    const fileStart = offsets[startLine] ?? 0;
    const fileEnd = (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0);

    records.push({ startLine, endLine, fileStart, fileEnd, subEntities });
  }

  return records;
}

// New: assemble records directly from a windowed joint sequence and decoder candidates
export function assembleRecordsFromCandidates(
  lines: string[],
  spansPerLine: LineSpans[],
  windowStartLine: number,
  jointWindow: JointSequence,
  spanCandidatesWindow: import('../types.js').SpanCandidate[][],
  _featureWeights: Record<string, number> | undefined,
  _segmentFeaturesArg: Feature[],
  schema: FieldSchema,
  feedbackEntities?: { fileStart?: number; fileEnd?: number; startLine?: number; endLine?: number; entityType?: EntityType }[],
  _labelModel?: LabelModel
): RecordSpan[] {

  // Annotate entity types for the window using boundary features (local indexing)
  function annotateWindowEntityTypes(): JointSequence {
    const bFeatures = boundaryFeatures;
    const featuresPerLine: Record<number, Record<string, number>> = {};

    for (let i = 0; i < jointWindow.length; i++) {
      const globalIdx = windowStartLine + i;
      const ctx: FeatureContext = { lineIndex: globalIdx, lines };
      const feats: Record<string, number> = {};
      for (const f of bFeatures) feats[f.id] = f.apply(ctx);

      const line = lines[globalIdx] ?? '';
      feats['line.role_keyword'] = /\bParent\b|\bGuardian\b|\bGrandparent\b|\bAunt\/Uncle\b|\bFoster\b|\bEmergency Contact\b/i.test(line)
        ? 1
        : 0;

      featuresPerLine[i] = feats;
    }

    const primaryWeights: Record<string, number> = {
      'line.primary_likely': 2.0,
      'line.leading_extid': 1.6,
      'line.has_name': 1.6,
      'line.has_preferred': 1.2,
      'line.has_birthdate': 1.0,
      'line.has_label': 1.0,
      'line.next_has_contact': 1.2,
      'line.short_token_count': 0.6,
      'line.leading_structural': 0.2,
      'line.indentation_delta': 0.2
    };

    const guardianWeights: Record<string, number> = {
      'line.guardian_likely': 2.0,
      'line.role_keyword': 2.0,
      'line.leading_structural': 0.6,
      'line.has_label': 0.4,
      'line.short_token_count': 0.2
    };

    const assigned = jointWindow.map(s => ({ ...s }));

    for (let i = 0; i < assigned.length; i++) {
      const cell = assigned[i]!;
      if (!cell || cell.boundary !== 'B') {
        if (cell) cell.entityType = 'Unknown';
        continue;
      }

      const feats = featuresPerLine[i] ?? {};
      let pScore = 0;
      let gScore = 0;

      for (const k of Object.keys(feats)) {
        pScore += (primaryWeights[k] ?? 0) * (feats[k] ?? 0);
        gScore += (guardianWeights[k] ?? 0) * (feats[k] ?? 0);
      }

      if ((feats['line.has_name'] ?? 0) > 0) pScore += 0.5;

      if (pScore >= 1.0 && pScore > gScore) cell.entityType = 'Primary';
      else if (gScore >= 0.8 && gScore >= pScore) cell.entityType = 'Guardian';
      else cell.entityType = 'Unknown';
    }

    // Post-process guardian attachment logic
    const MAX_DISTANCE = 3;
    for (let i = 0; i < assigned.length; i++) {
      const cell = assigned[i]!;
      if (!cell || cell.entityType !== 'Guardian') continue;

      let foundPrimary: number | null = null;
      for (let d = 1; d <= MAX_DISTANCE; d++) {
        const j = i - d;
        if (j < 0) break;
        const other = assigned[j]!;
        if (other && other.entityType === 'Primary') {
          foundPrimary = j;
          break;
        }
        if (other && other.boundary !== 'B') break;
      }

      if (foundPrimary === null) {
        for (let d = 1; d <= 1; d++) {
          const j = i + d;
          if (j >= assigned.length) break;
          const other = assigned[j]!;
          if (other && other.entityType === 'Primary') {
            foundPrimary = j;
            break;
          }
          if (other && other.boundary !== 'B') break;
        }
      }

      if (foundPrimary === null) cell.entityType = 'Unknown';
    }

    return assigned;
  }

  const jointAnnotatedWindow = !jointWindow.some(s => s && s.entityType !== undefined) ? annotateWindowEntityTypes() : jointWindow;

  // build offsets for file positions
  const offsets: number[] = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(off);
    off += (lines[i]?.length ?? 0) + 1;
  }

  const records: RecordSpan[] = [];

  for (let i = 0; i < jointAnnotatedWindow.length; i++) {
    if (jointAnnotatedWindow[i]!.boundary !== 'B') continue;

    let j = i + 1;
    while (j < jointAnnotatedWindow.length && jointAnnotatedWindow[j]!.boundary !== 'B') j++;

    const startLine = windowStartLine + i;
    const endLine = windowStartLine + j - 1;

    const subEntities: SubEntitySpan[] = [];

    for (let li = i; li <= j - 1; li++) {
      const globalLi = windowStartLine + li;
      const role = (jointAnnotatedWindow[li] && jointAnnotatedWindow[li]!.entityType)
        ? (jointAnnotatedWindow[li]!.entityType as SubEntityType)
        : 'Unknown';
      const spans = spansPerLine[globalLi]?.spans ?? [];

      if (role === 'Unknown') {
        let hasNonNoise = false;
        for (let si = 0; si < spans.length; si++) {
          const assignedLabel = (jointWindow[li] && jointWindow[li]!.fields && jointWindow[li]!.fields[si])
            ? jointWindow[li]!.fields[si]
            : undefined;
          if (assignedLabel !== undefined && assignedLabel !== schema.noiseLabel) {
            hasNonNoise = true;
            break;
          }
        }
        if (!hasNonNoise) continue;
      }

      const lineFields: FieldSpan[] = [];

      for (let si = 0; si < spans.length; si++) {
        const s = spans[si]!;
        const fileStart = offsets[globalLi]! + s.start;
        const fileEnd = offsets[globalLi]! + s.end;
        const text = lines[globalLi]?.slice(s.start, s.end) ?? '';
        const assignedLabel = (jointWindow[li] && jointWindow[li]!.fields && jointWindow[li]!.fields[si])
          ? jointWindow[li]!.fields[si]
          : undefined;

        // find candidate
        const cand = (spanCandidatesWindow[li] ?? [])[si];
        const confidence = cand && assignedLabel ? (cand.labelProbs ? (cand.labelProbs[assignedLabel] ?? 0) : undefined) : undefined;

        lineFields.push({
          lineIndex: globalLi,
          start: s.start,
          end: s.end,
          text,
          fileStart,
          fileEnd,
          fieldType: assignedLabel,
          confidence: confidence ?? 0.5
        });
      }

      // Enforce non-overlap among final assigned (non-NOISE) field spans.
      if (lineFields.length > 1) {
        const nonNoise = lineFields.filter(f => f.fieldType !== schema.noiseLabel);
        if (nonNoise.length > 1) {
          nonNoise.sort((a, b) => ((b.confidence ?? 0) - (a.confidence ?? 0)) || (a.start - b.start) || (b.end - a.end));
          const chosen: { start: number; end: number }[] = [];
          const keepSet = new Set<string>();
          const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => !(aEnd <= bStart || aStart >= bEnd);
          for (const f of nonNoise) {
            let ok = true;
            for (const c of chosen) {
              if (overlaps(f.start, f.end, c.start, c.end)) { ok = false; break }
            }
            if (ok) {
              chosen.push({ start: f.start, end: f.end });
              keepSet.add(`${f.start}:${f.end}`);
            }
          }
          const rebuilt = lineFields.filter(f => (f.fieldType === schema.noiseLabel) || keepSet.has(`${f.start}:${f.end}`));
          rebuilt.sort((a, b) => a.start - b.start || a.end - b.end);
          // @ts-ignore
          lineFields.length = 0;
          for (const rf of rebuilt) lineFields.push(rf);
        }
      }

      const last = subEntities[subEntities.length - 1];

      const nonNoiseFields = lineFields.filter(f => f.fieldType !== schema.noiseLabel)
      const lineHasFields = nonNoiseFields.length > 0
      const lineMinStart = lineHasFields ? Math.min(...nonNoiseFields.map(f => f.fileStart)) : (offsets[globalLi] ?? 0)
      const lineMaxEnd = lineHasFields ? Math.max(...nonNoiseFields.map(f => f.fileEnd)) : ((offsets[globalLi] ?? 0) + (lines[globalLi]?.length ?? 0))

      if (last && last.entityType === role) {
        last.endLine = globalLi;
        last.fileEnd = lineHasFields ? Math.max(last.fileEnd ?? 0, lineMaxEnd) : ((offsets[globalLi] ?? 0) + (lines[globalLi]?.length ?? 0));
        if (lineHasFields) last.fileStart = Math.min(last.fileStart ?? lineMinStart, lineMinStart);

        for (const f of lineFields) last.fields.push(f);
      } else {
        const fileStart = lineHasFields ? lineMinStart : (offsets[globalLi] ?? 0);
        const fileEnd = lineHasFields ? lineMaxEnd : ((offsets[globalLi] ?? 0) + (lines[globalLi]?.length ?? 0));
        subEntities.push({ startLine: globalLi, endLine: globalLi, fileStart, fileEnd, entityType: role, fields: lineFields });
      }
    }

    // Prefer precise feedback file offsets for aggregated sub-entities when available.
    function spansOverlap(aStart?: number, aEnd?: number, bStart?: number, bEnd?: number) {
      if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) return false
      return !(aEnd <= bStart || aStart >= bEnd)
    }

    const recFileStart = offsets[startLine] ?? 0;
    const recFileEnd = (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0);

    if (feedbackEntities && feedbackEntities.length > 0) {
      for (const fb of feedbackities) {
        if (fb.fileStart === undefined || fb.fileEnd === undefined || fb.entityType === undefined) continue
        for (const se of subEntities) {
          if (!spansOverlap(se.fileStart, se.fileEnd, fb.fileStart, fb.fileEnd)) continue

          se.fileStart = fb.fileStart
          se.fileEnd = fb.fileEnd
          se.entityType = fb.entityType as SubEntityType

          const offsetToLine = (off: number) => {
            if (offsets.length === 0) return 0
            if (off < offsets[0]!) return 0
            const lastIdx = offsets.length - 1
            if (off >= offsets[lastIdx]!) return lastIdx
            let lo = 0, hi = lastIdx
            while (lo < hi) {
              const mid = Math.floor((lo + hi + 1) / 2)
              if ((offsets[mid] ?? 0) <= off) lo = mid
              else hi = mid - 1
            }
            return lo
          }
          se.startLine = offsetToLine(se.fileStart)
          se.endLine = offsetToLine(Math.max(0, se.fileEnd - 1))

          if (se.fileStart < recFileStart) se.fileStart = recFileStart
          if (se.fileEnd > recFileEnd) se.fileEnd = recFileEnd
        }
      }
    }

    for (const se of subEntities) {
      if (se.fileStart < recFileStart) se.fileStart = recFileStart
      if (se.fileEnd > recFileEnd) se.fileEnd = recFileEnd

      se.fields = (se.fields ?? []).filter(f => (f.fileStart ?? 0) >= (se.fileStart ?? 0) && (f.fileEnd ?? 0) <= (se.fileEnd ?? 0))

      for (const f of se.fields) {
        f.entityStart = f.fileStart - (se.fileStart ?? 0);
        f.entityEnd = f.fileEnd - (se.fileStart ?? 0);
      }
    }

    const fileStart = offsets[startLine] ?? 0;
    const fileEnd = (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0);

    records.push({ startLine, endLine, fileStart, fileEnd, subEntities });
  }

  return records;
}
