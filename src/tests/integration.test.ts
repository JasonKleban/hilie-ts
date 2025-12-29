import { strict as assert } from 'node:assert';
import { spanGenerator } from '../lib/utils.js';
import { jointViterbiDecode, annotateEntityTypes, inferRelationships } from '../lib/viterbi.js';

function ok(cond: boolean, msg?: string) { if (!cond) throw new Error(msg || 'ok failed'); }

console.log('Integration tests: Primary/Guardian detection and relationships');

(() => {
  const lines = [
    '5\tTownsend, Olivia\tOlivia',
    '    Parent 1',
    '    +1 288-327-3488',
    '    parent@whatever.com'
  ];

  const spans = spanGenerator(lines, { delimiterRegex: /\t|\|/g, minTokenLength: 1 });
  const joint = jointViterbiDecode(lines, spans, {
    'line.lexical_similarity_drop': 0.1,
    'line.primary_likely': -1.2, // negative -> favors C (start of a primary block)
    'line.guardian_likely': 1.0, // positive -> favors B
    'segment.token_count_bucket': 0.8
  });
  const annotated = annotateEntityTypes(lines, joint);
  const rels = inferRelationships(annotated);

  // Expect line 0 to be Primary, line 1 to be Guardian, and a relationship linking them
  ok((annotated[0]?.entityType ?? 'Unknown') === 'Primary', `expected line 0 Primary, got ${annotated[0]?.entityType}`);
  ok((annotated[1]?.entityType ?? 'Unknown') === 'Guardian', `expected line 1 Guardian, got ${annotated[1]?.entityType}`);
  ok(rels.length >= 1 && rels[0]?.primaryIndex === 0 && rels[0]?.guardianIndex === 1, 'expected relationship between line 0 and 1');

  console.log('✓ Primary/Guardian detection and relationship inference');
})();

console.log('All integration tests passed.');
