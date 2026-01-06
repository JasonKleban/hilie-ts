import type { EntityType, FieldAssertion, Feedback, FeedbackEntry } from './types.js'

type RecordAssertion = {
  startLine: number;
  endLine: number;
  fields?: FieldAssertion[];
};

type SubEntityAssertion = {
  // Optional file-level offsets (character indices, end exclusive)
  fileStart?: number;
  fileEnd?: number;
  // Optional mapped line-range (computed from file offsets when possible)
  startLine?: number;
  endLine?: number;
  entityType?: EntityType;
  fields?: FieldAssertion[];
};

type EntityAssertion = RecordAssertion | SubEntityAssertion;

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return !(aEnd < bStart || aStart > bEnd)
}

function isContained(innerStart: number, innerEnd: number, outerStart: number, outerEnd: number) {
  return innerStart >= outerStart && innerEnd <= outerEnd
}

function spansOverlap(aStart?: number, aEnd?: number, bStart?: number, bEnd?: number) {
  if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) return false
  return !(aEnd <= bStart || aStart >= bEnd)
}

export function pushUniqueFields(existingArr?: FieldAssertion[], incoming?: FieldAssertion[]) {
  existingArr = existingArr ?? []
  if (!incoming || incoming.length === 0) return existingArr
  for (const f of incoming) {
    const duplicate = existingArr.some(g => g.lineIndex === f.lineIndex && g.start === f.start && g.end === f.end && g.fieldType === f.fieldType && g.action === f.action)
    if (!duplicate) existingArr.push(f)
  }
  return existingArr
}

export function buildFeedbackFromHistories(entityHist: EntityAssertion[] = [], fieldHist: FieldAssertion[] = [], boundarySet: Set<number> = new Set()): Feedback {
  const entries: FeedbackEntry[] = []

  for (const e of entityHist as any[]) {
    // Support both legacy line-based assertions (startLine/endLine) and new
    // file-offset sub-entity assertions (fileStart/fileEnd). For record
    // boundaries we only honor startLine/endLine.
    const hasStartLine = e.startLine !== undefined && e.startLine !== null
    const hasFileOffsets = e.fileStart !== undefined || e.fileEnd !== undefined

    if (hasFileOffsets) {
      if (e.entityType !== undefined) {
        entries.push({ kind: 'subEntity', fileStart: e.fileStart, fileEnd: e.fileEnd, entityType: e.entityType as EntityType })
      } else {
        // No clear record mapping from file offsets; skip.
      }
    } else if (hasStartLine) {
      const endLine = (e.endLine !== undefined && e.endLine !== null) ? e.endLine : e.startLine
      if (e.entityType !== undefined) {
        // Legacy line-based sub-entity assertion: emit a subEntity entry without
        // file offsets. Normalization will map this to line ranges as needed.
        entries.push({ kind: 'subEntity', entityType: e.entityType as EntityType })
      } else {
        entries.push({ kind: 'record', startLine: e.startLine, endLine })
      }
    }

    for (const f of (e.fields ?? [])) {
      entries.push({ kind: 'field', field: f })
    }
  }

  for (const li of Array.from(boundarySet)) {
    entries.push({ kind: 'record', startLine: li, endLine: li })
  }

  for (const f of fieldHist) {
    entries.push({ kind: 'field', field: f })
  }

  return { entries }
}

