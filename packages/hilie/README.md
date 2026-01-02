# hilie-ts — Human-in-the-loop Information Extractor (TypeScript)

(This is almost entirely AI-generated and I don't know yet if it really works, but it seems to almost do something cool.)

A compact library demonstrating Viterbi-based boundary and joint decoding for simple information extraction workflows.

## Concepts

- **Lines & Spans**: Input text is processed line-by-line. For each line we may propose candidate spans (token/group positions) representing potential fields.
  - Code: `LineSpans`, (`src/lib/utils.ts`)

- **Features**: A set of small, interpretable feature functions that score properties of lines and spans. They are grouped as:
  - *Boundary features* (e.g., indentation change, lexical similarity drop) used to detect record boundaries — `src/lib/features.ts` (`boundaryFeatures`).
  - *Segment features* (e.g., token count bucket, numeric ratio) used to score candidate spans — `src/lib/features.ts` (`segmentFeatures`).

- **Viterbi Decoding**:
  - `jointViterbiDecode` performs a joint decoding across boundaries and field label assignments per-line. For single-purpose boundary decoding, you can derive per-line boundary scores from the boundary features or run `jointViterbiDecode` with simplified state spaces.
  - Code: `src/lib/viterbi.ts`.

- **Types**: Central types and small configuration objects live in `src/lib/types.ts` (e.g., `JointState`, `TransitionWeights`, `defaultTransitions`).

### Terminology & Glossary 🔎

A short glossary for domain terms and named identifiers used across the codebase:

- **Joint** — short for a joint decoding pass (see `jointViterbiDecode`). It simultaneously infers per-line boundary decisions (record boundaries) and per-span field labels. A per-line `JointState` typically contains a `boundary` code (`B` = boundary/start, `C` = continuation) and a `fields` array of label assignments; a `JointSequence` is the array of per-line `JointState` entries that represents the full document decode.

- **Annotation / Feedback** — user-provided corrections (e.g., in a human-in-the-loop workflow). Feedback is represented as an `entities` array with one or more asserted fields; each field has `action` (`add` | `remove`), `fieldType` (e.g., `Phone`), `start`/`end` offsets, and a `confidence`. Use `updateWeightsFromFeedback` to apply these annotations to model weights.

- **RecordSpan / SubEntitySpan** — the library's current public entity model. A `RecordSpan` represents a top-level record and contains `subEntities` (array of `SubEntitySpan`); each `SubEntitySpan` has an `entityType` (e.g., `Primary`, `Guardian`) and `fields` (field spans with `start`, `end`, `fileStart`, `fileEnd`, `entityStart`, `entityEnd`, and numeric `confidence`).

- **Field labels** — canonical labels you will encounter: `ExtID`, `Name`, `PreferredName`, `Phone`, `Email`, `Birthdate`, and `NOISE` (for non-field tokens).

- **Boundary** — lines are marked with `boundary` codes: `B` for record start and `C` for continuation; boundary features are computed in `boundaryFeatures`.

- **Selected named identifiers** (quick reference):
  - `jointViterbiDecode` — main joint DP decoder (`src/lib/viterbi.ts`).
  - `entitiesFromJoint` — converts joint output into `RecordSpan[]`.
  - `annotateEntityTypes` — fills missing `entityType` hints on joint output.
  - `inferRelationships` — infers Primary/Guardian relationships inside a record.
  - `updateWeightsFromExample` / `updateWeightsFromFeedback` — trainer update functions for example-based and feedback-driven weight adjustments.
  - `spanGenerator`, `enumerateStates` — span proposal and candidate-state enumerator helpers.

- **Nudge** — a targeted, calibrated update applied when straightforward feedback updates do not flip a model's prediction. Implemented by `updateWeightsFromFeedback` (helper `tryNudge`), a nudge identifies one or more features (e.g., `segment.is_phone`, `segment.is_email`, `segment.is_extid`) whose weight changes would most increase the score gap in favor of the asserted label, and then applies a scaled adjustment (respecting the learning rate and feedback confidence) to push the model toward the requested behavior.

- **Feature name examples** — feature keys you may see in diagnostics or weight dumps: `segment.is_phone`, `segment.is_email`, `segment.is_extid`, `line.leading_extid`, `line.has_birthdate`, `line.lexical_similarity_drop`.

> Note: The public JS/TS API is exported from `src/index.ts`; prefer the canonical names above when integrating with downstream tooling.

## How the code maps to the idea

- `src/lib/features.ts` implements feature primitives and exposes `segmentFeatures` and `boundaryFeatures` arrays used by the decoders.
- `src/lib/viterbi.ts` implements core DP routines and supporting helpers (emission, transition scoring, enumerate states).
- `src/lib/utils.ts` contains small utility helpers `spanGenerator` used in tests and demos.

**`spanGenerator`**
- A more robust span proposal function that:
  - Splits lines by common delimiters (pipes, commas, semicolons, tabs, or runs of spaces) by default
  - Produces token n-gram spans (up to a configurable window size)
  - Falls back to word token spans if no delimiters are found
- Use by replacing calls to `spanGenerator(lines, { /* options */ })` where options are optional.
- `src/index.ts` re-exports the public API for convenience.

## Quick usage

1. Build:

   npm run build

2. Run tests:

   npm test

3. Use in your code:

   import { jointViterbiDecode } from 'hilie-ts';

## Roadmap / TODOs

- [ ] Add richer unit tests and edge case coverage (multiple spans per line, empty lines, unusual whitespace)
- [ ] Provide a small CLI for quickly running the decoder over files
- [ ] Add a lightweight training/weight-tuning interface for feature weights
- [ ] Add TypeScript type tests and integrate with a test runner (Jest/Mocha)
- [ ] Provide examples and a tutorial notebook demonstrating a human-in-the-loop labeling workflow

