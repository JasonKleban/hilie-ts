# Hilie Demo

Interactive React-based demo of the Hilie information extraction library.

## Development

From the root of the monorepo:

```bash
# Start the dev server
npm run dev
```

Or from this package directory:

```bash
npm run dev
```

The demo will be available at http://localhost:5173/

## Building

```bash
npm run build
```

## Features

- Interactive text input for household data
- Real-time information extraction using Viterbi algorithm
- Visual display of extracted entities and fields
- Confidence scores for each extracted field

## Usage

1. Enter or modify tab-delimited household data in the input area
2. Click "Extract Information" to run the Viterbi decoder
3. View extracted entities with their fields and confidence scores

The demo uses the `householdInfoSchema` and pre-built features from the Hilie library.
