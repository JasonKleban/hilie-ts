import fs from 'fs'
import path from 'path'
import { candidateSpanGenerator, decodeFullViaStreaming, entitiesFromJointSequence } from 'hilie'

const decodeJointSequence = (lines: string[], spans: any, weights: any, schema: any, bFeatures: any, sFeatures: any, enumerateOpts?: any) =>
  decodeFullViaStreaming(lines, spans, weights, schema, bFeatures, sFeatures, { lookaheadLines: lines.length, enumerateOpts: enumerateOpts })
import { boundaryFeatures, segmentFeatures } from 'hilie'
import { renderWithSpans } from '../renderInternal'
import { householdInfoSchema } from '../schema'

console.log('Demo render test: duplicate raw-text span check')

const casePath = path.join(process.cwd(), '..', 'hilie', 'src', 'tests', 'data', 'case1.txt')
const text = fs.readFileSync(casePath, 'utf8')
const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const lines = normalized.split('\n')
const spans = candidateSpanGenerator(lines)

const weights = {
  'line.indentation_delta': 0.5,
  'line.lexical_similarity_drop': 1.0,
  'line.blank_line': 1.0,
  'segment.token_count_bucket': 0.8,
  'segment.numeric_ratio': 1.2,
  'segment.is_email': 2.0,
  'segment.is_phone': 1.5,
  'field.relative_position_consistency': 0.6,
  'field.optional_penalty': -0.4
}

const pred = decodeJointSequence(lines, spans, weights, householdInfoSchema, boundaryFeatures, segmentFeatures, { maxStates: 512, safePrefix: 6 })
const records = entitiesFromJointSequence(lines, spans, pred, weights, segmentFeatures, householdInfoSchema)

// Quick inspection: find records/sub-entities/fields that overlap the suspect 84-85 range
for (const r of records) {
  const overlaps = (s:number,e:number) => !(e <= 84 || s >= 85)
  if (overlaps(r.fileStart, r.fileEnd)) {
    console.log('Record overlapping 84-85', { fileStart: r.fileStart, fileEnd: r.fileEnd })
    for (const s of (r.subEntities ?? [])) {
      if (overlaps(s.fileStart, s.fileEnd)) console.log('  SubEntity', s.entityType, s.fileStart, s.fileEnd)
      for (const f of (s.fields ?? [])) {
        if (overlaps(f.fileStart, f.fileEnd)) console.log('    Field', f.fieldType, f.fileStart, f.fileEnd)
      }
    }
  }
}

// (instrumentation via module patching removed; using renderer debug buffer instead)

// Enable debug capture in renderer
import { __DEBUG_EMITTED_RAWS, __DEBUG_SET_CAPTURE } from '../renderInternal'
__DEBUG_SET_CAPTURE(true)
const elements = renderWithSpans(normalized, records, { type: null, value: null }, () => {})

// Ensure record spans have hover handlers so the UI can expand selection on legend hover
let foundRecordHover = false
function findRecordHover(el:any){
  if (!el || typeof el !== 'object') return
  const p = el.props
  if (p && typeof p.className === 'string' && p.className.includes('record-span') && typeof p.onMouseEnter === 'function') foundRecordHover = true
  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach(findRecordHover)
  else findRecordHover(ch)
}
if (Array.isArray(elements)) elements.forEach(findRecordHover)
else findRecordHover(elements)
if (!foundRecordHover) throw new Error('Record spans should expose hover handlers for record-hover expansion')
console.log('✓ demo render: record spans expose hover handlers for UI expansion')

// log debug captured entries
if (__DEBUG_EMITTED_RAWS.length > 0) {
  console.log('Debug emitted raw spans:')
  for (const e of __DEBUG_EMITTED_RAWS) {
    console.log(`  raw ${e.s}-${e.e} key=${e.key} stack:\n${(e.stack ?? '').split('\n').slice(0,4).join('\n')}`)
  }
}

// Inspect specific small-range problematic anchors (e.g., 84-85)
const suspect = __DEBUG_EMITTED_RAWS.filter(x => x.s === 84 && x.e === 85)
if (suspect.length) {
  console.log('Found emissions for 84-85:')
  for (const s of suspect) console.log(s.stack)
  throw new Error('Regression: renderer emitted raw span for 84-85')
} else {
  console.log('No direct emissions found for 84-85 in debug buffer')
}

