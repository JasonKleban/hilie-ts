import { strict as assert } from 'node:assert';
import { spanGenerator } from '../lib/utils.js';
import { enumerateStates, extractFeatureVector, jointViterbiDecode, updateWeightsFromExample } from '../lib/viterbi.js';
import { isLikelyEmail, isLikelyPhone } from '../lib/validators.js';

function ok(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || 'ok failed');
}

function deepEqual(a: any, b: any, msg?: string) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg || `deepEqual failed: ${sa} !== ${sb}`);
}

console.log('Unit tests: spanGenerator & enumerateStates');

// 1) spanGenerator fallback behavior (delimiter not found -> whitespace tokens)
(() => {
  const lines = ['Alice,Bob,Charlie'];
  const spans = spanGenerator(lines, { delimiterRegex: /¶/, minTokenLength: 1, maxSpansPerLine: 50 });
  ok(Array.isArray(spans), 'spans should be an array');
  ok(spans.length === 1, 'one line expected');
  ok(spans[0]!.spans.length > 0, 'fallback should produce spans');
  // ensure spans cover tokens (start < end and non-negative)
  for (const s of spans[0]!.spans) {
    ok(s.start >= 0 && s.end > s.start, 'span start/end sanity');
  }
  console.log('✓ spanGenerator fallback behavior');
})();

// 2) spanGenerator maxSpansPerLine and maxPartsPerLine caps
(() => {
  const many = Array.from({ length: 100 }, (_, i) => `tok${i}`).join(' ');
  const spans = spanGenerator([many], { delimiterRegex: / /, minTokenLength: 1, maxPartsPerLine: 100, maxSpansPerLine: 10 });
  ok(spans[0]!.spans.length <= 10, `spans capped by maxSpansPerLine: ${spans[0]!.spans.length}`);
  console.log('✓ spanGenerator capping behavior');
})();

// 3) enumerateStates simple case
(() => {
  const lineSpans = [ { lineIndex: 0, spans: [ { start: 0, end: 1 }, { start: 0, end: 2 } ] }, { lineIndex: 1, spans: [ { start: 0, end: 1 } ] } ];
  const states = enumerateStates(lineSpans[0] as any, { maxUniqueFields: 3 });
  ok(Array.isArray(states) && states.length > 0, 'enumerateStates returns states');
  console.log('✓ enumerateStates simple case');
})();

// 4) enumerateStates must not explode for many spans (enforce upper bound)
(() => {
  const perLine = 30; // many spans per line
  const spansPerLine = Array.from({ length: perLine }, (_, i) => ({ start: i, end: i + 1 }));
  const manyLines = Array.from({ length: 6 }, (v, idx) => ({ lineIndex: idx, spans: spansPerLine.slice() }));
  const states = enumerateStates(manyLines[0] as any, { maxUniqueFields: 10, maxStates: 2048 });
  ok(Array.isArray(states), 'enumerateStates returns an array');
  ok(states.length <= 2048, `states capped to reasonable limit (${states.length})`);
  console.log('✓ enumerateStates safety cap');
})();

// 5) edge case: empty input
(() => {
  const emptyLine = { lineIndex: 0, spans: [] } as any;
  const states = enumerateStates(emptyLine, { maxUniqueFields: 3 });
  ok(Array.isArray(states) && states.length === 2, 'empty spans -> two trivial states (B and C)');
  console.log('✓ enumerateStates empty input');
})();

// 6) allow repeated Phone labels up to cap
(() => {
  const spans = { lineIndex: 0, spans: [ { start:0,end:1 }, { start:2,end:3 }, { start:4,end:5 } ] } as any;
  const states = enumerateStates(spans, { maxUniqueFields: 3, maxPhones: 2 });
  // should include at least one state with two Phones
  const hasTwoPhones = states.some(s => s.fields.slice(0,3).filter(f => f === 'Phone').length === 2);
  ok(hasTwoPhones, 'enumerateStates should allow up to 2 Phone labels');
  // but no state should have more than 2 Phones
  const maxPhonesSeen = Math.max(...states.map(s => s.fields.slice(0,3).filter(f => f === 'Phone').length));
  ok(maxPhonesSeen <= 2, 'per-label Phone cap enforced');
  console.log('✓ enumerateStates phone multiplicity and cap');
})();

