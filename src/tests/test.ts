import path from 'path';
import fs from 'fs/promises';
import { jointViterbiDecode, spanGenerator, naiveSpanGenerator } from '../index.js';

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
    const content = await (fs as any).readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);

    // segment/joint feature weights
    const jointWeights = {
      'line.indentation_delta': 0.5,
      'line.lexical_similarity_drop': 1.0,
      'segment.token_count_bucket': 0.8,
      'segment.numeric_ratio': 1.2,
      'segment.is_email': 2.0,
      'segment.is_phone': 1.5,
      'field.relative_position_consistency': 0.6,
      'field.optional_penalty': -0.4
    } as Record<string, number>;

    // Use the more robust span generator by default
    const spansPerLine = spanGenerator(lines);

    // for (var line of spansPerLine) {
    //   console.info(line.lineIndex, line.spans);
    // }

    const joint = jointViterbiDecode(lines, spansPerLine, jointWeights, { maxStates: 512, safePrefix: 6, maxPhones: 2, maxEmails: 2 });

    joint.forEach((state, i) => {
      console.log(`Line ${i}: ${lines[i]}`);
      console.log(`  Boundary: ${state.boundary}`);
      console.log(`  Fields:   ${state.fields.join(", ")}`);
    });
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
