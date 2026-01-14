import { splitIntoRecordsFromLines, recordsFromLines } from '../lib/recordSplitter.js'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { test, expect } from 'vitest'

function loadCaseFile(name: string) {
  const candidates = [
    path.join(process.cwd(), 'src', 'tests', 'data', name),
    path.join(process.cwd(), 'packages', 'hilie', 'src', 'tests', 'data', name)
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`Case file ${name} not found`);
}

// Simple unit tests for the indentation-based record splitter
test('splitIntoRecordsFromLines basic indentation grouping', () => {
  const lines = [
    'Entity One',
    '\t* sub a',
    '\t* sub b',
    '',
    'Entity Two',
    '\t* sub x',
    '\t  continuation'
  ]

  const blocks = splitIntoRecordsFromLines(lines)
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks.length).toBe(2)

  expect(blocks[0]!.startLine).toBe(0)
  // blank lines are included in the first block, so endLine is 3 here
  expect(blocks[0]!.endLine).toBe(3)
  expect(blocks[1]!.startLine).toBe(4)
  expect(blocks[1]!.endLine).toBe(6)
})

test('recordsFromLines produces RecordSpan-like objects with subEntities', () => {
  const txt = "Entity A\n\t* item 1\n\t* item 2\n"
  const lines = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.length > 0)

  const recs = recordsFromLines(lines)
  expect(Array.isArray(recs)).toBe(true)
  expect(recs.length).toBe(1)

  const r = recs[0]!
  expect(r.startLine).toBe(0)
  expect(r.endLine).toBe(2)
  expect(r.subEntities && r.subEntities.length).toBe(1)
  expect(typeof r.fileStart).toBe('number')
  expect(typeof r.fileEnd).toBe('number')
})

test('recordsFromLines on case1 sample returns at least one record', () => {
  const txt = loadCaseFile('case1.txt')
  const lines = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const recs = recordsFromLines(lines)
  expect(recs.length).toBeGreaterThanOrEqual(1)
})
