import { spanGenerator } from '../lib/utils.js';
import { decodeJointSequence, updateWeightsFromUserFeedback } from '../lib/viterbi.js';

function ok(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || 'ok failed');
}

// Edge-case: removal feedback when detectors don't activate on broad span should still
// apply a deterministic negative update (tightening heuristics or fallback nudging).
(() => {
  const lines = ['Random text not detected as phone or email'];
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });

  // ensure no phone-like substrings exist
  const raw = lines[0]!;
  if (/\d{3}/.test(raw)) throw new Error('test precondition violated: contains digits');

  const w: any = { 'segment.is_phone': 0.0, 'segment.token_count_bucket': 0.1 };
  const predBefore = decodeJointSequence(lines, spans, w, { maxStates: 64 });

  // Sanity: predBefore should NOT include Phone (detectors didn't trigger)
  ok(!predBefore[0]!.fields.includes('Phone'), 'sanity: broad predBefore should not include Phone');

  const feedback = { entities: [ { startLine: 0, fields: [ { lineIndex: 0, start: 0, end: raw.length, fieldType: 'Phone', confidence: 1.0, action: 'remove' } ] } ] } as any;

  const before = { ...w };
  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, w, 1.0, { maxStates: 64 });

  // Expect at least the phone detector weight to decrease deterministically
  ok((w['segment.is_phone'] ?? 0) < (before['segment.is_phone'] ?? 0), 'feedback remove should decrease phone weight deterministically');

  // And prediction should not include Phone (removed)
  ok(!res.pred[0]!.fields.includes('Phone'), 'after removal prediction should not include Phone');

  console.log('✓ feedback remove edge-case applies deterministic negative update');
})();
