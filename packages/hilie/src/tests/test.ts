import path from 'path';
import fs from 'fs/promises';
import { decodeFullViaStreaming, spanGenerator } from '../index.js';
import { entitiesFromJointSequence } from '../lib/viterbi.js';
import { boundaryFeatures, segmentFeatures } from '../lib/features.js';

const decodeJointSequence = (lines: string[], spans: any, weights: any, schema: any, bFeatures: any, sFeatures: any, enumerateOpts?: any) =>
  decodeFullViaStreaming(lines, spans, weights, schema, bFeatures, sFeatures, { lookaheadLines: lines.length, enumerateOpts: enumerateOpts })
import { householdInfoSchema } from './test-helpers.js';

const bFeatures = boundaryFeatures;
const sFeatures = segmentFeatures;

async function runDataDrivenTests() {
  let files: string[] = [];

  const candidateDirs = [path.join(process.cwd(), 'src', 'tests', 'data')];

  let chosenDir: string | null = null;

  for (const d of candidateDirs) {
    try {
      const dirList = (await (fs as any).readdir(d)) as string[];
      const txts = dirList.filter((f: string) => f.endsWith('.txt'));
      if (txts.length > 0) {
        files = txts;
        chosenDir = d;
        break;
      }
    } catch (err) {
      console.error(`Error processing ${d}:`, err);
    }
  }

  if (!chosenDir) {
    console.warn(`No .txt test files found in candidates (${candidateDirs.join(', ')}) — skipping data-driven tests`);
    return;
  }

  for (const file of files) {
    console.info(`=== TEST CASE ${file} ===`);

    const filePath = path.join(chosenDir!, file);
    const content : string = await (fs as any).readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);

    // segment/joint feature weights
    const jointWeights = {
      'line.indentation_delta': 0.5,
      'line.lexical_similarity_drop': 1.0,
      'line.blank_line': 1.0,
      'segment.token_count_bucket': 0.8,
      'segment.numeric_ratio': 1.2,
      'segment.is_email': 2.0,
      'segment.is_phone': 1.5,
      'field.relative_position_consistency': 0.6,
      'field.optional_penalty': -0.4
    } as Record<string, number>;

    const spansPerLine = spanGenerator(lines);

    const recs = decodeJointSequence(lines, spansPerLine, jointWeights, householdInfoSchema, bFeatures, sFeatures, { maxStates: 512, safePrefix: 6 });
    // decodeFullViaStreaming returns RecordSpan[]; use directly when present
    const records = (Array.isArray(recs) && recs.length > 0 && ('startLine' in (recs as any)[0])) ? (recs as any) : entitiesFromJointSequence(lines, spansPerLine, recs as any, jointWeights, sFeatures, householdInfoSchema);

    console.info(`decoded ${records.length} records, spans lines ${spansPerLine.length}`);





  }
}

console.info(`Testing...`);

// Run the data-driven tests
runDataDrivenTests().catch(err => {
  console.error('Data-driven tests failed:', err);
  process.exitCode = 1;
}).then(() => {
  console.info(`Testing concluded.`);
});