const rawSet = new Set<string>()

function inspectEl(el: any) {
  if (!el) return
  if (typeof el !== 'object') return
  const p = el.props
  if (p && p.className === 'raw-text') {
    const s = Number(p['data-file-start'])
    const e = Number(p['data-file-end'])
    const key = `${s}-${e}`
    if (rawSet.has(key)) throw new Error(`Duplicate raw-text span detected in demo render: ${key}`)
    rawSet.add(key)
  }

  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach(inspectEl)
  else inspectEl(ch)
}

if (Array.isArray(elements)) {
  elements.forEach(inspectEl)
} else {
  inspectEl(elements)
}

console.log('✓ demo render: no duplicate raw-text spans detected')

// New test: ensure no raw-text element exists *outside* a record whose range
// exactly matches a record container. Having a top-level raw span equal to a
// record's full range is a duplication/ordering bug.
const recordRanges: Array<{s:number,e:number}> = []
function collectRecords(el:any){
  if (!el || typeof el !== 'object') return
  const p = el.props
  if (p && typeof p.className === 'string' && p.className.includes('record-span')) {
    recordRanges.push({ s: Number(p['data-file-start']), e: Number(p['data-file-end']) })
  }
  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach(collectRecords)
  else collectRecords(ch)
}
if (Array.isArray(elements)) { elements.forEach(collectRecords) } else { collectRecords(elements) }

// Traverse elements and track an ancestor stack of record ranges so we can
// detect a raw-text range that *matches* a record container but is not
// actually a descendant of that record element (i.e., duplication in output).
let dupFound = false

function traverse(el:any, recordStack: Array<{s:number,e:number}>){
  if (!el || typeof el !== 'object') return
  const p = el.props
  if (p && typeof p.className === 'string' && p.className.includes('record-span')) {
    const s = Number(p['data-file-start'])
    const e = Number(p['data-file-end'])
    // push this record onto the stack while traversing children
    const nextStack = recordStack.concat([{s,e}])
    const ch = p.children
    if (Array.isArray(ch)) ch.forEach((c:any)=>traverse(c, nextStack))
    else traverse(ch, nextStack)
    return
  }

  if (p && typeof p.className === 'string' && p.className.includes('raw-text')) {
    const s = Number(p['data-file-start'])
    const e = Number(p['data-file-end'])
    // If this raw exactly matches a known record range, ensure it's inside that record in the stack
    const matching = recordRanges.find(r => r.s === s && r.e === e)
    if (matching) {
      const inside = recordStack.some(r => r.s === s && r.e === e)
      if (!inside) {
        console.error('Duplicate range collision: raw-text', `${s}-${e}`, 'and record', `${matching.s}-${matching.e}`, 'stack:', recordStack)
        dupFound = true
      }
    }
  }

  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach((c:any)=>traverse(c, recordStack))
  else traverse(ch, recordStack)
}

if (Array.isArray(elements)) { elements.forEach((e:any)=>traverse(e, [])) } else { traverse(elements, []) }
if (dupFound) throw new Error('Duplicate raw range collision with a record container detected')
console.log('✓ demo render: no raw<->record duplicate ranges detected')

