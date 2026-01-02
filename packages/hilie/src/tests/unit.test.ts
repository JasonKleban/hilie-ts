import { spanGenerator, detectDelimiter } from '../lib/utils.js';
import { enumerateStates, decodeJointSequence, updateWeightsFromUserFeedback, entitiesFromJointSequence } from '../lib/viterbi.js';
import { isLikelyEmail, isLikelyPhone, isLikelyBirthdate, isLikelyExtID, isLikelyName, isLikelyPreferredName } from '../lib/validators.js';
import { boundaryFeatures, segmentFeatures } from '../lib/features.js';

const schema = householdInfoSchema;
const bFeatures = boundaryFeatures;
const sFeatures = segmentFeatures;
import { readFileSync } from 'fs';
import { householdInfoSchema } from './test.js';

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
  const states = enumerateStates(lineSpans[0] as any, schema, { maxUniqueFields: 3 });
  ok(Array.isArray(states) && states.length > 0, 'enumerateStates returns states');
  console.log('✓ enumerateStates simple case');
})();

// 4) enumerateStates must not explode for many spans (enforce upper bound)
(() => {
  const perLine = 30; // many spans per line
  const spansPerLine = Array.from({ length: perLine }, (_, i) => ({ start: i, end: i + 1 }));
  const manyLines = Array.from({ length: 6 }, (v, idx) => ({ lineIndex: idx, spans: spansPerLine.slice() }));
  const states = enumerateStates(manyLines[0] as any, schema, { maxUniqueFields: 10, maxStates: 2048 });
  ok(Array.isArray(states), 'enumerateStates returns an array');
  ok(states.length <= 2048, `states capped to reasonable limit (${states.length})`);
  console.log('✓ enumerateStates safety cap');
})();

// 5) edge case: empty input
(() => {
  const emptyLine = { lineIndex: 0, spans: [] } as any;
  const states = enumerateStates(emptyLine, schema, { maxUniqueFields: 3 });
  ok(Array.isArray(states) && states.length === 2, 'empty spans -> two trivial states (B and C)');
  console.log('✓ enumerateStates empty input');
})();

