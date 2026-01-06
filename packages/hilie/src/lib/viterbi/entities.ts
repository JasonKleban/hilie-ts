import type {
  Feature,
  FeatureContext,
  FieldLabel,
  FieldSchema,
  FieldSpan,
  JointSequence,
  LineSpans,
  RecordSpan,
  SubEntitySpan,
  SubEntityType
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

    const subEntities: SubEntitySpan[] = [];

    for (let li = startLine; li <= endLine; li++) {
      const role = (jointLocal[li] && jointLocal[li]!.entityType)
        ? (jointLocal[li]!.entityType as SubEntityType)
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

      const last = subEntities[subEntities.length - 1];
      if (last && last.entityType === role) {
        last.endLine = li;
        last.fileEnd = (offsets[li] ?? 0) + (lines[li]?.length ?? 0);
        for (const f of lineFields) last.fields.push(f);
      } else {
        const fileStart = offsets[li] ?? 0;
        const fileEnd = (offsets[li] ?? 0) + (lines[li]?.length ?? 0);
        subEntities.push({ startLine: li, endLine: li, fileStart, fileEnd, entityType: role, fields: lineFields });
      }
    }

    for (const se of subEntities) {
      const recFileStart = offsets[startLine] ?? 0;
      for (const f of se.fields) {
        f.entityStart = f.fileStart - recFileStart;
        f.entityEnd = f.fileEnd - recFileStart;
      }
    }

    const fileStart = offsets[startLine] ?? 0;
    const fileEnd = (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0);

    records.push({ startLine, endLine, fileStart, fileEnd, subEntities });
  }

  return records;
}
