import { useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  decodeJointSequence,
  decodeJointSequenceWithFeedback,
  entitiesFromJointSequence,
  candidateSpanGenerator,
  coverageSpanGeneratorFromCandidates,
  updateWeightsFromUserFeedback,
  type JointSequence,
  type JointState,
  type RecordSpan,
  type SubEntitySpan,
  type FieldSpan,
  type FieldAssertion,
  type FieldLabel,
  type LineSpans,
  type EntityType,
  type FeedbackEntry
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

// Render a raw slice of the document as-is, and provide a stable
// `data-file-start` anchor so selection->offset mapping remains accurate even
// in unannotated gaps between spans.
function renderRawText(text: string, start: number, end: number, key: string): ReactNode {
  if (end <= start) return null
  return (
    <span key={key} className="raw-text" data-file-start={start} data-file-end={end}>
      {text.slice(start, end)}
    </span>
  )
}

function App() {
  const [pastedText, setPastedText] = useState<string | null>(null)
  const [normalizedText, setNormalizedText] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [spansPerLine, setSpansPerLine] = useState<LineSpans[]>([])
  const [jointSeq, setJointSeq] = useState<JointSequence | null>(null)
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights)
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([])
  const [records, setRecords] = useState<RecordSpan[] | null>(null)
  const [hoverState, setHoverState] = useState<HoverState>({ type: null, value: null })
  const [textSelection, setTextSelection] = useState<{ start: number; end: number } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [suppressExtractionOnWeightChange, setSuppressExtractionOnWeightChange] = useState(false)
  const [selectedSubEntityType, setSelectedSubEntityType] = useState<string | null>(null)

  const clearFeedbackKeepWeights = () => {
    // Clearing feedback should remove hard constraints but preserve learned weights.
    setFeedbackEntries([])
    setSelectedSubEntityType(null)

    if (!lines.length) return

    setIsLoading(true)
    setTimeout(() => {
      try {
        const spans = candidateSpanGenerator(lines)
        setSpansPerLine(spans)

        const decodeOpts = { maxStates: 512, safePrefix: 6 }
        const pred = decodeJointSequence(
          lines,
          spans,
          weights,
          householdInfoSchema,
          boundaryFeatures,
          segmentFeatures,
          decodeOpts
        )
        setJointSeq(pred)

        const extractedRecords = entitiesFromJointSequence(
          lines,
          spans,
          pred,
          weights,
          segmentFeatures,
          householdInfoSchema
        )
        setRecords(extractedRecords)
      } finally {
        setIsLoading(false)
        setTextSelection(null)
        window.getSelection()?.removeAllRanges()
      }
    }, 0)
  }

  // Submit ordered feedback entries (newest last). The library handles normalization/conflicts.
  const submitUnifiedFeedback = (entries?: FeedbackEntry[]) => {
    const fb = { entries: entries ?? feedbackEntries }

    // eslint-disable-next-line no-console
    console.log('Unified feedback to submit:', JSON.stringify(fb, null, 2))

    setIsLoading(true)
    setSuppressExtractionOnWeightChange(true)
    setTimeout(() => {
      try {
        const { updated: newWeights, pred: newPred, spansPerLine: newSpans } = updateWeightsFromUserFeedback(
          lines,
          spansPerLine,
          jointSeq!,
          fb,
          { ...weights },
          boundaryFeatures,
          segmentFeatures,
          householdInfoSchema
        )

        setWeights(newWeights)
        if (newPred) {
          setJointSeq(newPred)
          const spansToUse = newSpans ?? spansPerLine
          setSpansPerLine(spansToUse)

          const extractedRecords = entitiesFromJointSequence(
            lines,
            spansToUse,
            newPred,
            newWeights,
            segmentFeatures,
            householdInfoSchema
          )
          setRecords(extractedRecords)
        }
      } finally {
        setIsLoading(false)
        setTextSelection(null)
        window.getSelection()?.removeAllRanges()
      }
    }, 0)
  }

  // Precompute line start offsets for robust offset->line mapping
  const lineStarts = useMemo(() => {
    const arr: number[] = []
    let sum = 0
    for (const l of lines) {
      arr.push(sum)
      // account for the trailing newline that was removed by split
      sum += l.length + 1
    }
    return arr
  }, [lines])

  // Map document character offsets to zero-based line indices. Uses binary search
  const offsetToLine = (off: number) => {
    if (lineStarts.length === 0) return 0
    const first = Number(lineStarts[0] ?? 0)
    if (off < first) return 0
    const lastIdx = lineStarts.length - 1
    const last = Number(lineStarts[lastIdx] ?? 0)
    if (off >= last) return lastIdx
    let lo = 0, hi = lastIdx
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2)
      if (Number(lineStarts[mid] ?? 0) <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  // Run extraction when text is pasted or weights change
  useEffect(() => {
    if (pastedText !== null) {
      // If this effect was triggered by a weight change that was the result of
      // feedback we just applied, skip one re-extraction so feedback spans survive.
      if (suppressExtractionOnWeightChange) {
        setSuppressExtractionOnWeightChange(false)
        return
      }

      setIsLoading(true)
      // Use setTimeout to allow loading indicator to render
      setTimeout(() => {
        try {
          // Normalize line endings to \n to match library's assumptions
          const normalized = pastedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          setNormalizedText(normalized)
          
          const linesArray = normalized.split('\n')
          setLines(linesArray)
          let spans = candidateSpanGenerator(linesArray)

          // If there is feedback, re-decode while honoring it as hard constraints
          // so asserted spans/labels persist across subsequent re-decodes.
          const decodeOpts = { maxStates: 512, safePrefix: 6 }
          const { pred: decoded, spansPerLine: spansWithFeedback } = (feedbackEntries.length > 0)
            ? decodeJointSequenceWithFeedback(
                linesArray,
                spans,
                weights,
                householdInfoSchema,
                boundaryFeatures,
                segmentFeatures,
                { entries: feedbackEntries },
                decodeOpts
              )
            : { pred: decodeJointSequence(linesArray, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, decodeOpts), spansPerLine: spans }

          spans = spansWithFeedback
          setSpansPerLine(spans)
          setJointSeq(decoded)

          const extractedRecords = entitiesFromJointSequence(
            linesArray,
            spans,
            decoded,
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
      // Sanitize selection by removing zero-width characters (user may add them for layout)
      const sanitizedSelectedText = selectedText.replace(/\u200B/g, '')
      if (sanitizedSelectedText.length === 0) {
        setTextSelection(null)
        return
      }

      // Helper: compute file offset from a DOM point by finding nearest ancestor with data-file-start
      const getFileOffsetFromPoint = (node: Node, nodeOffset: number): number | null => {
        const findFirstAnchoredElement = (root: Node): Element | null => {
          const stack: Node[] = [root]
          while (stack.length) {
            const cur = stack.shift()!
            if (cur.nodeType === Node.ELEMENT_NODE) {
              const el = cur as Element
              if (el.hasAttribute('data-file-start')) return el
              for (const child of Array.from(el.childNodes)) stack.push(child)
            }
          }
          return null
        }

        const findLastAnchoredElement = (root: Node): Element | null => {
          const stack: Node[] = [root]
          while (stack.length) {
            const cur = stack.pop()!
            if (cur.nodeType === Node.ELEMENT_NODE) {
              const el = cur as Element
              if (el.hasAttribute('data-file-end')) return el
              const children = Array.from(el.childNodes)
              // Push children so the last child is visited first.
              for (let i = 0; i < children.length; i++) stack.push(children[i]!)
            }
          }
          return null
        }

        // If the range endpoint lands on an element boundary (common between block elements),
        // resolve it by snapping to the adjacent anchored node.
        if (node.nodeType === Node.ELEMENT_NODE) {
          const elNode = node as Element
          const children = Array.from(elNode.childNodes)

          if (nodeOffset > 0) {
            const prev = children[nodeOffset - 1]
            if (prev) {
              const prevEl = findLastAnchoredElement(prev)
              const endAttr = prevEl?.getAttribute('data-file-end')
              if (endAttr != null) return Number(endAttr)
            }
          }

          if (nodeOffset < children.length) {
            const next = children[nodeOffset]
            if (next) {
              const nextEl = findFirstAnchoredElement(next)
              const startAttr = nextEl?.getAttribute('data-file-start')
              if (startAttr != null) return Number(startAttr)
            }
          }
        }

        // Find ancestor element that maps to a file range
        let el: Element | null = node.nodeType === Node.TEXT_NODE ? (node as Text).parentElement : (node as Element)
        while (el && !el.hasAttribute('data-file-start')) el = el.parentElement
        if (!el) return null

        const fileStart = Number(el.getAttribute('data-file-start'))
        // Create a range from element start to the given point to compute relative offset
        const r = document.createRange()
        r.setStart(el, 0)
        try {
          r.setEnd(node, nodeOffset)
        } catch (e) {
          return fileStart
        }
        // Remove any zero-width characters that may have been inserted for layout from the measured length
        const measured = r.toString().replace(/\u200B/g, '')
        return fileStart + measured.length
      }

      // Resolve start/end using DOM anchors
      let start = getFileOffsetFromPoint(range.startContainer, range.startOffset)
      let end = getFileOffsetFromPoint(range.endContainer, range.endOffset)

      const docLen = normalizedText ? normalizedText.length : 0

      if (start === null && end === null) {
        // Fallback: compute based on textContent of the display
        const preCaretRange = range.cloneRange()
        preCaretRange.selectNodeContents(textDisplay)
        preCaretRange.setEnd(range.startContainer, range.startOffset)
        // Use sanitized selection length to avoid zero-width chars
        start = preCaretRange.toString().replace(/\u200B/g, '').length
        end = start + sanitizedSelectedText.length
      } else if (start !== null && end === null) {
        end = Math.min(docLen, start + sanitizedSelectedText.length)
      } else if (start === null && end !== null) {
        start = Math.max(0, end - sanitizedSelectedText.length)
      } else {
        // Both endpoints resolved via anchors.
        // IMPORTANT: do not "fix" end by using selection.toString() length.
        // Browsers may inject extra '\n' when selection crosses block elements
        // (e.g. between .record-span blocks), which would incorrectly extend
        // the computed end into the next record.
        if (end! < start!) {
          const s = start!
          start = end!
          end = s
        }

        // If the DOM-derived selection is *longer* than the visible selection text
        // (e.g. due to zero-width layout characters), allow shrinking to match.
        const expectedEnd = Math.min(docLen, start! + sanitizedSelectedText.length)
        if (end! > expectedEnd) end = expectedEnd
      }

      // Trim trailing newline characters from the visible selection so that
      // an end anchored at the start of the next line maps to the previous
      // (visually selected) line. This avoids off-by-one endLine where the
      // DOM includes the newline in the selection endpoint.
      const trailingNewlines = sanitizedSelectedText.match(/(\r?\n)+$/)
      if (trailingNewlines && trailingNewlines.length) {
        const trimLen = trailingNewlines[0].length
        const sVal = Number(start ?? 0)
        const eVal = Number(end ?? start ?? sVal)
        end = Math.max(sVal, eVal - trimLen)
        start = sVal
      }

      // Final clamp and ensure numbers
      start = Math.max(0, Math.min(docLen, start!))
      end = Math.max(0, Math.min(docLen, end!))

      setTextSelection({ start, end })
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [normalizedText])

  const handleFieldFeedback = (fieldType: string) => {
    if (!textSelection || !normalizedText || !records) return
    if (!jointSeq) return

    const { start, end } = textSelection

    // Compute start and end lines from offsets (end is exclusive -> map at end-1). Use lineStarts for offsets-in-line.
    const startLine = offsetToLine(start)
    const endLine = offsetToLine(Math.max(start, end - 1))
    const startOffset = start - Number(lineStarts[startLine] ?? 0)

    // For multi-line fields, actual end offset within the start line extends to the end of that line
    const actualEndOffset = startLine === endLine
      ? end - Number(lineStarts[startLine] ?? 0)
      : lines[startLine]!.length; // For multi-line, extend to end of start line

    const newFeedback: FieldAssertion = {
      action: 'add',
      lineIndex: startLine,
      start: startOffset,
      end: actualEndOffset,
      fieldType: fieldType as FieldAssertion['fieldType'],
      confidence: 1.0
    }

    // Find spans that conflict with the new selection and mark them for removal (derived from current records)
    const conflictingSpans: FieldAssertion[] = []
    if (records) {
      for (const record of records) {
        for (const subEntity of record.subEntities) {
          for (const field of subEntity.fields) {
            if (field.lineIndex === startLine) {
              // Check if this field overlaps with our selection
              if (field.start < actualEndOffset && field.end > startOffset) {
                conflictingSpans.push({
                  action: 'remove',
                  lineIndex: startLine,
                  start: field.start,
                  end: field.end,
                  fieldType: (field.fieldType ?? householdInfoSchema.noiseLabel) as FieldAssertion['fieldType'],
                  confidence: 1.0
                })
              }
            }
          }
        }
      }
    }

    const newEntries: FeedbackEntry[] = [
      ...feedbackEntries,
      ...conflictingSpans.map(f => ({ kind: 'field', field: f } as const)),
      { kind: 'field', field: newFeedback }
    ]

    setFeedbackEntries(newEntries)
    submitUnifiedFeedback(newEntries)
  }

  // Record/sub-entity feedback handler (called when pressing Legend button)
  const handleBoundaryFeedback = (entityType?: string | null) => {
    if (!textSelection || !normalizedText || !jointSeq) return

    const { start, end } = textSelection

    // Compute start/end lines from offsets (end is exclusive => map at end-1 for inclusive)
    const startLine = offsetToLine(start)
    const endLine = offsetToLine(Math.max(start, end - 1))

    const newEntries: FeedbackEntry[] = (() => {
      if (entityType != null) {
        return [...feedbackEntries, { kind: 'subEntity', startLine, endLine, fileStart: start, fileEnd: end, entityType: entityType as EntityType }]
      }
      return [...feedbackEntries, { kind: 'record', startLine, endLine }]
    })()

    setFeedbackEntries(newEntries)
    submitUnifiedFeedback(newEntries)
  }

  // Assert selected range as a sub-entity of the given type. If no selection,
  // toggle the sub-entity selection mode instead (for the Record button to use).
  const handleSubEntityAssertion = (type: string) => {
    if (!normalizedText || !jointSeq) return
    if (!textSelection) {
      setSelectedSubEntityType(selectedSubEntityType === type ? null : type)
      return
    }

    const { start, end } = textSelection

    const newEntries: FeedbackEntry[] = [...feedbackEntries, { kind: 'subEntity', fileStart: start, fileEnd: end, entityType: type as EntityType }]
    setFeedbackEntries(newEntries)
    submitUnifiedFeedback(newEntries)
  }


  useEffect(() => {
    if (!records) return;

    console.log('records', records);
  }, [records, normalizedText])

  const renderedContent = useMemo(() => {
    if (!normalizedText || !jointSeq || spansPerLine.length === 0) return null

    // UI rendering uses full-coverage spans derived from the *current* candidate spans.
    // This keeps offsets stable even when candidate spans are sparse or feedback adds spans.
    const coverageSpans = coverageSpanGeneratorFromCandidates(lines, spansPerLine)

    // Inflate the decoded joint sequence onto the coverage spans by copying labels
    // for exact-matching candidate spans and labeling all other spans as NOISE.
    const inflatedJointSeq: JointSequence = jointSeq.map((state, lineIndex): JointState => {
      const candidateLine = spansPerLine[lineIndex]
      const coverageLine = coverageSpans[lineIndex]
      const candidateFields = state?.fields ?? []

      const labelBySpan = new Map<string, FieldLabel>()
      for (let i = 0; i < (candidateLine?.spans?.length ?? 0); i++) {
        const sp = candidateLine!.spans[i]!
        const lab = candidateFields[i]
        if (lab) labelBySpan.set(`${sp.start}-${sp.end}`, lab)
      }

      const fields: FieldLabel[] = (coverageLine?.spans ?? []).map(sp => {
        return labelBySpan.get(`${sp.start}-${sp.end}`) ?? householdInfoSchema.noiseLabel
      })

      return { ...state, fields }
    })

    const recordsForRender = entitiesFromJointSequence(
      lines,
      coverageSpans,
      inflatedJointSeq,
      weights,
      segmentFeatures,
      householdInfoSchema
    )

    // Defensive: clamp any out-of-bounds record offsets created by upstream code
    const textLen = normalizedText.length
    let adjusted = false
    const sanitized: RecordSpan[] = recordsForRender.map(r => {
      const fs = Math.max(0, Math.min(textLen, r.fileStart ?? 0))
      const fe = Math.max(0, Math.min(textLen, r.fileEnd ?? fs))
      if (fs !== (r.fileStart ?? 0) || fe !== (r.fileEnd ?? 0)) adjusted = true
      // Also clamp sub-entity and field positions to inside [fs, fe]
      const subEntities = (r.subEntities ?? []).map(se => ({
        ...se,
        fileStart: Math.max(fs, Math.min(textLen, se.fileStart ?? fs)),
        fileEnd: Math.max(fs, Math.min(textLen, se.fileEnd ?? fe)),
        fields: (se.fields ?? []).map(f => ({ ...f,
          fileStart: Math.max(fs, Math.min(textLen, f.fileStart ?? fs)),
          fileEnd: Math.max(fs, Math.min(textLen, f.fileEnd ?? fe))
        }))
      }))
      return { ...r, fileStart: fs, fileEnd: fe, subEntities }
    })

    // Rendering assumes records are in document order.
    sanitized.sort((a, b) => {
      if (a.fileStart !== b.fileStart) return a.fileStart - b.fileStart
      if (a.fileEnd !== b.fileEnd) return a.fileEnd - b.fileEnd
      if (a.startLine !== b.startLine) return a.startLine - b.startLine
      return a.endLine - b.endLine
    })

    if (adjusted) console.warn('Adjusted out-of-bounds record offsets for rendering')

    return renderWithSpans(normalizedText, sanitized, hoverState, setHoverState)
  }, [normalizedText, lines, spansPerLine, jointSeq, weights, hoverState])

  // Ensure the UI shows all known sub-entity types (even if none were decoded)
  const allKnownSubEntityTypes = ['Primary', 'Guardian'] as const
  const subEntityTypes = useMemo(() => {
    const types = new Set<string>(allKnownSubEntityTypes as unknown as string[])
    if (!records) return types
    for (const record of records) {
      for (const subEntity of record.subEntities) {
        if (subEntity.entityType) types.add(subEntity.entityType)
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
                      <button
                        className={`record-button ${selectedSubEntityType ? 'hover-exact' : ''}`}
                        title={selectedSubEntityType ? `Mark selected line as start of ${selectedSubEntityType}` : 'Mark selected line as record start'}
                        onClick={() => handleBoundaryFeedback(selectedSubEntityType)}
                      >
                        Record
                      </button>
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
                            (hoverState.type === 'subEntity' && hoverState.value === type) || selectedSubEntityType === type ? 'hover-exact' : ''
                          }`}
                          onMouseEnter={() => setHoverState({ type: 'subEntity', value: type })}
                          onMouseLeave={() => setHoverState({ type: null, value: null })}
                          onMouseDown={(e) => {
                            // Prevent losing the DOM selection when clicking the UI so
                            // the selection remains available in the handler.
                            if (textSelection) {
                              e.preventDefault()
                              handleSubEntityAssertion(type)
                            } else {
                              setSelectedSubEntityType(selectedSubEntityType === type ? null : type)
                            }
                          }}
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

                <div className="legend-section">
                  <h3>Feedback</h3>
                  <div className="legend-items">
                    <div className="legend-item">
                      <button
                        type="button"
                        className="record-button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={clearFeedbackKeepWeights}
                        disabled={feedbackEntries.length === 0}
                        aria-disabled={feedbackEntries.length === 0}
                      >
                        Clear feedback
                      </button>
                    </div>
                  </div>
                  <div className="legend-items feedback-list">
                    <div className="legend-item feedback-fields">
                      {feedbackEntries.length === 0 ? <div className="feedback-empty">(none)</div> : (
                        <ul>
                          {feedbackEntries.map((entry, idx) => {
                            if (entry.kind === 'record') {
                              return (
                                <li key={`e-${idx}`}>
                                  #{idx + 1} Record: line {entry.startLine}{entry.endLine !== entry.startLine ? `–${entry.endLine}` : ''}
                                </li>
                              )
                            }
                            if (entry.kind === 'subEntity') {
                              const fileRange = (entry as any).fileStart !== undefined && (entry as any).fileEnd !== undefined
                              const lineRange = (entry as any).startLine !== undefined && (entry as any).endLine !== undefined
                              return (
                                <li key={`e-${idx}`}>
                                  #{idx + 1} Sub-Entity: {entry.entityType} {lineRange ? `line ${(entry as any).startLine}${(entry as any).endLine !== (entry as any).startLine ? `–${(entry as any).endLine}` : ''}` : (fileRange ? `chars ${(entry as any).fileStart}–${(entry as any).fileEnd}` : '')}
                                </li>
                              )
                            }
                            const f = entry.field
                            return (
                              <li key={`e-${idx}`}>
                                #{idx + 1} Field: {f.action ?? 'add'} {f.fieldType} on line {f.lineIndex} ({f.start}-{f.end})
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
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
  let lastEnd = 0;

  for (const [idx, record] of records.entries()) {
    // Add text before this record
    if (lastEnd < record.fileStart) {
      elements.push(
        renderRawText(text, lastEnd, record.fileStart, `text-${lastEnd}`)
      )
    }

    // Some decoded records can be "zero-length" in file offsets (fileStart === fileEnd),
    // which happens when the record corresponds to a blank line (line length 0).
    // In the underlying text that blank line is represented by the newline separator
    // character(s). Ensure this record consumes that newline so:
    // - the record has non-zero rendered height, and
    // - we don't render the same newline again as part of the inter-record gap text.
    let effectiveFileEnd = record.fileEnd
    if (effectiveFileEnd === record.fileStart) {
      const two = text.slice(effectiveFileEnd, effectiveFileEnd + 2)
      if (two === '\r\n') effectiveFileEnd += 2
      else if (text[effectiveFileEnd] === '\n' || text[effectiveFileEnd] === '\r') effectiveFileEnd += 1
    }
    effectiveFileEnd = Math.max(record.fileStart, Math.min(text.length, effectiveFileEnd))

    // Render the record as a block so the outline consistently encloses the
    // full record contents.
    elements.push(
      <div
        key={`record-${record.startLine}-${record.endLine}-${record.fileStart}-${effectiveFileEnd}-${idx}`}
        className="record-span"
        data-file-start={record.fileStart}
        data-file-end={effectiveFileEnd}
      >
        {renderSubEntities(text, record.subEntities, record.fileStart, effectiveFileEnd, hoverState, setHoverState)}
      </div>
    )

    // Set lastEnd to record.fileEnd (exclusive) so we can consistently compute gaps
    lastEnd = effectiveFileEnd

    // If the next character(s) are newline separators (CRLF or LF), advance
    // lastEnd to skip them so we don't render those separators as separate
    // `raw-text` gaps between adjacent records. This preserves block layout
    // but avoids producing isolated `raw-text` spans between records.
    if (lastEnd < text.length) {
      const twoNext = text.slice(lastEnd, lastEnd + 2)
      if (twoNext === '\r\n') lastEnd += 2
      else if (text[lastEnd] === '\n' || text[lastEnd] === '\r') lastEnd += 1
    }
  }

  // Add remaining text
  if (lastEnd < text.length) {
    elements.push(
      renderRawText(text, lastEnd, text.length, `text-${lastEnd}`)
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
        renderRawText(text, lastEnd, subEntity.fileStart, `text-${lastEnd}`)
      )
    }

    const spanId = `sub-entity-${subEntity.fileStart}-${subEntity.fileEnd}`
    const isExact = hoverState.type === 'subEntity' && hoverState.spanId === spanId
    const isSimilar = hoverState.type === 'subEntity' && hoverState.value === subEntity.entityType && !isExact

    // Render the sub-entity with its nested fields
    elements.push(
      <span
        key={spanId}
        className={`sub-entity-span ${isExact ? 'hover-exact' : ''} ${isSimilar ? 'hover-similar' : ''}`}
        data-entity-type={subEntity.entityType}
        data-file-start={subEntity.fileStart}
        data-file-end={subEntity.fileEnd}
        onMouseEnter={() => setHoverState({ type: 'subEntity', value: subEntity.entityType ?? null, spanId })}
        onMouseLeave={() => setHoverState({ type: null, value: null })}
      >
        {renderFields(text, subEntity.fields, subEntity.fileStart, subEntity.fileEnd, subEntity.entityType, hoverState, setHoverState)}
      </span>
    )

    // Keep lastEnd at subEntity.fileEnd (exclusive); gaps are handled by checks above
    lastEnd = subEntity.fileEnd
  }

  // Add remaining text within the record (after all subEntities)
  if (lastEnd < recordEnd) {
    elements.push(
      renderRawText(text, lastEnd, recordEnd, `text-${lastEnd}`)
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

  if (subEntityStart === subEntityEnd) {
    elements.push(
      <span key={0} className="field-span trivia trivia-placeholder">​</span>
    )
  }

  for (const field of fields) {
    // Add text before this field
    if (lastEnd < field.fileStart) {
      elements.push(
        renderRawText(text, lastEnd, field.fileStart, `text-${lastEnd}`)
      )
    }

    // Treat NOISE spans as raw text (used for UI coverage/anchoring).
    if (!field.fieldType || field.fieldType === householdInfoSchema.noiseLabel) {
      elements.push(
        renderRawText(text, field.fileStart, field.fileEnd, `noise-${field.fileStart}-${field.fileEnd}`)
      )
      lastEnd = field.fileEnd
      continue
    }

    const spanId = `field-${field.fileStart}-${field.fileEnd}`
    const isExact = hoverState.type === 'field' && hoverState.spanId === spanId
    const isSimilar = hoverState.type === 'field' && hoverState.value === field.fieldType && !isExact

    // Render the field
    elements.push(
      <span
        key={spanId}
        className={`field-span ${isExact ? 'hover-exact' : ''} ${isSimilar ? 'hover-similar' : ''}`}
        data-field-type={field.fieldType}
        data-parent-subentity={parentSubEntityType}
        data-file-start={field.fileStart}
        data-file-end={field.fileEnd}
        title={`${field.fieldType} (${((field.confidence ?? 0) * 100).toFixed(1)}%)`}
        onMouseEnter={() => setHoverState({ type: 'field', value: field.fieldType ?? null, spanId })}
        onMouseLeave={() => setHoverState({ type: null, value: null })}
      >
        {text.slice(field.fileStart, field.fileEnd)}
      </span>
    )

    // Keep lastEnd at field.fileEnd (exclusive); gaps are handled by checks above
    lastEnd = field.fileEnd
  }

  // Add remaining text within the sub-entity (after all fields)
  if (lastEnd < subEntityEnd) {
    elements.push(
      renderRawText(text, lastEnd, subEntityEnd, `text-${lastEnd}`)
    )
  }

  return elements
}

export default App
