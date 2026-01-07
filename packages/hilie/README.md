# hilie — Human-in-the-loop Information Extractor (TypeScript)

Experimental library for human-in-the-loop information extraction from messy, semi-structured text.

At its core, it does a *joint* Viterbi decode over:

- per-line **record boundaries** (`'B'` start vs `'C'` continue)
- per-span **field labels** (e.g. `Name`, `Phone`, `Email`, `Birthdate`, `NOISE`)

## Concepts

- **Lines & spans**: input text is processed line-by-line. For each line, we propose candidate spans (start/end character offsets) that may correspond to fields.
  - Code: `LineSpans`, `spanGenerator` (`src/lib/utils.ts`)

- **Features**: small, interpretable scoring functions.
  - *Boundary features* (line-level) used to detect record boundaries — `boundaryFeatures` (`src/lib/features.ts`).
  - *Segment features* (span-level) used to score candidate spans — `segmentFeatures` (`src/lib/features.ts`).

- **Viterbi decoding**:
  - `decodeJointSequence` runs the joint DP decode.
  - `decodeJointSequenceWithFeedback` runs the decode while honoring feedback as *hard constraints*.
  - Code: `src/lib/viterbi.ts`.

- **Types**: central types live in `src/lib/types.ts` (`JointState`, `JointSequence`, `FieldSchema`, `RecordSpan`, etc.).

### Terminology & Glossary 🔎

A short glossary for domain terms and named identifiers used across the codebase:

- **Joint** — short for a joint decoding pass (see `decodeJointSequence`). It simultaneously infers per-line boundary decisions (record boundaries) and per-span field labels.

- **Annotation / feedback** — user-provided corrections. The preferred input shape is `FeedbackEntry[]` on `feedback.entries` (newest last). Use:
  - `decodeJointSequenceWithFeedback` to re-decode while keeping assertions stable
  - `updateWeightsFromUserFeedback` to update weights based on corrections

- **RecordSpan / SubEntitySpan** — structured output. A `RecordSpan` is a top-level record; inside it, `subEntities` represent roles (e.g. `Primary`, `Guardian`) and hold `FieldSpan[]` with file-relative offsets and confidences.

- **Field labels** — canonical labels you will encounter: `ExtID`, `Name`, `PreferredName`, `Phone`, `Email`, `Birthdate`, and `NOISE` (for non-field tokens).

- **Boundary** — lines are marked with `boundary` codes: `B` for record start and `C` for continuation; boundary features are computed in `boundaryFeatures`.

- **Selected named identifiers** (quick reference):
  - `decodeJointSequence` — joint DP decoder.
  - `entitiesFromJointSequence` — converts `JointSequence` into `RecordSpan[]`.
  - `decodeJointSequenceWithFeedback` — decoder + hard feedback constraints.
  - `updateWeightsFromUserFeedback` — weight update using feedback.
  - `spanGenerator`, `detectDelimiter`, `enumerateStates` — span proposal and state space helpers.

- **Nudge** — a targeted, calibrated update applied when straightforward feedback updates do not flip a model's prediction. Implemented by `updateWeightsFromFeedback` (helper `tryNudge`), a nudge identifies one or more features (e.g., `segment.is_phone`, `segment.is_email`, `segment.is_extid`) whose weight changes would most increase the score gap in favor of the asserted label, and then applies a scaled adjustment (respecting the learning rate and feedback confidence) to push the model toward the requested behavior.

- **Feature name examples** — feature keys you may see in diagnostics or weight dumps: `segment.is_phone`, `segment.is_email`, `segment.is_extid`, `line.leading_extid`, `line.has_birthdate`, `line.lexical_similarity_drop`.

> Note: the public JS/TS API is exported from `src/index.ts`.

## How the code maps to the idea

- `src/lib/features.ts` implements feature primitives and exposes `segmentFeatures` and `boundaryFeatures` arrays used by the decoders.
- `src/lib/viterbi.ts` implements core DP routines and supporting helpers.
- `src/lib/utils.ts` contains span proposal utilities (`spanGenerator`, `detectDelimiter`).
- `src/lib/feedbackUtils.ts` contains feedback normalization + conflict removal.

