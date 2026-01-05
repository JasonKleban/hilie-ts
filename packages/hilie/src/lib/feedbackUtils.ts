import type { FieldAssertion, EntityAssertion, Feedback } from './types.js'

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
  const entitiesMap = new Map<number, { startLine?: number; entityType?: string; fields?: FieldAssertion[] }>()

  // seed from entity assertions and include any entity-attached fields (deduped)
  for (const e of entityHist) {
    const key = Number(e.startLine ?? 0)
    const existing = (entitiesMap.get(key) ?? { startLine: e.startLine, fields: [] as FieldAssertion[] }) as { startLine?: number; entityType?: string; fields?: FieldAssertion[] }
    if (e.entityType !== undefined) existing.entityType = e.entityType as string
    if (e.fields && e.fields.length) existing.fields = pushUniqueFields(existing.fields, e.fields)
    entitiesMap.set(key, existing)
  }

  // ensure boundary corrections are present
  for (const li of Array.from(boundarySet)) {
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
    return out as EntityAssertion
  })

  // fallback: if no entities but there are fields (ungrouped), send them as a single entity
  if (entities.length === 0 && fieldHist.length > 0) {
    return { entities: [ { fields: fieldHist } ] }
  }

  return { entities }
}

export function removeEntityConflicts(entityHist: EntityAssertion[], fieldHist: FieldAssertion[], boundarySet: Set<number>, newStart: number, newEnd?: number) {
  const end = newEnd ?? newStart
  // mark the requested range for removal first (covers lines even if no entity started there)
  const removedLines = new Set<number>()
  for (let i = newStart; i <= end; i++) removedLines.add(i)

  const remainingEntities = entityHist.filter(e => {
    const es = e.startLine ?? 0
    const ee = e.endLine ?? es
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
