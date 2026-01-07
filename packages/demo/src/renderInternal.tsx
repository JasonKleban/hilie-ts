import type { ReactNode } from 'react'
import type { RecordSpan, SubEntitySpan, FeedbackEntry } from 'hilie'

export interface RenderOptions {
  text: string
  records: RecordSpan[]
  feedbackEntries: FeedbackEntry[]
  hoverState: {
    type: 'field' | 'subEntity' | 'record' | null
    value: string | null
    spanId?: string
  }
  setHoverState: (state: any) => void
  expandedSelection?: { start: number; end: number } | null
}

/**
 * Renders text with span annotations inline.
 * Preserves monospace layout by rendering continuous text strings.
 */
export function renderWithSpans(options: RenderOptions): ReactNode {
  const { text, records, feedbackEntries, hoverState, setHoverState } = options

  // Build a map of feedback spans for visual distinction
  const feedbackSpanMap = new Map<string, boolean>()
  
  feedbackEntries.forEach((entry) => {
    if (entry.kind === 'record') {
      const key = `record-${entry.startLine}-${entry.endLine}`
      feedbackSpanMap.set(key, true)
    } else if (entry.kind === 'subEntity') {
      const key = `subEntity-${entry.fileStart}-${entry.fileEnd}-${entry.entityType}`
      feedbackSpanMap.set(key, true)
    } else if (entry.kind === 'field') {
      const f = entry.field
      const key = `field-${f.lineIndex}-${f.start}-${f.end}-${f.fieldType}`
      feedbackSpanMap.set(key, true)
    }
  })

  // Render records
  const renderRecords = () => {
    if (records.length === 0) {
      return <div className="no-records" data-start={0} data-end={text.length}>{text}</div>
    }

    const elements: ReactNode[] = []
    let lastOffset = 0

    records.forEach((record, recordIdx) => {
      const recordStart = record.fileStart ?? 0
      const recordEnd = record.fileEnd ?? text.length

      // Text before this record (includes empty lines between records)
      if (recordStart > lastOffset) {
        const preText = text.slice(lastOffset, recordStart)
        // Always render to preserve empty lines, but strip trailing newline
        // since the previous record's display:block already provided line break
        let displayText = preText
        if (displayText.startsWith('\n')) {
          // Skip the first newline (already provided by previous block)
          displayText = displayText.slice(1)
        }
        if (displayText) {
          elements.push(
            <span key={`pre-${lastOffset}`} data-start={lastOffset} data-end={recordStart}>
              {displayText}
            </span>
          )
        }
      }

      // Check feedback
      const recordKey = `record-${record.startLine}-${record.endLine}`
      const isFeedback = feedbackSpanMap.has(recordKey)
      const spanId = `record-${recordIdx}`
      const isHovered = hoverState.type === 'record' && hoverState.spanId === spanId

      // Render record
      elements.push(
        <div
          key={spanId}
          className={`record-span ${isFeedback ? 'feedback-span' : ''} ${isHovered ? 'hovered' : ''}`}
          data-span-id={spanId}
          data-start={recordStart}
          data-end={recordEnd}
          onMouseEnter={() => setHoverState({ type: 'record', value: 'Record', spanId })}
          onMouseLeave={() => setHoverState({ type: null, value: null })}
        >
          {renderRecordContent(record, recordIdx, recordStart, recordEnd)}
        </div>
      )

      lastOffset = recordEnd
    })

    // Remaining text (skip if only whitespace)
    if (lastOffset < text.length) {
      const remaining = text.slice(lastOffset)
      if (remaining.trim()) {
        elements.push(
          <span key={`post-${lastOffset}`} data-start={lastOffset} data-end={text.length}>
            {remaining}
          </span>
        )
      }
    }

    return elements
  }

  const renderRecordContent = (record: RecordSpan, recordIdx: number, recordStart: number, recordEnd: number): ReactNode => {
    if (!record.subEntities || record.subEntities.length === 0) {
      let recordText = text.slice(recordStart, recordEnd)
      // Strip trailing newline since record is display:block
      if (recordText.endsWith('\n')) {
        recordText = recordText.slice(0, -1)
      }
      return <span data-start={recordStart} data-end={recordEnd}>{recordText}</span>
    }

    const elements: ReactNode[] = []
    let lastOffset = recordStart

    record.subEntities.forEach((subEntity, subIdx) => {
      const subStart = subEntity.fileStart ?? recordStart
      const subEnd = subEntity.fileEnd ?? recordEnd

      // Text before subentity (only render if there's actually a gap)
      // Avoid duplicating text that will also be rendered as fields inside the subentity.
      let preEnd = subStart
      if (subEntity.fields && subEntity.fields.length > 0) {
        const earliestFieldStart = Math.min(...subEntity.fields.map(f => (f.fileStart ?? Number.MAX_SAFE_INTEGER)))
        if (earliestFieldStart < preEnd) preEnd = earliestFieldStart
      }
      if (preEnd > lastOffset) {
        const preText = text.slice(lastOffset, preEnd)
        if (preText.length > 0) {
          //console.log(`Gap detected: rendering pre-text from ${lastOffset} to ${preEnd}: "${preText}"`)
        }
        elements.push(
          <span key={`pre-${subIdx}`} data-start={lastOffset} data-end={preEnd}>
            {preText}
          </span>
        )
      }

      // Check feedback
      const subKey = `subEntity-${subStart}-${subEnd}-${subEntity.entityType}`
      const isFeedback = feedbackSpanMap.has(subKey)
      const spanId = `subEntity-${recordIdx}-${subIdx}`
      const isHovered = hoverState.type === 'subEntity' && hoverState.spanId === spanId

      // Render subentity
      elements.push(
        <span
          key={spanId}
          className={`subentity-span subentity-${(subEntity.entityType || 'unknown').toLowerCase()} ${isFeedback ? 'feedback-span' : ''} ${isHovered ? 'hovered' : ''}`}
          data-span-id={spanId}
          data-start={subStart}
          data-end={subEnd}
          onMouseEnter={() => setHoverState({ type: 'subEntity', value: subEntity.entityType || 'Unknown', spanId })}
          onMouseLeave={() => setHoverState({ type: null, value: null })}
        >
          {renderSubEntityContent(subEntity, recordIdx, subIdx, subStart, subEnd)}
        </span>
      )

      lastOffset = subEnd
    })

    // Remaining text in record
    if (lastOffset < recordEnd) {
      let remaining = text.slice(lastOffset, recordEnd)
      // Strip trailing newline since record is display:block
      if (remaining.endsWith('\n')) {
        remaining = remaining.slice(0, -1)
      }
      if (remaining) {
        elements.push(
          <span key={`post`} data-start={lastOffset} data-end={recordEnd}>
            {remaining}
          </span>
        )
      }
    }

    return elements
  }

  const renderSubEntityContent = (
    subEntity: SubEntitySpan,
    recordIdx: number,
    subIdx: number,
    subStart: number,
    subEnd: number
  ): ReactNode => {
    if (!subEntity.fields || subEntity.fields.length === 0) {
      const subText = text.slice(subStart, subEnd)
      return <span data-start={subStart} data-end={subEnd}>{subText}</span>
    }

    const elements: ReactNode[] = []
    let lastOffset = subStart

    subEntity.fields.forEach((field, fieldIdx) => {
      if (field.fieldType === 'NOISE') return

      // Always use file positions for rendering
      const fieldStart = field.fileStart ?? subStart
      const fieldEnd = field.fileEnd ?? subEnd

      // Text before field
      if (fieldStart > lastOffset) {
        const preText = text.slice(lastOffset, fieldStart)
        elements.push(
          <span key={`pre-${fieldIdx}`} data-start={lastOffset} data-end={fieldStart}>
            {preText}
          </span>
        )
      }

      // Check feedback
      const fieldKey = `field-${field.lineIndex}-${field.start}-${field.end}-${field.fieldType}`
      const isFeedback = feedbackSpanMap.has(fieldKey)
      const spanId = `field-${recordIdx}-${subIdx}-${fieldIdx}`
      const isHovered = hoverState.type === 'field' && hoverState.spanId === spanId

      // Render field
      const fieldText = text.slice(fieldStart, fieldEnd)
      elements.push(
        <span
          key={spanId}
          className={`field-span field-${(field.fieldType || 'unknown').toLowerCase()} ${isFeedback ? 'feedback-span' : ''} ${isHovered ? 'hovered' : ''}`}
          data-span-id={spanId}
          data-start={fieldStart}
          data-end={fieldEnd}
          onMouseEnter={() => setHoverState({ type: 'field', value: field.fieldType || 'Unknown', spanId })}
          onMouseLeave={() => setHoverState({ type: null, value: null })}
        >
          {fieldText}
        </span>
      )

      lastOffset = fieldEnd
    })

    // Remaining text in subentity
    if (lastOffset < subEnd) {
      const remaining = text.slice(lastOffset, subEnd)
      elements.push(
        <span key={`post`} data-start={lastOffset} data-end={subEnd}>
          {remaining}
        </span>
      )
    }

    return elements
  }

  return (
    <div className="rendered-text-container">
      <pre className="rendered-text">
        {renderRecords()}
      </pre>
    </div>
  )
}

