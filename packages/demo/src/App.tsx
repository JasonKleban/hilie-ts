import { useState } from 'react'
import {
  decodeJointSequence,
  entitiesFromJointSequence,
  type RecordSpan,
  type LineSpans,
  type FieldSpan,
  type SubEntitySpan
} from 'hilie'
import { boundaryFeatures, segmentFeatures } from 'hilie';
import './App.css'
import { householdInfoSchema } from './schema'

const defaultWeights: Record<string, number> = {}
const sampleText = `ABCDEF123	John Smith		555-1234	john@example.com	English`

function App() {
  const [inputText, setInputText] = useState(sampleText)
  const [results, setResults] = useState<RecordSpan[] | null>(null)

  const handleExtract = (): void => {
    const lines = inputText.split('\n')
    const spansPerLine: LineSpans[] = lines.map((line, lineIndex) => {
      const spans: { start: number; end: number }[] = []
      let start = 0
      // Simple tokenization: split on whitespace
      const tokens = line.split(/(\s+)/)
      for (const token of tokens) {
        if (token.length > 0) {
          spans.push({
            start,
            end: start + token.length
          })
          start += token.length
        }
      }
      return { lineIndex, spans }
    })

    const jointSeq = decodeJointSequence(
      lines,
      spansPerLine,
      defaultWeights,
      householdInfoSchema,
      boundaryFeatures,
      segmentFeatures,
      { maxStates: 256 }
    )

    const entities = entitiesFromJointSequence(
      lines,
      spansPerLine,
      jointSeq,
      defaultWeights,
      segmentFeatures,
      householdInfoSchema
    )

    setResults(entities)
  }

  return (
    <div className="app">
      <h1>Hilie Interactive Demo</h1>
      <p>A Viterbi-based information extraction library</p>

      <div className="container">
        <div className="input-section">
          <h2>Input Text</h2>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            rows={10}
            placeholder="Enter tab-delimited household data..."
          />
          <button onClick={handleExtract}>Extract Information</button>
        </div>

        <div className="results-section">
          <h2>Extracted Entities</h2>
          {results ? (
            <div className="results">
              {results.map((entity: RecordSpan, idx: number) => (
                <div key={idx} className="entity">
                  <h3>Entity {idx + 1} (Lines {entity.startLine + 1}-{entity.endLine + 1})</h3>
                  {entity.subEntities.map((subEntity: SubEntitySpan, subIdx: number) => (
                    <div key={subIdx} className="sub-entity">
                      <h4>{subEntity.entityType}</h4>
                      <div className="fields">
                        {subEntity.fields
                          .filter((f: FieldSpan) => f.fieldType !== 'NOISE')
                          .map((field: FieldSpan, fieldIdx: number) => (
                            <div key={fieldIdx} className="field">
                              <span className="field-label">{field.fieldType}:</span>
                              <span className="field-value">{field.text}</span>
                              <span className="field-confidence">
                                ({((field.confidence ?? 0) * 100).toFixed(1)}%)
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="placeholder">Results will appear here after extraction</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