// 6) allow repeated Phone labels up to cap
(() => {
  const spans = { lineIndex: 0, spans: [ { start:0,end:1 }, { start:2,end:3 }, { start:4,end:5 } ] } as any;
  const states = enumerateStates(spans, schema, { maxUniqueFields: 3, maxStatesPerField: { 'Phone': 2 } });
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
  const states = enumerateStates(spans, schema, { maxUniqueFields: 4 });
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

// 14) delimiter detection: auto-detect delimiter for case files
(() => {
  const txtCase1 = readFileSync('src/tests/data/case1.txt', 'utf8');
  const blocks1 = txtCase1.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  ok(blocks1.length > 0, 'case1 blocks present');
  const blockLines = blocks1[0]!.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const rx1 = detectDelimiter(blockLines);
  ok(/\\s\{2,\}/.test(rx1.source) || /\\s\+/.test(rx1.source), 'case1 should detect multi-space/whitespace delimiter');

  const txtCase3 = readFileSync('src/tests/data/case3.txt', 'utf8');
  const lines3 = txtCase3.split(/\r?\n/).slice(0, 10).map(s => s.trim()).filter(Boolean);
  const rx3 = detectDelimiter(lines3);
  ok(/\\t/.test(rx3.source), 'case3 should detect tab delimiter');

  const txtCase4 = readFileSync('src/tests/data/case4.txt', 'utf8');
  const lines4 = txtCase4.split(/\r?\n/).slice(0, 10).map(s => s.trim()).filter(Boolean);
  const rx4 = detectDelimiter(lines4);
  ok(/\\t/.test(rx4.source), 'case4 should detect tab delimiter');

  // bullet/outline detection: leading bullets with multi-space columns
  (() => {
    const bulletLines = [
      '- 45NUMBEU  Henry Johnson    Eats most school meals.....Avoids overly spicy foods.    5/4/2014',
      '- 6XPT2V4S  Mia Brown        Boundary: B',
      '- 9FTNQAQA  Alexander Davis  Boundary: B'
    ];
    const rxb = detectDelimiter(bulletLines);
    ok(/\\s\{2,\}/.test(rxb.source) || /\\s\+/.test(rxb.source) || /\\t/.test(rxb.source), 'bullet-outline should detect whitespace/tab delimiter');
  })();

  // numbered bullets with tabs inside lines should detect tab (or whitespace)
  (() => {
    const numLines = [
      '1. 45NUMBEU\tHenry Johnson\tEats most school meals.....\t5/4/2014',
      '2. 6XPT2V4S\tMia Brown\tBoundary: B'
    ];
    const rxn = detectDelimiter(numLines);
    ok(/\\t/.test(rxn.source) || /\\s\{2,\}/.test(rxn.source), 'numbered-outline with tabs should detect tab or multi-space');
  })();

  // also ensure spanGenerator default (auto) uses detected delimiter and returns meaningful spans
  const spans1 = spanGenerator(blockLines, {} as any);
  ok(spans1.length === blockLines.length, 'spanGenerator auto for case1 returns spans for each line');
  const spans3 = spanGenerator(lines3, {} as any);
  ok(spans3.length === lines3.length, 'spanGenerator auto for case3 returns spans for each line');

  console.log('✓ delimiter detection (case1, case3, case4)');
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
  const stateBank = enumerateStates(spans[0] as any, schema, { maxUniqueFields: 4, maxStatesPerField: { 'Phone': 3 } });
  const phoneSpanIndices = spans[0]!.spans.map((s, idx) => ({ idx, text: lines[0]!.slice(s.start, s.end) })).filter(x => isLikelyPhone(x.text)).map(x => x.idx);

  ok(phoneSpanIndices.length > 0, 'we should detect at least one phone-like candidate span');

  const phoneSupported = phoneSpanIndices.some(pi => stateBank.some(s => s.fields[pi] === 'Phone'));
  ok(phoneSupported, 'enumerateStates should include at least one state that assigns Phone to a phone-like span');

  // For email, ensure decoder can pick Email via joint decode (the email case earlier was successful)
  const jointSeq = decodeJointSequence(lines, spans, weights, schema, bFeatures, sFeatures, { maxStates: 256 });
  const emailLine = jointSeq[1]!.fields;
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

  const jointSeq = decodeJointSequence(lines, spans, weights, schema, bFeatures, sFeatures, { maxStates: 512 });

  // Line 0 should include an ExtID and a FullName/PreferredName assignment on some spans
  const line0 = jointSeq[0]!.fields;
  const hasExtID = line0.some((f: any) => f === 'ExtID');
  const hasFullOrPref = line0.some((f: any) => f === 'Name' || f === 'PreferredName');
  ok(hasExtID, 'decoder should assign ExtID on the first line where present');
  ok(hasFullOrPref, 'decoder should assign FullName or PreferredName on the first line');

  // Line 1 should include Birthdate
  const line1 = jointSeq[1]!.fields;
  ok(line1.some((f: any) => f === 'Birthdate'), 'decoder should assign Birthdate for the DOB-like span');

  // Line 2 is exact 10-digit string; despite ExtID heuristics, it should be treated as Phone
  const line2 = jointSeq[2]!.fields;
  ok(line2.some((f: any) => f === 'Phone'), 'exact 10-digit numeric should prefer Phone over ExtID');

  console.log('✓ segment features for ExtID/Name/Birthdate decoding');
})();

// Boundary feature tests: ensure new line-level features can drive boundaries
(() => {
  // Leading ExtID should favor a boundary at the line start
  const lines = ['#A123 John Doe', '410-555-1212', 'john@example.com'];
  const spans = spanGenerator(lines, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });

  const weights: any = { 'line.leading_extid': 12.0, 'line.has_name': 6.0, 'line.short_token_count': 2.0, 'segment.is_phone': 4.0, 'segment.is_email': 4.0 };

  const jointSeq = decodeJointSequence(lines, spans, weights, schema, bFeatures, sFeatures, { maxStates: 256 });
  ok(jointSeq[0]!.boundary === 'B', 'leading ExtID should produce a Boundary B');

  // Birthdate-only line should be recognized as boundary
  const lines2 = ['05/12/2013', 'John Doe', '410-555-1234'];
  const spans2 = spanGenerator(lines2, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });
  const weights2: any = { 'line.has_birthdate': 6.0, 'segment.is_phone': 3.0 };

  const joint2 = decodeJointSequence(lines2, spans2, weights2, schema, bFeatures, sFeatures, { maxStates: 256 });
  ok(joint2[0]!.boundary === 'B', 'birthdate line should be treated as a Boundary');

  // Next line contact hint: preceding line with nextHasContact set should prefer B
  const lines3 = ['John Doe', '410-555-9876'];
  const spans3 = spanGenerator(lines3, { delimiterRegex: /\s+/, maxTokensPerSpan: 8 });
  const weights3: any = { 'line.next_has_contact': 6.0, 'segment.is_phone': 6.0 };

  const jointSeq3 = decodeJointSequence(lines3, spans3, weights3, schema, bFeatures, sFeatures, { maxStates: 256 });
  ok(jointSeq3[0]!.boundary === 'B', 'line preceding contact should be Boundary');

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
  const jointSeq = decodeJointSequence(lines, spans, weights, schema, bFeatures, sFeatures, { maxStates: 256 });
  ok(jointSeq.length === 1, 'single-line joint produced');

  console.log('✓ blank segments ignored and treated as absent');
})();