export function normalizeFeedbackEntries(entries: FeedbackEntry[] = [], lines?: string[]) {
  // Chronological processing: newer entries override older conflicting ones.
  let keptRecords: RecordAssertion[] = []
  let keptSubEntities: SubEntityAssertion[] = []
  let keptFields: FieldAssertion[] = []

  // Precompute line starts if lines provided
  const lineStarts: number[] | undefined = lines ? (() => {
    const arr: number[] = []
    let sum = 0
    for (const l of lines) {
      arr.push(sum)
      sum += l.length + 1
    }
    return arr
  })() : undefined

  const offsetToLine = (off: number) => {
    if (!lineStarts) return undefined
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

  for (const entry of entries) {
    if (entry.kind === 'record') {
      const startLine = entry.startLine
      const endLine = entry.endLine
      keptRecords = keptRecords.filter(r => !rangesOverlap(r.startLine, r.endLine, startLine, endLine))
      keptRecords.push({ startLine, endLine })
      continue
    }

    if (entry.kind === 'subEntity') {
      // If file offsets are provided, map them to line ranges using provided lines.
      // Preserve fileStart/fileEnd if provided and avoid snapping to whole lines here.
      const fs = (entry as any).fileStart as number | undefined
      const fe = (entry as any).fileEnd as number | undefined
      let sLine = (entry as any).startLine as number | undefined
      let eLine = (entry as any).endLine as number | undefined

      // If incoming provided file offsets and we have lineStarts, compute the
      // corresponding line indices (map fileStart to first line, fileEnd to last
      // line intersecting the range).
      if ((sLine === undefined || eLine === undefined) && fs !== undefined && fe !== undefined && lineStarts) {
        sLine = offsetToLine(fs)
        eLine = offsetToLine(Math.max(0, fe - 1))
      }

      // Remove existing sub-entities that overlap. Prefer file-range overlap when
      // both existing and incoming have file ranges; otherwise fall back to
      // line-range overlap when available.
      keptSubEntities = keptSubEntities.filter(se => {
        // both have file ranges
        if (se.fileStart !== undefined && se.fileEnd !== undefined && fs !== undefined && fe !== undefined) {
          return !spansOverlap(se.fileStart, se.fileEnd, fs, fe)
        }
        // existing has file range, incoming has lines
        if (se.fileStart !== undefined && se.fileEnd !== undefined && sLine !== undefined && eLine !== undefined && lineStarts && sLine >= 0 && eLine >= 0 && sLine < lineStarts.length && eLine < lineStarts.length && lines) {
          const incomingFs = lineStarts[sLine]!
          const incomingFe = (lineStarts[eLine] ?? 0) + (lines[eLine] ?? '').length
          return !spansOverlap(se.fileStart, se.fileEnd, incomingFs, incomingFe)
        }
        // incoming has file range, existing has lines
        if (fs !== undefined && fe !== undefined && se.startLine !== undefined && se.endLine !== undefined && lineStarts && se.startLine >= 0 && se.endLine >= 0 && se.startLine < lineStarts.length && se.endLine < lineStarts.length && lines) {
          const existingFs = lineStarts[se.startLine]!
          const existingFe = (lineStarts[se.endLine] ?? 0) + (lines[se.endLine] ?? '').length
          return !spansOverlap(fs, fe, existingFs, existingFe)
        }
        // fallback to line-range overlap if both have lines
        if (se.startLine !== undefined && se.endLine !== undefined && sLine !== undefined && eLine !== undefined) {
          return !rangesOverlap(se.startLine, se.endLine, sLine, eLine)
        }
        // if we can't decide, conservatively keep existing
        return true
      })

      const newSe: SubEntityAssertion = { entityType: entry.entityType }
      if (sLine !== undefined) newSe.startLine = sLine
      if (eLine !== undefined) newSe.endLine = eLine
      if (fs !== undefined) newSe.fileStart = fs
      if (fe !== undefined) newSe.fileEnd = fe
      keptSubEntities.push(newSe)
      continue
    }

    if (entry.kind === 'field') {
      const f = entry.field
      if (f.lineIndex === undefined || f.lineIndex === null) continue

      const action = f.action ?? 'add'

      // Always let the newest entry win for the exact same span.
      // (Important for toggling add/remove on the same exact span.)
      keptFields = keptFields.filter(g => {
        if (g.lineIndex !== f.lineIndex) return true
        return !(g.start === f.start && g.end === f.end)
      })

      // Enforce non-overlap only among non-remove field assertions.
      // Remove assertions are allowed to overlap because they target exact spans
      // (and the downstream code removes by exact start/end match).
      if (action !== 'remove') {
        keptFields = keptFields.filter(g => {
          if (g.lineIndex !== f.lineIndex) return true
          const gAction = g.action ?? 'add'
          if (gAction === 'remove') return true
          return !spansOverlap(g.start, g.end, f.start, f.end)
        })
      }

      keptFields.push(f)
      continue
    }
  }

  // Sort containers deterministically for assignment and stable output.
  keptRecords.sort((a, b) => a.startLine - b.startLine)
  keptSubEntities.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0))

  // Attach fields to the most specific explicit container containing their line.
  // Prefer an explicit sub-entity, otherwise an explicit record.
  // If no explicit record contains the line, create an *implicit* single-line
  // record container only in `entities` (do NOT treat it as a record boundary
  // assertion).
  const explicitRecordsWithFields: RecordAssertion[] = keptRecords.map(r => ({ ...r, fields: [] }))
  const explicitSubEntitiesWithFields: SubEntityAssertion[] = keptSubEntities.map(se => ({ ...se, fields: [] }))
  const implicitRecordContainers: RecordAssertion[] = []

  function findOrCreateRecordContainerForLine(lineIndex: number) {
    const existingExplicit = explicitRecordsWithFields.find(r => lineIndex >= r.startLine && lineIndex <= r.endLine)
    if (existingExplicit) return existingExplicit

    const existingImplicit = implicitRecordContainers.find(r => r.startLine === lineIndex && r.endLine === lineIndex)
    if (existingImplicit) return existingImplicit

    const implicit: RecordAssertion = { startLine: lineIndex, endLine: lineIndex, fields: [] }
    implicitRecordContainers.push(implicit)
    return implicit
  }

  for (const f of keptFields) {
    const li = f.lineIndex
    if (li === undefined || li === null) continue

    // Compute file-level offsets for this field if we have lineStarts
    let fFileStart: number | undefined = undefined
    let fFileEnd: number | undefined = undefined
    if (lineStarts !== undefined && li >= 0 && li < lineStarts.length) {
      const ls = lineStarts!
      fFileStart = ls[li]! + f.start
      fFileEnd = ls[li]! + f.end
    }

    // Prefer to attach to a sub-entity containing the field by file offsets
    let attached = false
    for (const se of explicitSubEntitiesWithFields) {
      if (se.fileStart !== undefined && se.fileEnd !== undefined && fFileStart !== undefined && fFileEnd !== undefined) {
        if (spansOverlap(fFileStart, fFileEnd, se.fileStart, se.fileEnd)) {
          se.fields = pushUniqueFields(se.fields, [f])
          attached = true
          break
        }
      }
    }
    if (attached) continue

    // Fallback to attaching by line containment
    const sub = explicitSubEntitiesWithFields.find(se => li >= (se.startLine ?? 0) && li <= (se.endLine ?? 0))
    if (sub) {
      sub.fields = pushUniqueFields(sub.fields, [f])
      continue
    }

    const rec = findOrCreateRecordContainerForLine(li)
    rec.fields = pushUniqueFields(rec.fields, [f])
  }

  // Stable ordering
  explicitRecordsWithFields.sort((a, b) => a.startLine - b.startLine)
  explicitSubEntitiesWithFields.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0))
  implicitRecordContainers.sort((a, b) => a.startLine - b.startLine)

  const entities: EntityAssertion[] = [...explicitRecordsWithFields, ...implicitRecordContainers, ...explicitSubEntitiesWithFields]
  return { records: explicitRecordsWithFields, subEntities: explicitSubEntitiesWithFields, entities }
}

export function normalizeFeedback(feedback: Feedback, lines?: string[]) {
  return normalizeFeedbackEntries(feedback.entries ?? [], lines)
}

export function removeEntityConflicts(entityHist: EntityAssertion[], fieldHist: FieldAssertion[], boundarySet: Set<number>, newStart: number, newEnd?: number) {
  const end = newEnd ?? newStart
  // mark the requested range for removal first (covers lines even if no entity started there)
  const removedLines = new Set<number>()
  for (let i = newStart; i <= end; i++) removedLines.add(i)

  const remainingEntities = entityHist.filter(e => {
    const es = e.startLine
    const ee = e.endLine
    if (es === undefined || ee === undefined) return true
    const overlap = !(ee < newStart || es > end)
    if (overlap) {
      for (let i = es; i <= ee; i++) removedLines.add(i)
      return false
    }
    return true
  })
  const newFieldHist = fieldHist.filter(f => f.lineIndex === undefined || !removedLines.has(f.lineIndex))
  const newBoundarySet = new Set(boundarySet)
  for (const li of Array.from(newBoundarySet)) {
    if (removedLines.has(li)) newBoundarySet.delete(li)
  }
  return { remainingEntities, newFieldHist, newBoundarySet }
}
