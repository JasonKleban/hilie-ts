# hilie-ts — Human-in-the-loop Information Extractor (TypeScript)

A compact library demonstrating Viterbi-based boundary and joint decoding for simple information extraction workflows.

## Concepts

- **Lines & Spans**: Input text is processed line-by-line. For each line we may propose candidate spans (token/group positions) representing potential fields.
  - Code: `LineSpans`, `naiveSpanGenerator` (`src/lib/utils.ts`)

- **Features**: A set of small, interpretable feature functions that score properties of lines and spans. They are grouped as:
  - *Boundary features* (e.g., indentation change, lexical similarity drop) used to detect record boundaries — `src/lib/features.ts` (`boundaryFeatures`).
  - *Segment features* (e.g., token count bucket, numeric ratio) used to score candidate spans — `src/lib/features.ts` (`segmentFeatures`).

- **Viterbi Decoding**:
  - `viterbiDecodeBoundaries` finds an optimal sequence of boundary states (B or C) across lines using DP.
  - `jointViterbiDecode` performs a joint decoding across boundaries and field label assignments per-line.
  - Code: `src/lib/viterbi.ts`.

- **Types**: Central types and small configuration objects live in `src/lib/types.ts` (e.g., `JointState`, `TransitionWeights`, `defaultTransitions`).

## How the code maps to the idea

- `src/lib/features.ts` implements feature primitives and exposes `segmentFeatures` and `boundaryFeatures` arrays used by the decoders.
- `src/lib/viterbi.ts` implements core DP routines and supporting helpers (emission, transition scoring, enumerate states).
- `src/lib/utils.ts` contains small utility helpers like `naiveSpanGenerator` used in tests and demos.
- `src/index.ts` re-exports the public API for convenience.

## Quick usage

1. Build:

   npm run build

2. Run tests:

   npm test

3. Use in your code:

   import { viterbiDecodeBoundaries, jointViterbiDecode, naiveSpanGenerator } from 'hilie-ts';

## Roadmap / TODOs

- [ ] Add richer unit tests and edge case coverage (multiple spans per line, empty lines, unusual whitespace)
- [ ] Provide a small CLI for quickly running the decoder over files
- [ ] Add a lightweight training/weight-tuning interface for feature weights
- [ ] Add TypeScript type tests and integrate with a test runner (Jest/Mocha)
- [ ] Provide examples and a tutorial notebook demonstrating a human-in-the-loop labeling workflow

Contributions welcome! If you want a hand adding any of the TODO items above just let me know.
