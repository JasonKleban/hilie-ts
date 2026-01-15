import { useState, useEffect, useMemo } from 'react'
import {
  decodeFullViaStreaming,
  decodeJointSequenceWithFeedback,
  analyzeFileLevelFeatures,
  entitiesFromJointSequence,
  candidateSpanGenerator,
  updateWeightsFromUserFeedback,
  normalizeFeedback,
  recordsFromLines,
  type JointSequence,
  type RecordSpan,
  type LineSpans,
  type EntityType,
  type FeedbackEntry
} from 'hilie'
import { boundaryFeatures, segmentFeatures } from 'hilie'
import './App.css'
import { householdInfoSchema } from './schema.js'
import { renderWithSpans } from './renderInternal.js'

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
  type: 'field' | 'entity' | null
  value: string | null
  spanId?: string
}

function App() {
  const [inputText, setInputText] = useState<string>('')
  const [normalizedText, setNormalizedText] = useState<string>('')
  const [lines, setLines] = useState<string[]>([])
  const [spansPerLine, setSpansPerLine] = useState<LineSpans[]>([])
  const [jointSeq, setJointSeq] = useState<JointSequence | RecordSpan[] | null>(null)
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights)
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([])
  const [records, setRecords] = useState<RecordSpan[]>([])
  const [hoverState, setHoverState] = useState<HoverState>({ type: null, value: null })
  const [textSelection, setTextSelection] = useState<{ start: number; end: number } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeLabelMode, setActiveLabelMode] = useState<'Primary' | 'Guardian' | null>(null)

  // Extract and decode when text changes or weights update (via feedback)
  useEffect(() => {
    if (!inputText.trim()) {
      setRecords([])
      setJointSeq(null)
      setNormalizedText('')
      return
    }

    setIsLoading(true)
    setTimeout(() => {
      try {
        const normalized = inputText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        setNormalizedText(normalized)
        const linesArray = normalized.split('\n')
        setLines(linesArray)

        // Immediately split into top-level records for display using deterministic splitter
        try {
          const immediateRecords = recordsFromLines(linesArray)
          setRecords(immediateRecords)
        } catch (e) {
          // fallback: leave records empty if splitter fails
          setRecords([])
        }
        
        // Generate candidate spans, optionally augmented with feedback positions
        let spans = candidateSpanGenerator(linesArray)
        
        // Add feedback-specified spans as candidates to ensure they're available to the decoder
        if (feedbackEntries.length > 0) {
          const augmentedSpans = spans.map((lineSpan, lineIndex) => {
            const additionalSpans: Array<{ start: number; end: number }> = []
            
            // Add spans from field feedback for this line
            feedbackEntries.forEach(entry => {
              if (entry.kind === 'field' && entry.field.lineIndex === lineIndex) {
                const { start, end } = entry.field
                // Check if this span already exists
                const exists = lineSpan.spans.some(s => s.start === start && s.end === end)
                if (!exists) {
                  additionalSpans.push({ start, end })
                }
              }
            })
            
            if (additionalSpans.length > 0) {
              // Merge and sort spans
              const allSpans = [...lineSpan.spans, ...additionalSpans]
              allSpans.sort((a, b) => a.start - b.start || a.end - b.end)
              return { ...lineSpan, spans: allSpans }
            }
            return lineSpan
          })
          spans = augmentedSpans
        }
        
        setSpansPerLine(spans)

        const decodeOpts = { maxStates: 512, safePrefix: 6 }
        
        // wrapper that maps old decodeJointSequence signature to streaming helper
        const decodeJointSequence = (lines: string[], spans: any, weights: any, schema: any, bF: any, sF: any, enumerateOpts?: any) =>
          decodeFullViaStreaming(lines, spans, weights, schema, bF, sF, { lookaheadLines: lines.length, enumerateOpts })

        let pred: JointSequence | RecordSpan[]
        if (feedbackEntries.length > 0) {
          const analysis = analyzeFileLevelFeatures(linesArray.join('\n'))
          const result = decodeJointSequenceWithFeedback(
            linesArray,
            spans,
            weights,
            householdInfoSchema,
            boundaryFeatures,
            segmentFeatures,
            { entries: feedbackEntries },
            decodeOpts,
            analysis.candidates,
            analysis.defaultWeights
          )
          pred = result.pred
        } else {
          pred = decodeJointSequence(
            linesArray,
            spans,
            weights,
            householdInfoSchema,
            boundaryFeatures,
            segmentFeatures,
            decodeOpts
          )
        }

        setJointSeq(pred as any)

        // If pred is already RecordSpan[] (splitter or feedback path returns records), use it directly;
        // otherwise, convert JointSequence -> RecordSpan[] via entitiesFromJointSequence
        if (Array.isArray(pred) && (pred as unknown as RecordSpan[])[0]?.startLine !== undefined) {
          setRecords(pred as unknown as RecordSpan[])
        } else {
          const normalizedFb = normalizeFeedback({ entries: feedbackEntries }, linesArray)
          // Use combinedEntities so implicit record/line containers created for field-only
          // feedback are included (ensures field-only assertions produce visible records).
          let extractedRecords = entitiesFromJointSequence(
            linesArray,
            spans,
            pred as any,
            weights,
            segmentFeatures,
            householdInfoSchema,
            normalizedFb.combinedEntities
          )

          // Fallback: when entitiesFromJointSequence yielded no records, but
          // normalized feedback included implicit record containers or field-only
          // assertions (combinedEntities), synthesize minimal RecordSpan[] so
          // field-only feedback appears immediately in the UI without running
          // a training pass.
          if ((!extractedRecords || extractedRecords.length === 0) && (normalizedFb.combinedEntities && normalizedFb.combinedEntities.length > 0)) {
            const lineStarts: number[] = []
            let off = 0
            for (let i = 0; i < linesArray.length; i++) {
              lineStarts.push(off)
              off += (linesArray[i]?.length ?? 0) + 1
            }

            const recs: RecordSpan[] = []
            for (const ce of normalizedFb.combinedEntities) {
              // Record-like containers (explicit or implicit)
              if ((ce as any).startLine !== undefined) {
                const start = (ce as any).startLine
                const end = (ce as any).endLine ?? start
                const fileStart = lineStarts[start] ?? 0
                const fileEnd = (lineStarts[end] ?? 0) + (linesArray[end]?.length ?? 0)

                const entitiesArr: any[] = []
                // If this container carries explicit fields, make a single entity for them
                const fs = (ce as any).fields ?? []
                if (fs.length > 0) {
                  const ent: any = { startLine: start, endLine: end, fileStart, fileEnd, entityType: (ce as any).entityType ?? 'Unknown', fields: [] }
                  for (const f of fs) {
                    const li = f.lineIndex ?? start
                    const fieldFileStart = (lineStarts[li] ?? 0) + (f.start ?? 0)
                    const fieldFileEnd = (lineStarts[li] ?? 0) + (f.end ?? 0)
                    ent.fields.push({ ...f, fileStart: fieldFileStart, fileEnd: fieldFileEnd, text: linesArray[li]?.slice(f.start ?? 0, f.end ?? 0) })
                  }
                  entitiesArr.push(ent)
                }

                // Also include any explicit entity entries that lie inside this record
                for (const inner of normalizedFb.combinedEntities) {
                  if ((inner as any).entityType && (inner as any).startLine !== undefined) {
                    const is = (inner as any).startLine
                    const ie = (inner as any).endLine ?? is
                    if (is >= start && ie <= end) {
                      const ifileStart = lineStarts[is] ?? 0
                      const ifileEnd = (lineStarts[ie] ?? 0) + (linesArray[ie]?.length ?? 0)
                      const ent: any = { startLine: is, endLine: ie, fileStart: ifileStart, fileEnd: ifileEnd, entityType: (inner as any).entityType ?? 'Unknown', fields: [] }
                      for (const f of (inner as any).fields ?? []) {
                        const li = f.lineIndex ?? is
                        const fieldFileStart = (lineStarts[li] ?? 0) + (f.start ?? 0)
                        const fieldFileEnd = (lineStarts[li] ?? 0) + (f.end ?? 0)
                        ent.fields.push({ ...f, fileStart: fieldFileStart, fileEnd: fieldFileEnd, text: linesArray[li]?.slice(f.start ?? 0, f.end ?? 0) })
                      }
                      entitiesArr.push(ent)
                    }
                  }
                }

                // If we found any entity-like content, add the synthesized record
                if (entitiesArr.length > 0) recs.push({ startLine: start, endLine: end, fileStart, fileEnd, entities: entitiesArr })
              }
            }

            if (recs.length > 0) extractedRecords = recs
          }

          console.log('Extracted records:', JSON.stringify(extractedRecords, null, 2))
          setRecords(extractedRecords)
        }
      } finally {
        setIsLoading(false)
      }
    }, 0)
  }, [inputText, weights])

  // Handle text selection from the rendered display
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || !normalizedText) {
        setTextSelection(null)
        return
      }

      const range = selection.getRangeAt(0)
      const textDisplay = document.querySelector('.text-display')
      
      if (!textDisplay || !textDisplay.contains(range.commonAncestorContainer)) {
        setTextSelection(null)
        return
      }

      // Get character offsets from data-start/data-end attributes
      const getOffsetFromNode = (node: Node, offset: number): number => {
        if (node.nodeType === Node.TEXT_NODE) {
          const textNode = node as Text
          
          // Find parent span with data-start
          let el = textNode.parentElement
          while (el && !el.hasAttribute('data-start')) {
            el = el.parentElement
          }
          
          if (el) {
            const spanStart = parseInt(el.getAttribute('data-start') || '0', 10)
            
            // Calculate offset within the text node relative to span start
            let nodeOffsetInSpan = 0
            let currentNode = el.firstChild
            while (currentNode && currentNode !== textNode) {
              if (currentNode.nodeType === Node.TEXT_NODE) {
                nodeOffsetInSpan += (currentNode.textContent || '').length
              }
              currentNode = currentNode.nextSibling
            }
            
            return spanStart + nodeOffsetInSpan + offset
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element
          
          if (el.hasAttribute('data-start')) {
            // If offset is 0, return start of this element
            if (offset === 0) {
              return parseInt(el.getAttribute('data-start') || '0', 10)
            }
            // Otherwise navigate to child at offset
          }
          
          // Navigate to child at offset
          const children = Array.from(el.childNodes)
          if (offset < children.length && children[offset]) {
            return getOffsetFromNode(children[offset]!, 0)
          }
          if (offset > 0 && children.length > 0) {
            const lastChild = children[children.length - 1]
            if (lastChild && lastChild.nodeType === Node.ELEMENT_NODE) {
              const lastEl = lastChild as Element
              if (lastEl.hasAttribute('data-end')) {
                return parseInt(lastEl.getAttribute('data-end') || '0', 10)
              }
            }
          }
        }
        return 0
      }

      const start = getOffsetFromNode(range.startContainer, range.startOffset)
      const end = getOffsetFromNode(range.endContainer, range.endOffset)

      if (start < end) {
        setTextSelection({ start, end })
      } else {
        setTextSelection(null)
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [normalizedText])

  // Handle paste events
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')
      if (text && text.trim()) {
        e.preventDefault()
        setInputText(text)
        setFeedbackEntries([])
        setActiveLabelMode(null)
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [])

  // Apply feedback and retrain
  const applyFeedback = (newEntries: FeedbackEntry[]) => {
    setFeedbackEntries(newEntries);

    console.log(JSON.stringify(newEntries, null, 2));
    
    setIsLoading(true)
    setTimeout(() => {
      try {
        const { updated: newWeights, pred: newPred, spansPerLine: newSpans } = updateWeightsFromUserFeedback(
          lines,
          spansPerLine,
          jointSeq!,
          { entries: newEntries },
          { ...weights },
          boundaryFeatures,
          segmentFeatures,
          householdInfoSchema
        )

        setWeights(newWeights)
        if (newPred) {
          setJointSeq(newPred as any)
          if (newSpans) setSpansPerLine(newSpans)

          // If trainer returned RecordSpan[] already, use it directly; otherwise derive records
          if (Array.isArray(newPred) && (newPred as unknown as RecordSpan[])[0]?.startLine !== undefined) {
            setRecords(newPred as unknown as RecordSpan[])
          } else {
            const normalizedFb = normalizeFeedback({ entries: newEntries }, lines)
            let extractedRecords = entitiesFromJointSequence(
              lines,
              newSpans ?? spansPerLine,
              newPred as any,
              newWeights,
              segmentFeatures,
              householdInfoSchema,
              normalizedFb.combinedEntities
            )

            if ((!extractedRecords || extractedRecords.length === 0) && (normalizedFb.combinedEntities && normalizedFb.combinedEntities.length > 0)) {
              const lineStarts: number[] = []
              let off = 0
              for (let i = 0; i < lines.length; i++) {
                lineStarts.push(off)
                off += (lines[i]?.length ?? 0) + 1
              }

              const recs: RecordSpan[] = []
              for (const ce of normalizedFb.combinedEntities) {
                if ((ce as any).startLine !== undefined) {
                  const start = (ce as any).startLine
                  const end = (ce as any).endLine ?? start
                  const fileStart = lineStarts[start] ?? 0
                  const fileEnd = (lineStarts[end] ?? 0) + (lines[end]?.length ?? 0)

                  const entitiesArr: any[] = []
                  const fs = (ce as any).fields ?? []
                  if (fs.length > 0) {
                    const ent: any = { startLine: start, endLine: end, fileStart, fileEnd, entityType: (ce as any).entityType ?? 'Unknown', fields: [] }
                    for (const f of fs) {
                      const li = f.lineIndex ?? start
                      const fieldFileStart = (lineStarts[li] ?? 0) + (f.start ?? 0)
                      const fieldFileEnd = (lineStarts[li] ?? 0) + (f.end ?? 0)
                      ent.fields.push({ ...f, fileStart: fieldFileStart, fileEnd: fieldFileEnd, text: lines[li]?.slice(f.start ?? 0, f.end ?? 0) })
                    }
                    entitiesArr.push(ent)
                  }

                  for (const inner of normalizedFb.combinedEntities) {
                    if ((inner as any).entityType && (inner as any).startLine !== undefined) {
                      const is = (inner as any).startLine
                      const ie = (inner as any).endLine ?? is
                      if (is >= start && ie <= end) {
                        const ifileStart = lineStarts[is] ?? 0
                        const ifileEnd = (lineStarts[ie] ?? 0) + (lines[ie]?.length ?? 0)
                        const ent: any = { startLine: is, endLine: ie, fileStart: ifileStart, fileEnd: ifileEnd, entityType: (inner as any).entityType ?? 'Unknown', fields: [] }
                        for (const f of (inner as any).fields ?? []) {
                          const li = f.lineIndex ?? is
                          const fieldFileStart = (lineStarts[li] ?? 0) + (f.start ?? 0)
                          const fieldFileEnd = (lineStarts[li] ?? 0) + (f.end ?? 0)
                          ent.fields.push({ ...f, fileStart: fieldFileStart, fileEnd: fieldFileEnd, text: lines[li]?.slice(f.start ?? 0, f.end ?? 0) })
                        }
                        entitiesArr.push(ent)
                      }
                    }
                  }

                  if (entitiesArr.length > 0) recs.push({ startLine: start, endLine: end, fileStart, fileEnd, entities: entitiesArr })
                }
              }

              if (recs.length > 0) extractedRecords = recs
            }

            setRecords(extractedRecords)
          }
        }
      } finally {
        setIsLoading(false)
        setTextSelection(null)
        window.getSelection()?.removeAllRanges()
      }
    }, 0)
  }


  // Handle SubEntity button click
  const handleSubEntityFeedback = (type: 'Primary' | 'Guardian') => {
    if (!textSelection) {
      // Toggle mode
      setActiveLabelMode(activeLabelMode === type ? null : type)
      return
    }

    const { start, end } = textSelection

    const newEntry: FeedbackEntry = {
      kind: 'entity',
      fileStart: start,
      fileEnd: end,
      entityType: type as EntityType
    }

    applyFeedback([...feedbackEntries, newEntry])
    setActiveLabelMode(null)
  }

  // Handle Field button click
  const handleFieldFeedback = (fieldName: string) => {
    if (!textSelection || !lines.length) return

    const { start, end } = textSelection
    
    // Find line index and offsets within line
    let currentOffset = 0
    let lineIndex = 0
    let lineStartOffset = 0
    
    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i]!.length + 1
      if (start < currentOffset + lineLength) {
        lineIndex = i
        lineStartOffset = currentOffset
        break
      }
      currentOffset += lineLength
    }
    
    const startInLine = start - lineStartOffset
    const endInLine = end - lineStartOffset

    const newEntry: FeedbackEntry = {
      kind: 'field',
      field: {
        action: 'add',
        lineIndex,
        start: startInLine,
        end: endInLine,
        fieldType: fieldName as any,
        confidence: 1.0
      }
    }

    applyFeedback([...feedbackEntries, newEntry])
  }


  // Load sample data
  const loadSampleData = async (caseNum: 1 | 3 | 4) => {
    try {
      const response = await fetch(`/src/data/case${caseNum}.txt`)
      const fullData = await response.text()
      const lines = fullData.split('\n')
      
      // For case1 (outline format), take first few records (separated by blank lines)
      if (caseNum === 1) {
        let recordCount = 0
        let lastWasBlank = true
        const sampleLines: string[] = []
        
        for (const line of lines) {
          if (line.trim() === '') {
            if (!lastWasBlank && recordCount > 0) {
              lastWasBlank = true
            }
            sampleLines.push(line)
          } else {
            if (lastWasBlank && recordCount < 5) {
              recordCount++
            }
            if (recordCount <= 5) {
              sampleLines.push(line)
            }
            lastWasBlank = false
          }
          if (recordCount > 5) break
        }
        
        setInputText(sampleLines.join('\n'))
      } else {
        // For case3 and case4 (one line per record or multi-line with indents)
        setInputText(lines.slice(0, 5).join('\n'))
      }
      
      // Clear feedback when loading new data
      setFeedbackEntries([])
      setActiveLabelMode(null)
    } catch (error) {
      console.error('Failed to load sample data:', error)
    }
  }

  const clearFeedback = () => {
    setFeedbackEntries([])
    setActiveLabelMode(null)
  }

  const renderedContent = useMemo(() => {
    if (!normalizedText) return null

    return renderWithSpans({
      text: normalizedText,
      records,
      feedbackEntries,
      hoverState,
      setHoverState
    })
  }, [normalizedText, records, feedbackEntries, hoverState])

  return (
    <div className="app">
      <div className={`progress-indicator ${isLoading ? 'active' : ''}`}></div>
      <div className="header">
        <h1>Hilie Interactive Demo</h1>
        <div className="sample-data-loader">
          <button onClick={() => loadSampleData(1)}>Load Case 1 (Outline)</button>
          <button onClick={() => loadSampleData(3)}>Load Case 3 (Wide)</button>
          <button onClick={() => loadSampleData(4)}>Load Case 4 (Multi-line)</button>
        </div>
      </div>

      <div className="main-content">
        {!inputText.trim() ? (
          <div className="paste-prompt">
            <p>Paste data from your clipboard or load a sample dataset to get started</p>
          </div>
        ) : (
          <>
            <div className="text-display">
              {renderedContent}
            </div>
            <div className="right-panel">
              <div className="legend">
                <h2>Feedback</h2>
                
                <div className="legend-section">
                  <h3>Label Selection As:</h3>
                  
                  <div className="label-buttons">

                    <button
                      className={`legend-button subentity-button subentity-primary ${activeLabelMode === 'Primary' ? 'active' : activeLabelMode ? 'dimmed' : ''}`}
                      onClick={() => handleSubEntityFeedback('Primary')}
                      disabled={activeLabelMode !== null && activeLabelMode !== 'Primary' && !textSelection}
                      title="Label selection as Primary SubEntity"
                    >
                      Primary
                    </button>

                    <button
                      className={`legend-button subentity-button subentity-guardian ${activeLabelMode === 'Guardian' ? 'active' : activeLabelMode ? 'dimmed' : ''}`}
                      onClick={() => handleSubEntityFeedback('Guardian')}
                      disabled={activeLabelMode !== null && activeLabelMode !== 'Guardian' && !textSelection}
                      title="Label selection as Guardian SubEntity"
                    >
                      Guardian
                    </button>
                  </div>

                  <div className="field-buttons">
                    {householdInfoSchema.fields.map((field: any) => (
                      <button
                        key={field.name}
                        className={`legend-button field-button field-${field.name.toLowerCase()}`}
                        onClick={() => handleFieldFeedback(field.name)}
                        disabled={!textSelection}
                        title={`Label selection as ${field.name} (max: ${field.maxAllowed})`}
                      >
                        {field.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="legend-section">
                  <h3>Feedback History ({feedbackEntries.length})</h3>
                  <div className="label-buttons">
                  <button
                    className="legend-button clear-button"
                    onClick={clearFeedback}
                    disabled={feedbackEntries.length === 0}
                  >
                    Clear All Feedback
                  </button>
                  </div>
                  <div className="feedback-list">
                    {feedbackEntries.length === 0 ? (
                      <div className="feedback-empty">No feedback yet</div>
                    ) : (
                      <ul>
                        {feedbackEntries.map((entry, idx) => (
                          <li key={idx}>
                            {entry.kind === 'entity' && `${entry.entityType}: chars ${entry.fileStart}–${entry.fileEnd}`}
                            {entry.kind === 'field' && `${entry.field.fieldType}: line ${entry.field.lineIndex} [${entry.field.start}:${entry.field.end}]`}
                          </li>
                        ))}
                      </ul>
                    )}
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

export default App
