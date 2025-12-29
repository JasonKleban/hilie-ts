// Minimal assertion helpers to avoid external test deps
function ok(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
function strictEqual(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `Expected ${a} to equal ${b}`);
}

import { viterbiDecodeBoundaries, jointViterbiDecode, naiveSpanGenerator, defaultTransitions } from '../index.js';

// Basic smoke test for viterbiDecodeBoundaries
const lines = [
  "ID: 123",
  "Name: Alice",
  "Age: 30",
  "",
  "ID: 124",
  "Name: Bob",
  "Age: 27"
];

const featureWeights = {
  "line.indentation_delta": 0.6,
  "line.lexical_similarity_drop": 1.2
};

const states = viterbiDecodeBoundaries(lines, featureWeights, defaultTransitions);

console.log(states);

strictEqual(states.length, lines.length, 'boundary decode should return one state per line');
strictEqual(states[0], 'B', 'first state should be B');
for (const s of states) ok(s === 'B' || s === 'C');

// Basic smoke test for jointViterbiDecode
const lines2 = [
  "ID: 123 | Alice | 30",
  "ID: 124 | Bob",
  "ID: 125 | Charlie | 27"
];

const spansPerLine = naiveSpanGenerator(lines2);

const featureWeights2: Record<string, number> = {
  "line.indentation_delta": 0.5,
  "line.lexical_similarity_drop": 1.0,
  "segment.token_count_bucket": 0.8,
  "segment.numeric_ratio": 1.2,
  "field.relative_position_consistency": 0.6,
  "field.optional_penalty": -0.4
};

const result = jointViterbiDecode(lines2, spansPerLine, featureWeights2);

result.forEach((state, i) => {
  console.log(`Line ${i}: ${lines2[i]}`);
  console.log(`  Boundary: ${state.boundary}`);
  console.log(`  Fields:   ${state.fields.join(", ")}`);
});

strictEqual(result.length, lines2.length);
for (let i = 0; i < result.length; i++) {
  const state = result[i]!;
  ok(state.boundary === 'B' || state.boundary === 'C');
  strictEqual(state.fields.length, spansPerLine[i]!.spans.length);
}

console.log('All tests passed');
