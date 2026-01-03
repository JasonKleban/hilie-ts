import { useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  decodeJointSequence,
  entitiesFromJointSequence,
  spanGenerator,
  updateWeightsFromUserFeedback,
  type RecordSpan,
  type SubEntitySpan,
  type FieldSpan,
  type Feedback,
  type FieldAssertion,
  type LineSpans
} from 'hilie'
import { boundaryFeatures, segmentFeatures } from 'hilie'
import './App.css'
import { householdInfoSchema } from './schema'

const initialWeights = {
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

type HoverState = {
  type: 'field' | 'subEntity' | 'record' | null
  value: string | null
  spanId?: string // Specific span being hovered
}

function App() {
  const [pastedText, setPastedText] = useState<string | null>(null)
  const [normalizedText, setNormalizedText] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [spansPerLine, setSpansPerLine] = useState<LineSpans[]>([])
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights)
  const [feedbackHistory, setFeedbackHistory] = useState<FieldAssertion[]>([])
  const [records, setRecords] = useState<RecordSpan[] | null>(null)
  const [hoverState, setHoverState] = useState<HoverState>({ type: null, value: null })
  const [textSelection, setTextSelection] = useState<{ start: number; end: number } | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Run extraction when text is pasted or weights change
  useEffect(() => {
    if (pastedText !== null) {
      setIsLoading(true)
      // Use setTimeout to allow loading indicator to render
      setTimeout(() => {
        try {
          // Normalize line endings to \n to match library's assumptions
          const normalized = pastedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          setNormalizedText(normalized)
          
          const linesArray = normalized.split('\n')
          setLines(linesArray)
          const spans = spanGenerator(linesArray)
          setSpansPerLine(spans)

          const jointSeq = decodeJointSequence(
            linesArray,
            spans,
            weights,
            householdInfoSchema,
            boundaryFeatures,
            segmentFeatures,
            { maxStates: 512, safePrefix: 6 }
          )

          const extractedRecords = entitiesFromJointSequence(
            linesArray,
            spans,
            jointSeq,
            weights,
            segmentFeatures,
            householdInfoSchema
          )

          setRecords(extractedRecords)
        } finally {
          setIsLoading(false)
        }
      }, 0)
    }
  }, [pastedText, weights])

  // Handle text selection
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || !normalizedText) return

      const range = selection.getRangeAt(0)
      const textDisplay = document.querySelector('.text-display')
      
      if (!textDisplay || !textDisplay.contains(range.commonAncestorContainer)) {
        setTextSelection(null)
        return
      }

      // Get selected text and compute character offsets
      const selectedText = selection.toString()
      if (selectedText.length === 0) {
        setTextSelection(null)
        return
      }

      // Find the start offset in the normalized text
      const preCaretRange = range.cloneRange()
      preCaretRange.selectNodeContents(textDisplay)
      preCaretRange.setEnd(range.startContainer, range.startOffset)
      const start = preCaretRange.toString().length

      setTextSelection({ start, end: start + selectedText.length })
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [normalizedText])

  const handleFieldFeedback = (fieldType: string) => {
    if (!textSelection || !normalizedText || !records) return

    const { start, end } = textSelection

    // Find which line(s) this selection spans
    let charCount = 0
    let startLine = -1
    let startOffset = 0
    let endLine = -1
    let endOffset = 0

    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i]!.length
      
      if (startLine === -1 && charCount + lineLen >= start) {
        startLine = i
        startOffset = start - charCount
      }
      
      if (charCount + lineLen >= end - 1) {
        endLine = i
        endOffset = end - charCount - 1
        break
      }
      
      charCount += lineLen + 1 // +1 for newline
    }

    if (startLine === -1 || endLine === -1) return

    // For simplicity, only handle single-line selections for now
    if (startLine !== endLine) {
      alert('Multi-line selections are not yet supported')
      return
    }

    const newFeedback: FieldAssertion = {
      action: 'add',
      lineIndex: startLine,
      start: startOffset,
      end: endOffset,
      fieldType,
      confidence: 1.0
    }

    // Remove conflicting feedback (same or overlapping span on same line)
    const filteredHistory = feedbackHistory.filter(f => {
      if (f.lineIndex !== startLine) return true
      // Check for overlap
      const fStart = f.start ?? 0
      const fEnd = f.end ?? 0
      return !(fStart < endOffset && fEnd > startOffset)
    })

    // Find spans that conflict with the new selection and mark them for removal
    const conflictingSpans: FieldAssertion[] = []
    if (records) {
      for (const record of records) {
        for (const subEntity of record.subEntities) {
          for (const field of subEntity.fields) {
            if (field.lineIndex === startLine) {
              // Check if this field overlaps with our selection
              if (field.start < endOffset && field.end > startOffset) {
                conflictingSpans.push({
                  action: 'remove',
                  lineIndex: startLine,
                  start: field.start,
                  end: field.end,
                  fieldType: field.fieldType,
                  confidence: 1.0
                })
              }
            }
          }
        }
      }
    }

    const updatedHistory = [...filteredHistory, ...conflictingSpans, newFeedback]
    setFeedbackHistory(updatedHistory)

    // Log the updated feedback history
    console.log('Updated feedback history:', JSON.stringify(updatedHistory, null, 2))

    setIsLoading(true)
    // Use setTimeout to allow loading indicator to render
    setTimeout(() => {
      try {
        // Apply feedback to update weights
        const feedback: Feedback = {
          entities: [{
            fields: updatedHistory
          }]
        }

        const { updated: newWeights } = updateWeightsFromUserFeedback(
          lines,
          spansPerLine,
          records.flatMap(r => r.subEntities.flatMap(s => ({ boundary: 'C' as const, fields: s.fields.map(f => f.fieldType ?? 'NOISE') }))),
          feedback,
          { ...weights },
          boundaryFeatures,
          segmentFeatures,
          householdInfoSchema
        )

        setWeights(newWeights)
      } finally {
        setIsLoading(false)
        setTextSelection(null) // Clear selection after applying
        window.getSelection()?.removeAllRanges()
      }
    }, 0)
  }

  const renderedContent = useMemo(() => {
    if (!normalizedText || !records) return null
    return renderWithSpans(normalizedText, records, hoverState, setHoverState)
  }, [normalizedText, records, hoverState])

  const subEntityTypes = useMemo(() => {
    if (!records) return new Set<string>()
    const types = new Set<string>()
    for (const record of records) {
      for (const subEntity of record.subEntities) {
        types.add(subEntity.entityType ?? "??")
      }
    }
    return types
  }, [records])

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
      <div className={`progress-indicator ${isLoading ? 'active' : ''}`}></div>
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
              <div className="legend">
                <h2>Legend</h2>
                
                <div className="legend-section">
                  <h3>Record Spans</h3>
                  <div className="legend-items">
                    <div className="legend-item">
                      <span className="record-span-legend">Record</span>
                    </div>
                  </div>
                </div>

                <div className="legend-section">
                  <h3>Sub-Entity Types</h3>
                  <div className="legend-items">
                    {Array.from(subEntityTypes).sort().map((type) => (
                      <div key={type} className="legend-item">
                        <span 
                          className={`sub-entity-span-legend ${
                            hoverState.type === 'subEntity' && hoverState.value === type ? 'hover-exact' : ''
                          }`}
                          onMouseEnter={() => setHoverState({ type: 'subEntity', value: type })}
                          onMouseLeave={() => setHoverState({ type: null, value: null })}
                        >
                          {type}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div className="legend-section">
                  <h3>Field Types</h3>
                  <div className="legend-items">
                    {householdInfoSchema.fields.map((field) => (
                      <div key={field.name} className="legend-item">
                        <span 
                          className={`field-span-legend ${
                            hoverState.type === 'field' && hoverState.value === field.name ? 'hover-exact' : ''
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            handleFieldFeedback(field.name)
                          }}
                          onMouseEnter={() => setHoverState({ type: 'field', value: field.name })}
                          onMouseLeave={() => setHoverState({ type: null, value: null })}
                        >
                          {field.name}
                        </span>
                        <span className="max-allowed">(max: {field.maxAllowed})</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function renderWithSpans(
  text: string, 
  records: RecordSpan[], 
  hoverState: HoverState,
  setHoverState: (state: HoverState) => void
): ReactNode {
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
        {renderSubEntities(text, record.subEntities, record.fileStart, record.fileEnd, hoverState, setHoverState)}
      </span>
    )

    lastEnd = record.fileEnd
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
  recordStart: number,
  recordEnd: number,
  hoverState: HoverState,
  setHoverState: (state: HoverState) => void
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

    const spanId = `sub-entity-${subEntity.fileStart}`
    const isExact = hoverState.type === 'subEntity' && hoverState.spanId === spanId
    const isSimilar = hoverState.type === 'subEntity' && hoverState.value === subEntity.entityType && !isExact

    // Render the sub-entity with its nested fields
    elements.push(
      <span
        key={spanId}
        className={`sub-entity-span ${isExact ? 'hover-exact' : ''} ${isSimilar ? 'hover-similar' : ''}`}
        data-entity-type={subEntity.entityType}
        onMouseEnter={() => setHoverState({ type: 'subEntity', value: subEntity.entityType ?? null, spanId })}
        onMouseLeave={() => setHoverState({ type: null, value: null })}
      >
        {renderFields(text, subEntity.fields, subEntity.fileStart, subEntity.fileEnd, subEntity.entityType, hoverState, setHoverState)}
      </span>
    )

    lastEnd = subEntity.fileEnd
  }

  // Add remaining text within the record (after all subEntities)
  if (lastEnd < recordEnd) {
    elements.push(
      <span key={`text-${lastEnd}`}>{text.slice(lastEnd, recordEnd)}</span>
    )
  }

  return elements
}

function renderFields(
  text: string,
  fields: FieldSpan[],
  subEntityStart: number,
  subEntityEnd: number,
  parentSubEntityType: string | undefined,
  hoverState: HoverState,
  setHoverState: (state: HoverState) => void
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

    const spanId = `field-${field.fileStart}`
    const isExact = hoverState.type === 'field' && hoverState.spanId === spanId
    const isSimilar = hoverState.type === 'field' && hoverState.value === field.fieldType && !isExact

    // Render the field
    elements.push(
      <span
        key={spanId}
        className={`field-span ${isExact ? 'hover-exact' : ''} ${isSimilar ? 'hover-similar' : ''}`}
        data-field-type={field.fieldType}
        data-parent-subentity={parentSubEntityType}
        title={`${field.fieldType} (${((field.confidence ?? 0) * 100).toFixed(1)}%)`}
        onMouseEnter={() => setHoverState({ type: 'field', value: field.fieldType ?? null, spanId })}
        onMouseLeave={() => setHoverState({ type: null, value: null })}
      >
        {text.slice(field.fileStart, field.fileEnd)}
      </span>
    )

    lastEnd = field.fileEnd
  }

  // Add remaining text within the sub-entity (after all fields)
  if (lastEnd < subEntityEnd) {
    elements.push(
      <span key={`text-${lastEnd}`}>{text.slice(lastEnd, subEntityEnd)}</span>
    )
  }

  return elements
}

export default App