// Diagnostic simulation: reproduce old rendering without global dedupe to find origin of duplicates
function simulateRenderWithoutGlobalDedupe(text: string, records: any[]) {
  const out: any[] = []

  function renderRaw(start:number,end:number,key:string){
    if (start>=end) return null
    return { type:'raw', start, end, key }
  }

  function renderFieldsSim(text:string, fields:any[], subStart:number, subEnd:number){
    const elems:any[] = []
    let lastEnd = subStart
    for (const field of fields) {
      if (lastEnd < field.fileStart) {
        let gapEnd = field.fileStart
        const overlap = 0 // overlap logic not needed for reproduction
        if (gapEnd > lastEnd) elems.push(renderRaw(lastEnd, gapEnd, `text-${lastEnd}`))
      }
      if (!field.fieldType || field.fieldType === 'NOISE') {
        elems.push(renderRaw(field.fileStart, field.fileEnd, `noise-${field.fileStart}-${field.fileEnd}`))
        lastEnd = field.fileEnd
        continue
      }
      elems.push({ type:'field', start: field.fileStart, end: field.fileEnd, field })
      lastEnd = field.fileEnd
    }
    if (lastEnd < subEnd) elems.push(renderRaw(lastEnd, subEnd, `text-${lastEnd}`))
    return elems
  }

  function renderSubEntitiesSim(text:string, subs:any[], recStart:number, recEnd:number){
    const elems:any[] = []
    let lastEnd = recStart
    for (const se of subs) {
      if (lastEnd < se.fileStart) elems.push(renderRaw(lastEnd, se.fileStart, `text-${lastEnd}`))
      elems.push({ type:'sub', start: se.fileStart, end: se.fileEnd, children: renderFieldsSim(text, se.fields, se.fileStart, se.fileEnd), se })
      lastEnd = se.fileEnd
    }
    if (lastEnd < recEnd) elems.push(renderRaw(lastEnd, recEnd, `text-${lastEnd}`))
    return elems
  }

  for (const r of records) {
    if (r.fileStart && out.length && out[out.length-1].end < r.fileStart) out.push(renderRaw(out[out.length-1].end, r.fileStart, `text-${out[out.length-1].end}`))
    const recElems = renderSubEntitiesSim(text, r.subEntities ?? [], r.fileStart, r.fileEnd)
    out.push({ type:'record', start: r.fileStart, end: r.fileEnd, children: recElems, r })
  }
  return out
}

const sim = simulateRenderWithoutGlobalDedupe(normalized, records)

// Walk sim and find duplicates
const seen = new Map<string, any[]>()
function walk(o:any, path:string[] = []){
  if (!o) return
  if (Array.isArray(o)) return o.forEach((c,i)=>walk(c, path.concat(String(i))))
  if (o.type === 'raw') {
    const key = `${o.start}-${o.end}`
    if (!seen.has(key)) seen.set(key, [])
    const arr = seen.get(key)!
    arr.push({path, obj:o})
  }
  if (o.children) walk(o.children, path.concat(['children']))
}
walk(sim)

for (const [k, arr] of seen.entries()) {
  if (arr.length > 1) {
    console.log('Duplicate generated for range', k)
    for (const a of arr) {
      console.log('  at', a.path.join('/'), 'obj=', a.obj)
    }
    throw new Error(`Duplicate generation detected for ${k} — needs fix`) 
  }
}

console.log('Simulation: no duplicate generation detected (unexpected)')

// Small targeted test: hanging-indented continuation should produce a continuation block
console.log('Demo render test: hanging-indent continuation check')
const small = `Item: one\n  continued text for item\n` // newline+indent continuation
const manualRecords: any[] = [{
  startLine: 0, endLine: 1, fileStart: 0, fileEnd: small.length,
  subEntities: [{ fileStart: 0, fileEnd: small.length, entityType: 'Primary', fields: [{ fileStart: 0, fileEnd: 5, fieldType: 'Name', confidence: 1.0 }] }]
}]
const smallElements = renderWithSpans(small, manualRecords, { type: null, value: null }, () => {})
let foundContinuation = false
function walkElems(el: any) {
  if (!el) return
  if (typeof el !== 'object') return
  const p = el.props
  if (p) {
    if (typeof p.className === 'string' && p.className.includes('raw-continuation')) {
      foundContinuation = true
    }
  }
  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach(walkElems)
  else walkElems(ch)
}
if (Array.isArray(smallElements)) smallElements.forEach(walkElems)
else walkElems(smallElements)
if (!foundContinuation) throw new Error('Expected hanging-indented continuation to produce a raw-continuation block')
console.log('✓ demo render: hanging-indent continuation produced')

// Blank-line rendering: ensure at least one newline-containing raw slice is
// emitted as a `raw-block` so blank lines are visible and preserve monospace
// layout in the UI.
let foundRawBlock = false
function walkForRawBlock(el:any){
  if (!el || typeof el !== 'object') return
  const p = el.props
  if (p && typeof p.className === 'string' && p.className.includes('raw-block')) foundRawBlock = true
  const ch = p?.children
  if (Array.isArray(ch)) ch.forEach(walkForRawBlock)
  else walkForRawBlock(ch)
}
if (Array.isArray(smallElements)) smallElements.forEach(walkForRawBlock)
else walkForRawBlock(smallElements)
if (!foundRawBlock) throw new Error('Expected at least one raw-block (blank-line rendering)')
console.log('✓ demo render: blank-line raw-blocks present')