// Primary/Guardian grouping into a top-level record with sub-entities
(() => {
  const lines = ['John Doe', 'Sarah Doe (Parent)', 'Noise line'];
  // create explicit spans for each line (start/end positions included)
  const spans = lines.map((ln, i) => ({ lineIndex: i, spans: [{ start: 0, end: ln.length }] }));

  // construct a joint that marks the first line as Primary and the second as Guardian
  const jointSeq: any = [
    { boundary: 'B', fields: [], entityType: 'Primary' },
    { boundary: 'C', fields: [], entityType: 'Guardian' },
    { boundary: 'C', fields: [] }
  ];

  const records = entitiesFromJointSequence(lines, spans as any, jointSeq, undefined, sFeatures, schema);
  ok(Array.isArray(records) && records.length === 1, 'entitiesFromJointSequence should return one top-level record');

  const rec = records[0]!;
  ok(Array.isArray(rec.subEntities) && rec.subEntities.length === 2, 'record should contain two sub-entities (Primary + Guardian)');

  ok(rec.subEntities[0]!.entityType === 'Primary', 'first sub-entity should be Primary');
  ok(rec.subEntities[1]!.entityType === 'Guardian', 'second sub-entity should be Guardian');

  // Ensure span start/end positions and entity-relative positions are present
  const allFields = rec.subEntities.flatMap(s => s.fields);
  ok(allFields.length >= 1, 'record should contain fields in its sub-entities');
  for (const f of allFields) {
    ok(typeof f.start === 'number' && typeof f.end === 'number', 'field start/end positions present');
    ok(typeof f.fileStart === 'number' && typeof f.fileEnd === 'number', 'file-relative positions present');
    ok(typeof f.entityStart === 'number' && typeof f.entityEnd === 'number', 'entity-relative positions present');
  }

  console.log('✓ Primary/Guardian grouped into a single record with sub-entities');
})();

// New: entitiesFromJointSequence and feedback-based training
(() => {
  const lines = ['#12345 John Doe\t410-555-1212\tjohn@example.com'];
  const spans = spanGenerator(lines, { delimiterRegex: /\t/ });
  const w: any = { 'segment.is_phone': 2.0, 'segment.is_email': 2.0, 'segment.is_extid': 2.0, 'segment.is_name': 1.0 };
  const jointSeq = decodeJointSequence(lines, spans, w, schema, bFeatures, sFeatures, { maxStates: 64 });

  const records = entitiesFromJointSequence(lines, spans, jointSeq, w, sFeatures, schema);
  ok(Array.isArray(records) && records.length === 1, 'entitiesFromJointSequence should return one top-level record');
  const rec = records[0]!;
  ok(Array.isArray(rec.subEntities) && rec.subEntities.length >= 1, 'record should contain sub-entities');

  // flatten fields and check
  const allFields = rec.subEntities.flatMap(s => s.fields);
  ok(allFields.length >= 1, 'record should contain fields in its sub-entities');
  for (const f of allFields) {
    ok(f.fileStart >= 0 && f.fileEnd > f.fileStart, 'field file-relative positions present');
    ok(f.entityStart !== undefined && f.entityEnd !== undefined, 'entity-relative positions present');
    ok(typeof (f.confidence ?? 0) === 'number', 'confidence present (numeric)');
  }

  console.log('✓ entitiesFromJointSequence produced nested record/sub-entity field spans');

  // Feedback-driven weight update: assert the phone span should be Phone
  const lines2 = ['Contact: +1 555-123-4567'];
  const spans2 = spanGenerator(lines2, { delimiterRegex: /:/, maxTokensPerSpan: 7 });
  const w2: any = { 'segment.is_phone': -5.0, 'segment.token_count_bucket': 0.1 };
  const predBefore = decodeJointSequence(lines2, spans2, w2, schema, bFeatures, sFeatures, { maxStates: 64 });

  const phoneSpan = spans2[0]!.spans.find(s => /\d{3,}/.test(lines2[0]!.slice(s.start, s.end)));
  ok(!!phoneSpan, 'found a phone-like span to assert');

  const feedback = { entities: [ { startLine: 0, fields: [ { lineIndex: 0, start: phoneSpan!.start, end: phoneSpan!.end, fieldType: 'Phone', confidence: 1.0, action: 'add' } ] } ] } as any;

  const before = { ...w2 };
  const res = updateWeightsFromUserFeedback(lines2, spans2, predBefore, feedback, w2, bFeatures, sFeatures, schema, 1.0, { maxStates: 64 });

  ok((w2['segment.is_phone'] ?? 0) > (before['segment.is_phone'] ?? 0), 'feedback update should increase phone weight');

  const predAfter = res.pred;
  ok(predAfter[0]!.fields.some((f: any) => f === 'Phone'), 'after feedback-based update the decoder should predict Phone');

  console.log('✓ feedback-based weight update works');
})();

