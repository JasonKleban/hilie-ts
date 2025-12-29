import path from 'path';
import fs from 'fs/promises';
import { viterbiDecodeBoundaries, jointViterbiDecode, naiveSpanGenerator, defaultTransitions } from '../index.js';

// --- Data-driven tests: process all .txt files in ./data and serialize results ---
async function runDataDrivenTests() {
  let files: string[] = [];

  // Try the dist-relative data dir first (works after build), otherwise try repo locations
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
      // ignore and try next
    }
  }

  if (!chosenDir) {
    console.warn(`No .txt test files found in candidates (${candidateDirs.join(', ')}) — skipping data-driven tests`);
    return;
  }

  for (const file of files) {
    const filePath = path.join(chosenDir!, file);
    const content = await (fs as any).readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);

    // boundary feature weights (simple defaults)
    const boundaryWeights = {
      'line.indentation_delta': 0.6,
      'line.lexical_similarity_drop': 1.0
    };

    // segment/joint feature weights
    const jointWeights = {
      'line.indentation_delta': 0.5,
      'line.lexical_similarity_drop': 1.0,
      'segment.token_count_bucket': 0.8,
      'segment.numeric_ratio': 1.2,
      'field.relative_position_consistency': 0.6,
      'field.optional_penalty': -0.4
    } as Record<string, number>;

    const boundaries = viterbiDecodeBoundaries(lines, boundaryWeights, defaultTransitions);

    const spansPerLine = naiveSpanGenerator(lines);
    const joint = jointViterbiDecode(lines, spansPerLine, jointWeights);

    console.log(boundaries);

    joint.forEach((state, i) => {
      console.log(`Line ${i}: ${lines[i]}`);
      console.log(`  Boundary: ${state.boundary}`);
      console.log(`  Fields:   ${state.fields.join(", ")}`);
    });

    // Serialize to console as JSON for easy consumption
    //console.log(JSON.stringify({ file, boundaries, joint: joint.map(s => ({ boundary: s.boundary, fields: s.fields })) }, null, 2));
  }
}

// Run the data-driven tests
runDataDrivenTests().catch(err => {
  console.error('Data-driven tests failed:', err);
  process.exitCode = 1;
});
