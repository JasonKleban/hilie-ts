import { useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  decodeJointSequence,
  entitiesFromJointSequence,
  spanGenerator,
  updateWeightsFromUserFeedback,
  type JointSequence,
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
  const [jointSeq, setJointSeq] = useState<JointSequence | null>(null)
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights)
  const [feedbackHistory, setFeedbackHistory] = useState<FieldAssertion[]>([])
  const [records, setRecords] = useState<RecordSpan[] | null>(null)
  const [hoverState, setHoverState] = useState<HoverState>({ type: null, value: null })
  const [textSelection, setTextSelection] = useState<{ start: number; end: number } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [boundaryCorrections, setBoundaryCorrections] = useState<Set<number>>(new Set())
  const [suppressExtractionOnWeightChange, setSuppressExtractionOnWeightChange] = useState(false)
  const [selectedSubEntityType, setSelectedSubEntityType] = useState<string | null>(null)
  // Track entity-level feedback (records / sub-entity assertions) for UI and submission
  type EntityFeedback = { startLine: number; endLine?: number; entityType?: string; fields?: FieldAssertion[] }
  const [entityFeedbackHistory, setEntityFeedbackHistory] = useState<EntityFeedback[]>([])

  // Build a normalized Feedback object from the UI histories
  const buildFeedback = (
    entityHist = entityFeedbackHistory,
    fieldHist = feedbackHistory,
    boundarySet = boundaryCorrections
  ): Feedback => {
    const entitiesMap = new Map<number, { startLine?: number; entityType?: string; fields?: FieldAssertion[] }>()

    // seed from entity assertions and include any entity-attached fields (deduped)
    const pushUniqueFields = (existingArr: FieldAssertion[] | undefined, incoming: FieldAssertion[] | undefined) => {
      existingArr = existingArr ?? []
      if (!incoming || incoming.length === 0) return existingArr
      for (const f of incoming) {
        const duplicate = existingArr.some(g => g.lineIndex === f.lineIndex && g.start === f.start && g.end === f.end && g.fieldType === f.fieldType && g.action === f.action)
        if (!duplicate) existingArr.push(f)
      }
      return existingArr
    }

    for (const e of entityHist) {
      const existing = entitiesMap.get(e.startLine) ?? { startLine: e.startLine, fields: [] as FieldAssertion[] }
      if (e.entityType) existing.entityType = e.entityType
      // merge any fields attached to the entity entry into the canonical fields array
      if (e.fields && e.fields.length) {
        existing.fields = pushUniqueFields(existing.fields, e.fields)
      }
      entitiesMap.set(e.startLine, existing)
    }

    // ensure boundary corrections are present
    for (const li of boundarySet) {
      const existing = entitiesMap.get(li) ?? { startLine: li, fields: [] as FieldAssertion[] }
      entitiesMap.set(li, existing)
    }

    // attach field assertions to their line's entity entry
    for (const f of fieldHist) {
      if (f.lineIndex === undefined || f.lineIndex === null) continue
      const li = f.lineIndex
      const existing = entitiesMap.get(li) ?? { startLine: li, fields: [] as FieldAssertion[] }
      existing.fields = pushUniqueFields(existing.fields, [f])
      entitiesMap.set(li, existing)
    }

    const entities = Array.from(entitiesMap.values()).map(e => {
      const out: any = {}
      if (e.startLine !== undefined) out.startLine = e.startLine
      if (e.entityType !== undefined) out.entityType = e.entityType
      if (e.fields && e.fields.length) out.fields = e.fields
      return out
    })

    // fallback: if no entities but there are fields (ungrouped), send them as a single entity
    if (entities.length === 0 && fieldHist.length > 0) {
      return { entities: [ { fields: fieldHist } ] }
    }

    return { entities }
  }

  // Remove entity and field conflicts when adding a new entity/sub-entity record
  const removeEntityConflicts = (newStart: number, newEnd?: number) => {
    const end = newEnd ?? newStart
    const removedLines = new Set<number>()
    const remainingEntities = entityFeedbackHistory.filter(e => {
      const es = e.startLine
      const ee = e.endLine ?? es
      const overlap = !(ee < newStart || es > end)
      if (overlap) {
        for (let i = es; i <= ee; i++) removedLines.add(i)
        return false
      }
      return true
    })
    const newFieldHist = feedbackHistory.filter(f => f.lineIndex === undefined || !removedLines.has(f.lineIndex))
    const newBoundarySet = new Set(boundaryCorrections)
    for (const li of Array.from(newBoundarySet)) {
      if (removedLines.has(li)) newBoundarySet.delete(li)
    }
    return { remainingEntities, newFieldHist, newBoundarySet }
  }

  // Submit a unified feedback object to the library and update weights
  const submitUnifiedFeedback = (
    entityHist?: EntityFeedback[],
    fieldHist?: FieldAssertion[],
    boundarySet?: Set<number>
  ) => {
    const entH = entityHist ?? entityFeedbackHistory
    const fH = fieldHist ?? feedbackHistory
    const bS = boundarySet ?? boundaryCorrections

    const feedback = buildFeedback(entH, fH, bS)

    // Always log the unified feedback that will be submitted to the library
    // (helps validate that entityType assertions are present)
    // eslint-disable-next-line no-console
    console.log('Unified feedback to submit:', JSON.stringify(feedback, null, 2))

    setIsLoading(true)
    // Suppress the normal re-extraction that runs on weight changes once so the
    // feedback-provided `spansPerLine` survives the immediate weight update.
    setSuppressExtractionOnWeightChange(true)
    setTimeout(() => {
      try {
        const { updated: newWeights, pred: newPred, spansPerLine: newSpans } = updateWeightsFromUserFeedback(
          lines,
          spansPerLine,
          jointSeq!,
          feedback,
          { ...weights },
          boundaryFeatures,
          segmentFeatures,
          householdInfoSchema
        )

        // Apply returned weights, prediction and (if provided) modified spans so UI reflects the feedback immediately
        setWeights(newWeights)
        if (newPred) {
          setJointSeq(newPred)
          const spansToUse = newSpans ?? spansPerLine
          setSpansPerLine(spansToUse)

          // Recompute records from the returned prediction using the same features/weights
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

  // Helper: apply recorded field-level feedback to a freshly generated spans array
  const applyFeedbackToSpans = (spans: LineSpans[]) => {
    const spansCopy: LineSpans[] = spans.map(s => ({ lineIndex: s.lineIndex, spans: s.spans.map(sp => ({ start: sp.start, end: sp.end })) }))

    for (const f of feedbackHistory) {
      const li = f.lineIndex
      if (li === undefined || li === null) continue
      spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] }
      if (f.action === 'remove') {
        const idx = spansCopy[li]!.spans.findIndex(x => x.start === f.start && x.end === f.end)
        if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1)
      } else {
        const idx = spansCopy[li]!.spans.findIndex(x => x.start === f.start && x.end === f.end)
        if (idx < 0) {
          spansCopy[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 })
          spansCopy[li]!.spans.sort((a, b) => a.start - b.start)
        }
      }
    }

    // Also apply any entity-level field assertions recorded on entities
    for (const ent of entityFeedbackHistory) {
      if (!ent.fields || !ent.fields.length) continue
      for (const f of ent.fields) {
        const li = f.lineIndex ?? ent.startLine
        if (li === undefined || li === null) continue
        spansCopy[li] = spansCopy[li] ?? { lineIndex: li, spans: [] }
        if (f.action === 'remove') {
          const idx = spansCopy[li]!.spans.findIndex(x => x.start === f.start && x.end === f.end)
          if (idx >= 0) spansCopy[li]!.spans.splice(idx, 1)
        } else {
          const idx = spansCopy[li]!.spans.findIndex(x => x.start === f.start && x.end === f.end)
          if (idx < 0) {
            spansCopy[li]!.spans.push({ start: f.start ?? 0, end: f.end ?? 0 })
            spansCopy[li]!.spans.sort((a, b) => a.start - b.start)
          }
        }
      }
    }



    return spansCopy
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
          let spans = spanGenerator(linesArray)

          // Re-apply any user feedback to the freshly generated spans so that
          // feedback-driven span assertions survive subsequent weight-driven re-runs.
          spans = applyFeedbackToSpans(spans)

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
          setJointSeq(jointSeq)

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
  }, [pastedText, weights, suppressExtractionOnWeightChange])

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
        // both present - normalize in case invisible nodes extended the range
        if (end! < start!) {
          const s = Math.min(start!, end!)
          start = s
          end = Math.min(docLen, s + selectedText.length)
        } else {
          // Prefer using start + selectedText.length when it differs from DOM-derived lengths
          const expectedEnd = Math.min(docLen, start! + sanitizedSelectedText.length)
          if (end! - start! !== sanitizedSelectedText.length) {
            end = expectedEnd
          }
        }
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
      fieldType,
      confidence: 1.0
    }

    // First, remove any entity/sub-entity conflicts that overlap our selected lines
    const { remainingEntities, newFieldHist, newBoundarySet } = removeEntityConflicts(startLine, endLine)

    // Remove conflicting feedback (same or overlapping span on same line) from the filtered field history
    const filteredHistory = newFieldHist.filter(f => {
      if (f.lineIndex !== startLine) return true
      // Check for overlap
      const fStart = f.start ?? 0
      const fEnd = f.end ?? 0
      return !(fStart < actualEndOffset && fEnd > startOffset)
    })

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

    // Ensure entity history includes this field assertion attached to the entity at startLine
    const newEntityHist: EntityFeedback[] = remainingEntities.map(e => ({
      startLine: e.startLine,
      ...(e.endLine !== undefined ? { endLine: e.endLine } : {}),
      ...(e.entityType !== undefined ? { entityType: e.entityType } : {}),
      ...(e.fields ? { fields: e.fields } : {})
    }))

    const entIdx = newEntityHist.findIndex(e => e.startLine === startLine)
    if (entIdx >= 0) {
      const existing = newEntityHist[entIdx]!
      const ent: EntityFeedback = {
        startLine: existing.startLine,
        ...(existing.endLine !== undefined ? { endLine: existing.endLine } : {}),
        ...(existing.entityType !== undefined ? { entityType: existing.entityType } : {}),
        fields: [...(existing.fields ?? []), newFeedback]
      }
      newEntityHist[entIdx] = ent
    } else {
      newEntityHist.push({ startLine, fields: [newFeedback] })
    }

    setFeedbackHistory(updatedHistory)
    setEntityFeedbackHistory(newEntityHist)
    setBoundaryCorrections(newBoundarySet)

    // Build and log the exact Feedback object that will be submitted to the library
    // const feedbackToSubmit = buildFeedback(remainingEntities, updatedHistory, newBoundarySet)
    // console.log('Submitting feedback to updateWeightsFromUserFeedback:', JSON.stringify(feedbackToSubmit, null, 2))

    // Submit unified feedback (entities + fields + boundaries)
    submitUnifiedFeedback(remainingEntities, updatedHistory, newBoundarySet)
  }

  // Record/sub-entity feedback handler (called when pressing Legend button)
  const handleBoundaryFeedback = (entityType?: string | null) => {
    if (!textSelection || !normalizedText || !jointSeq) return

    const { start, end } = textSelection

    // Compute start/end lines from offsets (end is exclusive => map at end-1 for inclusive)
    const startLine = offsetToLine(start)
    const endLine = offsetToLine(Math.max(start, end - 1))

    // Remove any existing conflicting entity or field feedback that overlaps this range
    const { remainingEntities, newFieldHist, newBoundarySet } = removeEntityConflicts(startLine, endLine)

    // Add this boundary to the set (use startLine as canonical)
    newBoundarySet.add(startLine)
    setBoundaryCorrections(newBoundarySet)

    // Add to UI-visible entity feedback history (keep endLine for display purposes)
    // Include any fields within the asserted range [startLine..endLine] so they are
    // attached to the entity for display and submission.
    const matchedFields = newFieldHist.filter(f => f.lineIndex !== undefined && f.lineIndex !== null && f.lineIndex >= startLine && f.lineIndex <= endLine)
    const newEntry: EntityFeedback = {
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      ...(entityType != null ? { entityType } : {}),
      ...(matchedFields.length ? { fields: matchedFields } : {})
    }
    const newEntityHist: EntityFeedback[] = [...remainingEntities.map(e => ({ startLine: e.startLine, ...(e.endLine !== undefined ? { endLine: e.endLine } : {}), ...(e.entityType !== undefined ? { entityType: e.entityType } : {}), ...(e.fields ? { fields: e.fields } : {}) })), newEntry]
    setEntityFeedbackHistory(newEntityHist)
    setFeedbackHistory(newFieldHist)

    // Build and log the exact Feedback object that will be submitted to the library
    // const feedbackToSubmit = buildFeedback(newEntityHist, newFieldHist, newBoundarySet)
    // console.log('Submitting feedback to updateWeightsFromUserFeedback:', JSON.stringify(feedbackToSubmit, null, 2))

    // Submit unified feedback (entities + fields + boundaries)
    submitUnifiedFeedback(newEntityHist, newFieldHist, newBoundarySet)
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

    // Map offsets -> lines using the precomputed lineStarts
    const startLine = offsetToLine(start)
    const endLine = offsetToLine(Math.max(start, end - 1))

    // Remove conflicts overlapping this range
    const { remainingEntities, newFieldHist, newBoundarySet } = removeEntityConflicts(startLine, endLine)

    // Ensure this asserted sub-entity is registered as a boundary (use startLine)
    newBoundarySet.add(startLine)

    // Record the assertion in UI history (attach any field assertions for display)
    // Include any fields that lie on lines within the asserted span [startLine..endLine]
    const matchedFields = newFieldHist.filter(f => f.lineIndex !== undefined && f.lineIndex !== null && f.lineIndex >= startLine && f.lineIndex <= endLine)
    const newEntry: EntityFeedback = {
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      entityType: type,
      ...(matchedFields.length ? { fields: matchedFields } : {})
    }
    const newEntityHist: EntityFeedback[] = [...remainingEntities.map(e => ({ startLine: e.startLine, ...(e.endLine !== undefined ? { endLine: e.endLine } : {}), ...(e.entityType !== undefined ? { entityType: e.entityType } : {}), ...(e.fields ? { fields: e.fields } : {}) })), newEntry]
    setEntityFeedbackHistory(newEntityHist)
    setFeedbackHistory(newFieldHist)
    setBoundaryCorrections(newBoundarySet)

    // Build and log the exact Feedback object that will be submitted to the library
    // const feedbackToSubmit = buildFeedback(newEntityHist, newFieldHist, newBoundarySet)
    // console.log('Submitting feedback to updateWeightsFromUserFeedback:', JSON.stringify(feedbackToSubmit, null, 2))

    // Submit unified feedback (entities + fields + boundaries)
    submitUnifiedFeedback(newEntityHist, newFieldHist, newBoundarySet)
  }


  const renderedContent = useMemo(() => {
    if (!normalizedText || !records) return null
    return renderWithSpans(normalizedText, records, hoverState, setHoverState)
  }, [normalizedText, records, hoverState])

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
                  <h3>Feedback (recent)</h3>
                  <div className="legend-items feedback-list">
                    <div className="legend-item feedback-entities">
                      <strong>Entities:</strong>
                      {entityFeedbackHistory.length === 0 ? <div className="feedback-empty">(none)</div> : (
                        <ul>
                          {entityFeedbackHistory.map((e, idx) => (
                            <li key={`ent-${idx}`}>
                              Line {e.startLine}{e.endLine !== undefined && e.endLine !== e.startLine ? `–${e.endLine}` : ''} {e.entityType ? `as ${e.entityType}` : '(Record)'}
                              {e.fields && e.fields.length ? (
                                <ul>
                                  {e.fields.map((f, i) => (
                                    <li key={`ef-${idx}-${i}`}>{f.action ?? 'add'} {f.fieldType} ({f.start}-{f.end})</li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="legend-item feedback-fields">
                      <strong>Fields:</strong>
                      {feedbackHistory.length === 0 ? <div className="feedback-empty">(none)</div> : (
                        <ul>
                          {feedbackHistory.map((f, idx) => (
                            <li key={`f-${idx}`}>{f.action ?? 'add'} {f.fieldType} on line {f.lineIndex} ({f.start}-{f.end})</li>
                          ))}
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

  if (!records.length && (!text || text.length === 0)) {
    elements.push(
      <div className="record-span trivia" key={0}>
        <span className="sub-entity-span trivia">
          <span className="field-span trivia trivia-placeholder">​</span>
        </span>
      </div>
    )
  }

  for (const record of records) {
    // Add text before this record
    if (lastEnd < record.fileStart) {
      const gapText = text.slice(lastEnd, record.fileStart)
      // Skip single-newline gaps to avoid noisy trivia spans between records
      if (!(gapText === '\n' || gapText === '\r' || gapText === '\r\n')) {
        elements.push(
          <span key={`text-${lastEnd}`} className="record-span trivia leading">
            <span className="sub-entity-span trivia">
              <span className="field-span trivia" data-file-start={lastEnd} data-file-end={record.fileStart}>
                {gapText}
              </span>
            </span>
          </span>
        )
      }
    }

    // Render the record with its nested spans as a block element
    elements.push(
      <div key={`record-${record.fileStart}`} className="record-span" data-file-start={record.fileStart} data-file-end={record.fileEnd}>
        {renderSubEntities(text, record.subEntities, record.fileStart, record.fileEnd, hoverState, setHoverState)}
      </div>
    )

    // Set lastEnd to record.fileEnd (exclusive) so we can consistently compute gaps
    lastEnd = record.fileEnd
  }

  // Add remaining text
  if (lastEnd < text.length) {
    const gapText = text.slice(lastEnd)
    if (!(gapText === '\n' || gapText === '\r' || gapText === '\r\n')) {
      elements.push(
        <span key={`text-${lastEnd}`} className="record-span trivia trailing">
          <span className="sub-entity-span trivia">
            <span className="field-span trivia">
              {gapText}
            </span>
          </span>
        </span>
      )
    }
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

  if (recordStart === recordEnd) {
    elements.push(
      <span className="sub-entity-span trivia" key={0}>
        <span className="field-span trivia trivia-placeholder">​</span>
      </span>
    )
  }

  for (const subEntity of subEntities) {
    // Add text before this sub-entity
    if (lastEnd < subEntity.fileStart) {
      const gapText = text.slice(lastEnd, subEntity.fileStart)
      // Skip single-newline gaps to avoid creating noisy extra sub-entity spans
      if (!(gapText === '\n' || gapText === '\r' || gapText === '\r\n')) {
        elements.push(
          <span key={`text-${lastEnd}`} className="sub-entity-span trivia leading">
            <span className="field-span trivia" data-file-start={lastEnd} data-file-end={subEntity.fileStart}>
              {gapText}
            </span>
          </span>
        )
      }
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
    const gapText = text.slice(lastEnd, recordEnd)
    if (!(gapText === '\n' || gapText === '\r' || gapText === '\r\n')) {
      elements.push(
        <span key={`text-${lastEnd}`} className="sub-entity-span trivia trailing">
          <span className="field-span trivia" data-file-start={lastEnd} data-file-end={recordEnd}>
            {gapText}
          </span>
        </span>
      )
    }
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
        <span key={`text-${lastEnd}`} className="field-span trivia leading" data-file-start={lastEnd} data-file-end={field.fileStart}>{text.slice(lastEnd, field.fileStart)}</span>
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
      <span key={`text-${lastEnd}`} className="field-span trivia trailing" data-file-start={lastEnd} data-file-end={subEntityEnd}>{text.slice(lastEnd, subEntityEnd)}</span>
    )
  }

  return elements
}

export default App