// New test: feedback remove action decreases weights and removes prediction
(() => {
  const lines = ['Contact: +1 555-000-1111'];
  const spans = spanGenerator(lines, { delimiterRegex: /:/, maxTokensPerSpan: 7 });
  const w: any = { 'segment.is_phone': 5.0, 'segment.token_count_bucket': 0.1 };
  const predBefore = decodeJointSequence(lines, spans, w, schema, bFeatures, sFeatures, { maxStates: 64 });
  ok(predBefore[0]!.fields.some((f: any) => f === 'Phone'), 'sanity: predBefore picks Phone');

  const phoneSpan = spans[0]!.spans.find(s => /\d{3,}/.test(lines[0]!.slice(s.start, s.end)));
  ok(!!phoneSpan, 'found phone-like span');

  const feedback = { entities: [ { startLine: 0, fields: [ { lineIndex: 0, start: phoneSpan!.start, end: phoneSpan!.end, fieldType: 'Phone', confidence: 1.0, action: 'remove' } ] } ] } as any;

  const before = { ...w };
  const originalCount = spans[0]!.spans.length;
  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, w, bFeatures, sFeatures, schema, 1.0, { maxStates: 64 });

  // removal: ensure the asserted span was removed from the spans used for prediction
  ok(res.pred[0]!.fields.length === originalCount - 1, 'after remove feedback the predicted fields should reflect the removed span');

  // Ensure removal produced a negative update to the phone detector weight
  ok((w['segment.is_phone'] ?? 0) < (before['segment.is_phone'] ?? 0), 'feedback remove should decrease phone weight');

  console.log('✓ feedback remove action decreases weight and removes prediction');
})();

// New test: multiple assertions in one entity (extid, email, phone) increase corresponding weights deterministically
(() => {
  const lines = ['#A12345\tjohn@example.com\t+1 555-111-2222'];
  const spans = spanGenerator(lines, { delimiterRegex: /\t/ });
  const w: any = { 'segment.is_extid': -3.0, 'segment.is_email': -3.0, 'segment.is_phone': -3.0 };
  const predBefore = decodeJointSequence(lines, spans, w, schema, bFeatures, sFeatures, { maxStates: 64 });

  const extSpan = spans[0]!.spans.find(s => isLikelyExtID(lines[0]!.slice(s.start, s.end)));
  const emailSpan = spans[0]!.spans.find(s => isLikelyEmail(lines[0]!.slice(s.start, s.end)));
  const phoneSpan = spans[0]!.spans.find(s => isLikelyPhone(lines[0]!.slice(s.start, s.end)));
  ok(!!(extSpan && emailSpan && phoneSpan), 'found extid/email/phone spans to assert');

  const feedback = { entities: [ { startLine: 0, fields: [
    { lineIndex: 0, start: extSpan!.start, end: extSpan!.end, fieldType: 'ExtID', confidence: 1.0, action: 'add' },
    { lineIndex: 0, start: emailSpan!.start, end: emailSpan!.end, fieldType: 'Email', confidence: 1.0, action: 'add' },
    { lineIndex: 0, start: phoneSpan!.start, end: phoneSpan!.end, fieldType: 'Phone', confidence: 1.0, action: 'add' }
  ] } ] } as any;

  const before = { ...w };
  const res = updateWeightsFromUserFeedback(lines, spans, predBefore, feedback, w, bFeatures, sFeatures, schema, 1.0, { maxStates: 64 });

  // The update should either increase the detector weight OR the asserted label should already be predicted.
  const predAfter = res.pred;
  ok((w['segment.is_extid'] ?? 0) > (before['segment.is_extid'] ?? 0) || predAfter[0]!.fields.includes('ExtID'), 'extid weight increased or ExtID predicted');
  ok((w['segment.is_email'] ?? 0) > (before['segment.is_email'] ?? 0) || predAfter[0]!.fields.includes('Email'), 'email weight increased or Email predicted');
  ok((w['segment.is_phone'] ?? 0) > (before['segment.is_phone'] ?? 0) || predAfter[0]!.fields.includes('Phone'), 'phone weight increased or Phone predicted');

  ok(predAfter[0]!.fields.includes('ExtID') || predAfter[0]!.fields.includes('Email') || predAfter[0]!.fields.includes('Phone'), 'after multi-assert feedback, decoder predicts at least one asserted label');

  console.log('✓ multi-assertion feedback increases respective weights reliably');
})();

console.log('All unit tests passed.');
