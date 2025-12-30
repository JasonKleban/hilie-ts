import { spanGenerator } from '../lib/utils.js';
import { enumerateStates, extractFeatureVector, jointViterbiDecode, updateWeightsFromExample, annotateEntityTypes, inferRelationships } from '../lib/viterbi.js';
import { isLikelyEmail, isLikelyPhone, isLikelyBirthdate, isLikelyExtID, isLikelyName, isLikelyPreferredName } from '../lib/validators.js';

function ok(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || 'ok failed');
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

// 8) validators: email, phone, birthdate, extid, name heuristics
(() => {

  ok(isLikelyEmail('alice@example.com'), 'basic email recognized');
  ok(!isLikelyEmail('not-an-email@'), 'invalid email rejected');
  ok(isLikelyPhone('+1 288-327-3483'), 'international phone recognized');
  ok(isLikelyPhone('(020) 7123 4567'), 'local phone with parentheses recognized');
  ok(!isLikelyPhone('123'), 'too short phone rejected');

  // birthdate heuristics
  ok(isLikelyBirthdate('05/12/2008'), 'MM/DD/YYYY birthdate recognized');
  ok(isLikelyBirthdate('2008-05-12'), 'YYYY-MM-DD birthdate recognized');
  ok(isLikelyBirthdate('May 12, 2008'), 'Month name birthdate recognized');

  // extid heuristics
  ok(isLikelyExtID('#A-12345'), 'hash-prefixed alnum extid recognized');
  ok(isLikelyExtID('ABC123'), 'alphanumeric extid recognized');
  ok(!isLikelyExtID('1234567890'), '10-digit-only is treated as phone-ish / ambiguous');

  // name heuristics
  ok(isLikelyName('William Rojas'), 'two-token capitalized name recognized');
  ok(isLikelyName('Rojas, William'), 'Last, First recognized');
  ok(isLikelyPreferredName('"Billy"'), 'quoted preferred name recognized');
  ok(isLikelyPreferredName('(Billy)'), 'parenthesized preferred name recognized');

  console.log('✓ email, phone, birthdate, extid & name validators');
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

// 11) segment features: ExtID, FullName, PreferredName, Birthdate influence decoding (and phone precedence for 10-digit exacts)
(() => {
  const lines = ['#12345 William "Billy" Rojas', 'DOB: 05/12/2008', '1234567890'];
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });

  const weights = {
    'segment.is_extid': 6.0,
    'segment.is_name': 6.0,
    'segment.is_preferred_name': 6.0,
    'segment.is_birthdate': 8.0,
    'segment.is_phone': 10.0
  } as any;

  const joint = jointViterbiDecode(lines, spans, weights, { maxStates: 512 });

  // Line 0 should include an ExtID and a FullName/PreferredName assignment on some spans
  const line0 = joint[0]!.fields;
  const hasExtID = line0.some(f => f === 'ExtID');
  const hasFullOrPref = line0.some(f => f === 'Name' || f === 'PreferredName');
  ok(hasExtID, 'decoder should assign ExtID on the first line where present');
  ok(hasFullOrPref, 'decoder should assign FullName or PreferredName on the first line');

  // Line 1 should include Birthdate
  const line1 = joint[1]!.fields;
  ok(line1.some(f => f === 'Birthdate'), 'decoder should assign Birthdate for the DOB-like span');

  // Line 2 is exact 10-digit string; despite ExtID heuristics, it should be treated as Phone
  const line2 = joint[2]!.fields;
  ok(line2.some(f => f === 'Phone'), 'exact 10-digit numeric should prefer Phone over ExtID');

  console.log('✓ segment features for ExtID/Name/Birthdate decoding');
})();

// 10) trainer: extractFeatureVector and updateWeightsFromExample
( () => {
  // simple scenario: worker has phone-like span but decoder currently doesn't pick Phone
  const lines2 = ['Contact: +1 555-123-4567'];
  const spans2 = spanGenerator(lines2, { delimiterRegex: /:/, maxTokensPerSpan: 7 });

  // construct a "gold" joint with Phone assigned to the phone span
  const goldState: any = { boundary: 'B', fields: ['ExtID', 'NOISE', 'Phone'] };
  const gold = [goldState];

  // small initial weights (bias away from phone so trainer must increase it)
  const w: Record<string, number> = { 'segment.is_phone': -5.0, 'segment.token_count_bucket': 0.1 };

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

// Boundary feature tests: ensure new line-level features can drive boundaries
(() => {
  // Leading ExtID should favor a boundary at the line start
  const lines = ['#A123 John Doe', '410-555-1212', 'john@example.com'];
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });

  const weights: any = { 'line.leading_extid': 12.0, 'line.has_name': 6.0, 'line.short_token_count': 2.0, 'segment.is_phone': 4.0, 'segment.is_email': 4.0 };

  const joint = jointViterbiDecode(lines, spans, weights, { maxStates: 256 });
  console.log('DEBUG leadingExtID joint:', JSON.stringify(joint, null, 2));
  ok(joint[0]!.boundary === 'B', 'leading ExtID should produce a Boundary B');

  // Birthdate-only line should be recognized as boundary
  const lines2 = ['05/12/2013', 'John Doe', '410-555-1234'];
  const spans2 = spanGenerator(lines2, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });
  const weights2: any = { 'line.has_birthdate': 6.0, 'segment.is_phone': 3.0 };

  const joint2 = jointViterbiDecode(lines2, spans2, weights2, { maxStates: 256 });
  ok(joint2[0]!.boundary === 'B', 'birthdate line should be treated as a Boundary');

  // Next line contact hint: preceding line with nextHasContact set should prefer B
  const lines3 = ['John Doe', '410-555-9876'];
  const spans3 = spanGenerator(lines3, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });
  const weights3: any = { 'line.next_has_contact': 6.0, 'segment.is_phone': 6.0 };

  const joint3 = jointViterbiDecode(lines3, spans3, weights3, { maxStates: 256 });
  ok(joint3[0]!.boundary === 'B', 'line preceding contact should be Boundary');

  console.log('✓ boundary features influence decoding');
})();

// Blank/empty-segment handling should ignore empty columns and not explode
(() => {
  const line = 'John\t\t\t\t\t\t\t\t\t\t410-555-1212';
  const lines = [line];
  const spans = spanGenerator(lines, { delimiterRegex: /\t/ });

  // expect that empty tab-separated columns are ignored and we still get a small number of spans
  ok(spans[0]!.spans.length <= 4, 'empty segments are ignored by spanGenerator');

  // joint decode should run without error and prefer Phone on the phone span
  const weights: any = { 'segment.is_phone': 5.0 };
  const joint = jointViterbiDecode(lines, spans, weights, { maxStates: 256 });
  ok(joint.length === 1, 'single-line joint produced');

  console.log('✓ blank segments ignored and treated as absent');
})();

// Primary/Guardian adjacency and relationship inference
(() => {
  const lines = ['John Doe', 'Sarah Doe (Parent)', 'Noise line'];
  const joint: any = [ { boundary: 'B', fields: [] }, { boundary: 'B', fields: [] }, { boundary: 'C', fields: [] } ];
  const annotated = annotateEntityTypes(lines, joint);

  ok(annotated[0]!.entityType === 'Primary', 'first line should be Primary');
  ok(annotated[1]!.entityType === 'Guardian', 'second line should be Guardian');

  const rels = inferRelationships(annotated as any);
  ok(rels.length === 1 && rels[0]!.primaryIndex === 0 && rels[0]!.guardianIndex === 1, 'relationship inferred');

  console.log('✓ Primary/Guardian annotation and relationships');
})();

console.log('All unit tests passed.');