**`spanGenerator`**
- A more robust span proposal function that:
  - Splits lines by common delimiters (pipes, commas, semicolons, tabs, or runs of spaces) by default
  - Produces token n-gram spans (up to a configurable window size)
  - Falls back to word token spans if no delimiters are found
- Use by replacing calls to `spanGenerator(lines, { /* options */ })` where options are optional.
- `src/index.ts` re-exports the public API for convenience.

## Quick usage

1. Build:

   `npm run build`

2. Run tests:

   `npm test`

3. Use in your code:

```ts
import {
  boundaryFeatures,
  defaultWeights,
  decodeJointSequence,
  entitiesFromJointSequence,
  segmentFeatures,
  spanGenerator,
  type FieldSchema,
} from 'hilie'

const schema: FieldSchema = {
  fields: [
    { name: 'ExtID', maxAllowed: 1 },
    { name: 'Name', maxAllowed: 2 },
    { name: 'PreferredName', maxAllowed: 1 },
    { name: 'Phone', maxAllowed: 3 },
    { name: 'Email', maxAllowed: 3 },
    { name: 'Birthdate', maxAllowed: 1 },
    { name: 'NOISE', maxAllowed: 999 },
  ],
  noiseLabel: 'NOISE',
}

const lines = inputText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
const spans = spanGenerator(lines)

const joint = decodeJointSequence(
  lines,
  spans,
  { ...defaultWeights },
  schema,
  boundaryFeatures,
  segmentFeatures,
  { maxStates: 512, safePrefix: 6 }
)

const records = entitiesFromJointSequence(lines, spans, joint, defaultWeights, segmentFeatures, schema)
```

4. Applying feedback (two modes):

- Keep assertions stable (hard constraints, no learning):

```ts
import { decodeJointSequenceWithFeedback } from 'hilie'

const feedback = {
  entries: [
    { kind: 'record', startLine: 0, endLine: 10 },
    { kind: 'field', field: { action: 'add', lineIndex: 0, start: 0, end: 12, fieldType: 'Name', confidence: 1 } },
  ],
}

const { pred: constrainedJoint, spansPerLine: constrainedSpans } = decodeJointSequenceWithFeedback(
  lines,
  spans,
  defaultWeights,
  schema,
  boundaryFeatures,
  segmentFeatures,
  feedback,
  { maxStates: 512, safePrefix: 6 }
)
```

- Sub-entity assertions (file offsets):

Sub-entity assertions should be provided using file-relative character offsets (end-exclusive) in `fileStart` / `fileEnd` rather than `startLine` / `endLine`. The library internally maps file offsets to line ranges when needed.

```ts
// Compute lineStarts to convert line indices to file offsets (example):
const lineStarts = (() => { const arr: number[] = []; let sum = 0; for (const l of lines) { arr.push(sum); sum += l.length + 1 } return arr })()

// Assert that the first line is a Primary sub-entity via file offsets:
const feedback = {
  entries: [
    { kind: 'subEntity', fileStart: lineStarts[0], fileEnd: lineStarts[0] + lines[0].length, entityType: 'Primary' },
  ]
}

// Then use the same helpers as above to decode with feedback or update weights.
```

- Learn from corrections (updates weights):

```ts
import { updateWeightsFromUserFeedback } from 'hilie'

const { updated: newWeights, pred: newJoint } = updateWeightsFromUserFeedback(
  lines,
  spans,
  joint,
  feedback,
  { ...defaultWeights },
  boundaryFeatures,
  segmentFeatures,
  schema
)
```

## Roadmap / TODOs

- [ ] Add richer unit tests and edge case coverage (multiple spans per line, empty lines, unusual whitespace)
- [ ] Provide a small CLI for quickly running the decoder over files
- [ ] Add a lightweight training/weight-tuning interface for feature weights
- [ ] Add TypeScript type tests and integrate with a test runner (Jest/Mocha)
- [ ] Provide examples and a tutorial notebook demonstrating a human-in-the-loop labeling workflow

