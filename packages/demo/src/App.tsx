import { useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  decodeJointSequence,
  entitiesFromJointSequence,
  spanGenerator,
  type RecordSpan,
  type SubEntitySpan,
  type FieldSpan
} from 'hilie'
import { boundaryFeatures, segmentFeatures } from 'hilie'
import './App.css'
import { householdInfoSchema } from './schema'

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
} as Record<string, number>

function App() {
  const [pastedText, setPastedText] = useState<string | null>(null)
  const [records, setRecords] = useState<RecordSpan[] | null>(null)

  // Run extraction when text is pasted
  useEffect(() => {
    if (pastedText !== null) {
      const lines = pastedText.split(/\r?\n/)
      const spansPerLine = spanGenerator(lines)

      const jointSeq = decodeJointSequence(
        lines,
        spansPerLine,
        jointWeights,
        householdInfoSchema,
        boundaryFeatures,
        segmentFeatures,
        { maxStates: 512, safePrefix: 6 }
      )

      const extractedRecords = entitiesFromJointSequence(
        lines,
        spansPerLine,
        jointSeq,
        jointWeights,
        segmentFeatures,
        householdInfoSchema
      )

      setRecords(extractedRecords)
    }
  }, [pastedText])

  const renderedContent = useMemo(() => {
    if (!pastedText || !records) return null
    return renderWithSpans(pastedText, records)
  }, [pastedText, records])

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Only accept paste if we haven't received text yet
      if (pastedText === null) {
        e.preventDefault()
        const text = e.clipboardData?.getData('text/plain')
        if (text) {
          setPastedText(text)
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [pastedText])

  return (
    <div className="app">
      <div className="header">
        <h1>Hilie Interactive Demo</h1>
      </div>

      <div className="main-content">
        {pastedText === null ? (
          <div className="paste-prompt">
            <p>Paste data from your clipboard to get started</p>
          </div>
        ) : (
          <>
            <div className="text-display">
              <div className="rendered-text">{renderedContent}</div>
            </div>
            <div className="right-panel">
              {/* Future features will go here */}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function renderWithSpans(text: string, records: RecordSpan[]): ReactNode {
  const elements: ReactNode[] = []
  let lastEnd = 0

  for (const record of records) {
    // Add text before this record
    if (lastEnd < record.fileStart) {
      elements.push(
        <span key={`text-${lastEnd}`}>{text.slice(lastEnd, record.fileStart)}</span>
      )
    }

    // Render the record with its nested spans
    elements.push(
      <span key={`record-${record.fileStart}`} className="record-span">
        {renderSubEntities(text, record.subEntities, record.fileStart)}
      </span>
    )

    lastEnd = record.fileEnd + 1
  }

  // Add remaining text
  if (lastEnd < text.length) {
    elements.push(
      <span key={`text-${lastEnd}`}>{text.slice(lastEnd)}</span>
    )
  }

  return elements
}

function renderSubEntities(
  text: string,
  subEntities: SubEntitySpan[],
  recordStart: number
): ReactNode {
  const elements: ReactNode[] = []
  let lastEnd = recordStart

  for (const subEntity of subEntities) {
    // Add text before this sub-entity
    if (lastEnd < subEntity.fileStart) {
      elements.push(
        <span key={`text-${lastEnd}`}>{text.slice(lastEnd, subEntity.fileStart)}</span>
      )
    }

    // Render the sub-entity with its nested fields
    elements.push(
      <span
        key={`sub-entity-${subEntity.fileStart}`}
        className="sub-entity-span"
        data-entity-type={subEntity.entityType}
      >
        {renderFields(text, subEntity.fields, subEntity.fileStart)}
      </span>
    )

    lastEnd = subEntity.fileEnd + 1
  }

  // Add remaining text within the record
  const parentEnd = subEntities.length > 0 ? subEntities[subEntities.length - 1]!.fileEnd : recordStart
  if (lastEnd <= parentEnd) {
    // This will be handled by the parent context
  }

  return elements
}

function renderFields(
  text: string,
  fields: FieldSpan[],
  subEntityStart: number
): ReactNode {
  const elements: ReactNode[] = []
  let lastEnd = subEntityStart

  for (const field of fields) {
    // Add text before this field
    if (lastEnd < field.fileStart) {
      elements.push(
        <span key={`text-${lastEnd}`}>{text.slice(lastEnd, field.fileStart)}</span>
      )
    }

    // Render the field
    elements.push(
      <span
        key={`field-${field.fileStart}`}
        className="field-span"
        data-field-type={field.fieldType}
        title={`${field.fieldType} (${((field.confidence ?? 0) * 100).toFixed(1)}%)`}
      >
        {text.slice(field.fileStart, field.fileEnd + 1)}
      </span>
    )

    lastEnd = field.fileEnd + 1
  }

  return elements
}

export default App
