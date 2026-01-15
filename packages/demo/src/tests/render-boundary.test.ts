import { describe, it, expect } from 'vitest'
import { renderWithSpans } from '../renderInternal.js'
import { renderToString } from 'react-dom/server'

describe('renderWithSpans - boundary alignment', () => {
  it('does not duplicate text when subEntity starts mid-record', () => {
    const text = '  * Joshua Anderson (Grandparent)'
    const records: any = [
      {
        startLine: 0,
        endLine: 0,
        fileStart: 0,
        fileEnd: 33,
        entities: [
          {
            startLine: 0,
            endLine: 0,
            fileStart: 10,
            fileEnd: 33,
            entityType: 'Guardian',
            fields: [
              { lineIndex: 0, start: 3, end: 9, text: 'Joshua', fileStart: 3, fileEnd: 9, fieldType: 'ExtID', confidence: 0.119, entityStart: 3, entityEnd: 9 },
              { lineIndex: 0, start: 10, end: 18, text: 'Anderson', fileStart: 10, fileEnd: 18, fieldType: 'Name', confidence: 0.119, entityStart: 10, entityEnd: 18 },
              { lineIndex: 0, start: 19, end: 32, text: '(Grandparent)', fileStart: 19, fileEnd: 32, fieldType: 'Name', confidence: 0.1, entityStart: 19, entityEnd: 32 }
            ]
          }
        ]
      }
    ]

    const hover = { type: null as any, value: null } as any
    const noop = () => {}
    const html = renderToString(renderWithSpans({ text, records, feedbackEntries: [], hoverState: hover, setHoverState: noop }) as any)
    // debug output for failing test
    console.log('HTML OUTPUT:', html)
    const textContent = html.replace(/<[^>]*>/g, '')
    expect((textContent.match(/Joshua/g) || []).length).toBe(1)
    expect((textContent.match(/Anderson/g) || []).length).toBe(1)
    expect((textContent.match(/Grandparent/g) || []).length).toBe(1)
    expect((textContent.match(/\*/g) || []).length).toBe(1)
    expect(textContent).toContain('Joshua Anderson (Grandparent)')
  })

  it('handles exact feedback position boundaries with leading tab', () => {
    const text = '\t* Joshua Anderson (Grandparent)'
    const records: any = [
      {
        startLine: 0,
        endLine: 0,
        fileStart: 0,
        fileEnd: text.length,
        entities: [
          { startLine: 0, endLine: 0, fileStart: 2, fileEnd: text.length, entityType: 'Guardian', fields: [] }
        ]
      }
    ]

    const hover = { type: null as any, value: null } as any
    const noop = () => {}
    const html = renderToString(renderWithSpans({ text, records, feedbackEntries: [], hoverState: hover, setHoverState: noop }) as any)
    expect(html).toContain('Anderson')
    const textContent = html.replace(/<[^>]*>/g, '')
    expect(textContent).toContain(text)
  })
})