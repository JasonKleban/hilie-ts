import { spanGenerator } from '../lib/utils.js';
import { decodeFullViaStreaming, updateWeightsFromUserFeedback } from '../lib/viterbi.js';
import { boundaryFeatures, segmentFeatures } from '../lib/features.js';
import { householdInfoSchema } from './test-helpers.js';

declare const test: any;

const schema = householdInfoSchema;
const bFeatures = boundaryFeatures;
const sFeatures = segmentFeatures;

function ok(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || 'ok failed');
}

test('removal-edgecase deterministic negative update', () => {
  const lines = ['Plain sample text with no contact info'];
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });

  // ensure no phone-like substrings exist
  const raw = lines[0]!;
  if (/\d{3}/.test(raw)) throw new Error('test precondition violated: contains digits');

  const w: any = { 'segment.is_phone': 0.0, 'segment.token_count_bucket': 0.1 };
  const predBefore = decodeFullViaStreaming(lines, spans, w, schema, bFeatures, sFeatures, { lookaheadLines: lines.length, enumerateOpts: { maxStates: 64 } });



  const feedback = { entries: [ { kind: 'field', field: { lineIndex: 0, start: 0, end: raw.length, fieldType: 'Phone', confidence: 1.0, action: 'remove' } } ] } as any;

  const before = { ...w };
  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, w, bFeatures, sFeatures, schema, 1.0, { maxStates: 64 });

  // Expect at least the phone detector weight to decrease deterministically
  ok((w['segment.is_phone'] ?? 0) < (before['segment.is_phone'] ?? 0), 'feedback remove should decrease phone weight deterministically');

  // And prediction should not include Phone (removed)
  const pred = res.pred
  if (Array.isArray(pred) && pred.length > 0 && ('startLine' in (pred as any)[0])) {
    const foundPhone = (pred as any[]).some(r => (r.subEntities ?? []).some((se: any) => (se.fields ?? []).some((f: any) => f.fieldType === 'Phone')))
    ok(!foundPhone, 'after removal prediction should not include Phone')
  } else {
    ok(!((res.pred as any)[0]?.fields?.includes('Phone')), 'after removal prediction should not include Phone')
  }


});