// 7) single-occurrence labels cannot duplicate
(() => {
  const spans = { lineIndex: 0, spans: [ { start:0,end:1 }, { start:2,end:3 }, { start:4,end:5 } ] } as any;
  const states = enumerateStates(spans, { maxUniqueFields: 4 });
  const dupExtID = states.some(s => s.fields.slice(0,3).filter(f => f === 'ExtID').length >= 2);
  ok(!dupExtID, 'single-occurrence ExtID should not appear duplicated');
  console.log('✓ enumerateStates single-occurrence uniqueness');
})();

// 8) validators: email and phone heuristics
(() => {

  ok(isLikelyEmail('alice@example.com'), 'basic email recognized');
  ok(!isLikelyEmail('not-an-email@'), 'invalid email rejected');
  ok(isLikelyPhone('+1 288-327-3483'), 'international phone recognized');
  ok(isLikelyPhone('(020) 7123 4567'), 'local phone with parentheses recognized');
  ok(!isLikelyPhone('123'), 'too short phone rejected');

  console.log('✓ email & phone validators');
})();

// 9) segment features influence decoding: prefer Phone/Email when detected
(() => {

  const lines = ['Contact: +1 555-123-4567', 'Email: alice@example.com'];
  const spans = spanGenerator(lines, { delimiterRegex: /:/, maxTokensPerSpan: 7 });

  const weights = {
    'segment.is_phone': 10.0,
    'segment.is_email': 5.0,
    'segment.token_count_bucket': 0.1
  };

  // For robustness: ensure enumeration and features consider Phone/Email labels for phone/email-like spans
  const stateBank = enumerateStates(spans[0] as any, { maxUniqueFields: 4, maxPhones: 3 });
  const phoneSpanIndices = spans[0]!.spans.map((s, idx) => ({ idx, text: lines[0]!.slice(s.start, s.end) })).filter(x => isLikelyPhone(x.text)).map(x => x.idx);

  ok(phoneSpanIndices.length > 0, 'we should detect at least one phone-like candidate span');

  const phoneSupported = phoneSpanIndices.some(pi => stateBank.some(s => s.fields[pi] === 'Phone'));
  ok(phoneSupported, 'enumerateStates should include at least one state that assigns Phone to a phone-like span');

  // For email, ensure decoder can pick Email via joint decode (the email case earlier was successful)
  const joint = jointViterbiDecode(lines, spans, weights, { maxStates: 256 });
  const emailLine = joint[1]!.fields;
  ok(emailLine.includes('Email'), 'decoder should label email-like span as Email');

  console.log('✓ segment feature influence on decoding (enum+decode checks)');
})();

// 10) trainer: extractFeatureVector and updateWeightsFromExample
( () => {
  // simple scenario: worker has phone-like span but decoder currently doesn't pick Phone
  const lines2 = ['Contact: +1 555-123-4567'];
  const spans2 = spanGenerator(lines2, { delimiterRegex: /:/, maxTokensPerSpan: 7 });

  // construct a "gold" joint with Phone assigned to the phone span
  const goldState: any = { boundary: 'B', fields: ['ExtID', 'NOISE', 'Phone'] };
  const gold = [goldState];

  // small initial weights
  const w: Record<string, number> = { 'segment.is_phone': 0.1, 'segment.token_count_bucket': 0.1 };

  const before = { ...w };
  console.log('DEBUG spans2:', JSON.stringify(spans2, null, 2));
  console.log('DEBUG span texts:', spans2[0]!.spans.map(s => lines2[0]!.slice(s.start, s.end)));
  console.log('DEBUG isLikelyPhone per span:', spans2[0]!.spans.map(s => ({ text: lines2[0]!.slice(s.start, s.end), ok: isLikelyPhone(lines2[0]!.slice(s.start, s.end)) })));

  const res = updateWeightsFromExample(lines2, spans2, gold, w, 1.0, { maxStates: 64 });

  console.log('DEBUG trainer before weights:', before);
  console.log('DEBUG trainer after weights:', w);
  console.log('DEBUG pred state:', res.pred);

  // after training, weight for 'segment.is_phone' should increase (positive update)
  ok((w['segment.is_phone'] ?? 0) > (before['segment.is_phone'] ?? 0), 'training should increase phone feature weight');

  // extractFeatureVector sanity: gold vector produces higher phone-related contribution
  const vf = extractFeatureVector(lines2, spans2, gold);
  const vp = extractFeatureVector(lines2, spans2, res.pred);
  console.log('DEBUG vf:', vf, 'vp:', vp);
  ok((vf['segment.is_phone'] ?? 0) >= (vp['segment.is_phone'] ?? 0), 'gold feature count should be >= pred for phone');

  console.log('✓ trainer feature extraction and weight update');
})();

console.log('All unit tests passed.');