// Ensure list indentation is preserved: verify that a bulleted line with a
// leading tab and '*' appears intact in at least one emitted raw slice.
// Locate the tab position for the sample list line
const sampleLine = '\n\t* Eats most school meals.'
const sampleIndex = normalized.indexOf(sampleLine)
if (sampleIndex < 0) throw new Error('Test setup: sample line not found in input file')
const tabPos = sampleIndex + 1 // position of the leading tab

// Verify the tab position is covered by some rendered node (raw or other)
let coveredBy:any[] = []
for (const e of __DEBUG_EMITTED_RAWS) {
  if (e.s <= tabPos && tabPos < e.e) coveredBy.push({ type: 'raw', s: e.s, e: e.e })
}

function inspectElementsForPos(el:any, acc:any[]){
  if (!el || typeof el !== 'object') return
  const p = el.props
  if (p && typeof p['data-file-start'] !== 'undefined' && typeof p['data-file-end'] !== 'undefined') {
    const s = Number(p['data-file-start'])
    const e = Number(p['data-file-end'])
    if (s <= tabPos && tabPos < e) acc.push({ className: p.className, s, e })
  }
  const ch = el.props?.children
  if (Array.isArray(ch)) ch.forEach((c:any)=>inspectElementsForPos(c, acc))
  else inspectElementsForPos(ch, acc)
}
const acc:any[] = []
if (Array.isArray(elements)) elements.forEach((el:any)=>inspectElementsForPos(el, acc))
else inspectElementsForPos(elements, acc)

if (coveredBy.length === 0 && acc.length === 0) {
  throw new Error('List indentation appears to be lost in rendering')
}
console.log('✓ demo render: list indentation preserved (verified by coverage)')

// Targeted test: render a single bulleted line where the subEntity starts mid-line.
console.log('Demo render test: subEntity boundary rendering check')
const specificText = '  * Joshua Anderson (Grandparent)'
const specificRecords: any[] = [{
  startLine: 0, endLine: 0, fileStart: 0, fileEnd: specificText.length,
  subEntities: [
    {
      startLine: 0, endLine: 0, fileStart: 10, fileEnd: specificText.length,
      entityType: 'Guardian',
      fields: [
        { lineIndex: 0, start: 3, end: 9, text: 'Joshua', fileStart: 3, fileEnd: 9, fieldType: 'ExtID', confidence: 0.119, entityStart: 3, entityEnd: 9 },
        { lineIndex: 0, start: 10, end: 18, text: 'Anderson', fileStart: 10, fileEnd: 18, fieldType: 'Name', confidence: 0.119, entityStart: 10, entityEnd: 18 },
        { lineIndex: 0, start: 19, end: 32, text: '(Grandparent)', fileStart: 19, fileEnd: 32, fieldType: 'Name', confidence: 0.1, entityStart: 19, entityEnd: 32 }
      ]
    }
  ]
}]

const specificElements = renderWithSpans(specificText, specificRecords, { type: null, value: null }, () => {})

// Collect raw-text spans and the concatenated visible text
const seenKeys = new Set()
let collectedText = ''
function collect(el:any) {
  if (!el) return
  if (typeof el === 'string') { collectedText += el; return }
  if (typeof el !== 'object') return
  const p = el.props
  if (p && typeof p.className === 'string' && p.className.includes('raw-text')) {
    const s = Number(p['data-file-start'])
    const e = Number(p['data-file-end'])
    const key = `${s}-${e}`
    if (seenKeys.has(key)) throw new Error(`Duplicate raw-text span detected in specific test: ${key}`)
    seenKeys.add(key)
  }
  const ch = p?.children
  if (Array.isArray(ch)) ch.forEach(collect)
  else collect(ch)
}
if (Array.isArray(specificElements)) specificElements.forEach(collect)
else collect(specificElements)

// Verify the visible text contains the subEntity content exactly once and the bullet only once
const occurrences = (collectedText.match(/Joshua Anderson \(Grandparent\)/g) || []).length
if (occurrences !== 1) throw new Error('Rendered subEntity content appears duplicated or missing')
const starCount = (collectedText.match(/\*/g) || []).length
if (starCount !== 1) throw new Error('Bullet character duplicated in rendering')
console.log('✓ demo render: subEntity boundary rendering OK')

