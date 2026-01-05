import type { FieldAssertion, EntityAssertion, RecordAssertion, SubEntityAssertion, Feedback, FeedbackEntry } from './types.js'

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
  const recordsMap = new Map<number, { startLine: number; endLine?: number; fields: FieldAssertion[] }>()
  const subEntitiesMap = new Map<number, { startLine: number; endLine?: number; entityType?: string; fields: FieldAssertion[] }>()

  // seed from entity assertions. Distinguish between record-level vs sub-entity assertions
  for (const e of entityHist) {
    const key = Number((e as any).startLine ?? 0)
    const end = (e as any).endLine ?? (e as any).startLine ?? key
    if ((e as any).entityType !== undefined) {
      const existing = subEntitiesMap.get(key) ?? { startLine: e.startLine ?? key, endLine: end, entityType: (e as any).entityType as string, fields: [] as FieldAssertion[] }
      if ((e as any).fields && (e as any).fields.length) existing.fields = pushUniqueFields(existing.fields, (e as any).fields)
      subEntitiesMap.set(key, existing)
    } else {
      const existing = recordsMap.get(key) ?? { startLine: e.startLine ?? key, endLine: end, fields: [] as FieldAssertion[] }
      if ((e as any).fields && (e as any).fields.length) existing.fields = pushUniqueFields(existing.fields, (e as any).fields)
      recordsMap.set(key, existing)
    }
  }

  // ensure boundary corrections are present (treat them as records)
  for (const li of Array.from(boundarySet)) {
    const existing = recordsMap.get(li) ?? { startLine: li, endLine: li, fields: [] as FieldAssertion[] }
    recordsMap.set(li, existing)
  }

  // attach field assertions to their line's record entry (prefer records; if absent, create a record; if an explicit sub-entity exists, attach to it instead)
  for (const f of fieldHist) {
    if (f.lineIndex === undefined || f.lineIndex === null) continue
    const li = f.lineIndex
    if (recordsMap.has(li)) {
      const r = recordsMap.get(li)!
      r.fields = pushUniqueFields(r.fields, [f])
      recordsMap.set(li, r)
    } else if (subEntitiesMap.has(li)) {
      const s = subEntitiesMap.get(li)!
      s.fields = pushUniqueFields(s.fields, [f])
      subEntitiesMap.set(li, s)
    } else {
      const r = { startLine: li, endLine: li, fields: [f] as FieldAssertion[] }
      recordsMap.set(li, r)
    }
  }

  const records: RecordAssertion[] = Array.from(recordsMap.values()).map(e => ({ startLine: e.startLine, endLine: e.endLine ?? e.startLine, fields: e.fields ?? [] }))
  const subEntities: SubEntityAssertion[] = Array.from(subEntitiesMap.values()).map(e => ({ startLine: e.startLine, endLine: e.endLine ?? e.startLine, entityType: e.entityType as any, fields: e.fields ?? [] }))

  // fallback: if no records but there are fields (ungrouped), send them as a single record
  if (records.length === 0 && fieldHist.length > 0) {
    const firstLine = fieldHist[0]!.lineIndex ?? 0
    const fallback: RecordAssertion = { startLine: firstLine, endLine: firstLine, fields: fieldHist }
    return { records: [fallback] }
  }

  return { records, subEntities }
}

export function normalizeFeedbackEntries(entries: FeedbackEntry[] = []) {
  // Chronological processing: newer entries override older conflicting ones.
  let keptRecords: RecordAssertion[] = []
  let keptSubEntities: SubEntityAssertion[] = []
  let keptFields: FieldAssertion[] = []

  for (const entry of entries) {
    if (entry.kind === 'record') {
      const startLine = entry.startLine
      const endLine = entry.endLine
      keptRecords = keptRecords.filter(r => !rangesOverlap(r.startLine, r.endLine, startLine, endLine))
      keptRecords.push({ startLine, endLine })
      continue
    }

    if (entry.kind === 'subEntity') {
      const startLine = entry.startLine
      const endLine = entry.endLine
      keptSubEntities = keptSubEntities.filter(se => !rangesOverlap(se.startLine, se.endLine, startLine, endLine))
      keptSubEntities.push({ startLine, endLine, entityType: entry.entityType })
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
  keptSubEntities.sort((a, b) => a.startLine - b.startLine)

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

    const sub = explicitSubEntitiesWithFields.find(se => li >= se.startLine && li <= se.endLine)
    if (sub) {
      sub.fields = pushUniqueFields(sub.fields, [f])
      continue
    }

    const rec = findOrCreateRecordContainerForLine(li)
    rec.fields = pushUniqueFields(rec.fields, [f])
  }

  // Stable ordering
  explicitRecordsWithFields.sort((a, b) => a.startLine - b.startLine)
  explicitSubEntitiesWithFields.sort((a, b) => a.startLine - b.startLine)
  implicitRecordContainers.sort((a, b) => a.startLine - b.startLine)

  const entities: EntityAssertion[] = [...explicitRecordsWithFields, ...implicitRecordContainers, ...explicitSubEntitiesWithFields]
  return { records: explicitRecordsWithFields, subEntities: explicitSubEntitiesWithFields, entities }
}

export function normalizeFeedback(feedback: Feedback) {
  if (feedback.entries && feedback.entries.length) {
    return normalizeFeedbackEntries(feedback.entries)
  }

  // Legacy shape support:
  // - `feedback.records` historically represented top-level record assertions
  // - `feedback.entities` was previously used for both record assertions and sub-entity assertions
  //   (distinguished by presence of `entityType`)
  // - `feedback.subEntities` remains a dedicated sub-entity assertion list
  const records: RecordAssertion[] = []
  const subEntities: SubEntityAssertion[] = []

  const legacyContainers: any[] = ([] as any[]).concat((feedback.records ?? []) as any, (feedback.entities ?? []) as any)
  for (const c of legacyContainers) {
    if (!c || c.startLine === undefined || c.startLine === null) continue
    if ((c as any).entityType !== undefined) {
      subEntities.push({
        startLine: c.startLine,
        endLine: c.endLine,
        ...(c.entityType !== undefined ? { entityType: c.entityType } : {}),
        ...(c.fields ? { fields: c.fields } : {})
      })
    } else {
      records.push({
        startLine: c.startLine,
        endLine: c.endLine,
        ...(c.fields ? { fields: c.fields } : {})
      })
    }
  }

  for (const se of (feedback.subEntities ?? []) as any[]) {
    if (!se || se.startLine === undefined || se.startLine === null) continue
    subEntities.push({
      startLine: se.startLine,
      endLine: se.endLine,
      ...(se.entityType !== undefined ? { entityType: se.entityType } : {}),
      ...(se.fields ? { fields: se.fields } : {})
    })
  }

  // Treat all explicitly provided containers as the source of truth.
  const entities: EntityAssertion[] = [...records, ...subEntities]
  return { records, subEntities, entities }
}

export function removeEntityConflicts(entityHist: EntityAssertion[], fieldHist: FieldAssertion[], boundarySet: Set<number>, newStart: number, newEnd?: number) {
  const end = newEnd ?? newStart
  // mark the requested range for removal first (covers lines even if no entity started there)
  const removedLines = new Set<number>()
  for (let i = newStart; i <= end; i++) removedLines.add(i)

  const remainingEntities = entityHist.filter(e => {
    const es = e.startLine
    const ee = e.endLine
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
