import { describe, expect, it } from 'vitest'
import { parseMarkdownTable } from '../../../lib/markdown/table-editor'
import { renderMarkdown } from '../../../lib/markdown/renderer'
import { addressOfCell, domAgreesWithParser, domShapeOf, findEditableTable, sourceLineOf } from './dom'

const HTML = `
<div class="ink-prose">
  <div class="table-wrap" data-line="7"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>
  <div class="table-wrap"><table><tr><td>x</td></tr></table></div>
  <div class="note-embed-body"><div class="table-wrap" data-line="2"><table><tr><td>y</td></tr></table></div></div>
  <div data-kanban="1"><div class="table-wrap" data-line="3"><table><tr><td>z</td></tr></table></div></div>
  <div class="table-wrap" data-line="9"><p>not a table</p></div>
</div>`

function root(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = HTML
  return host
}

function cellAt(host: HTMLElement, index: number): HTMLElement {
  return host.querySelectorAll('td, th')[index]! as HTMLElement
}

describe('findEditableTable', () => {
  it('finds the wrapper of a table the note can address', () => {
    const host = root()
    const wrap = findEditableTable(cellAt(host, 0))
    expect(wrap?.dataset.line).toBe('7')
  })

  it('refuses a table with no source line, which has nowhere to write back to', () => {
    const host = root()
    expect(findEditableTable(cellAt(host, 6))).toBeNull()
  })

  it('refuses an embedded note and a board card, whose lines belong to other documents', () => {
    const host = root()
    expect(findEditableTable(cellAt(host, 7))).toBeNull()
    expect(findEditableTable(cellAt(host, 8))).toBeNull()
  })

  it('refuses a wrapper holding no table at all', () => {
    const host = root()
    expect(findEditableTable(host.querySelector('.table-wrap[data-line="9"]'))).toBeNull()
  })

  it('refuses a pointer that is not over a table', () => {
    const host = root()
    expect(findEditableTable(host.querySelector('.ink-prose'))).toBeNull()
    expect(findEditableTable(null)).toBeNull()
  })
})

describe('sourceLineOf', () => {
  it('reads the header line the renderer stamped', () => {
    const host = root()
    expect(sourceLineOf(findEditableTable(cellAt(host, 0))!)).toBe(7)
  })
})

describe('domShapeOf', () => {
  it('counts every row including the header, and the columns of the first', () => {
    const host = root()
    expect(domShapeOf(findEditableTable(cellAt(host, 0))!)).toEqual({ rows: 3, columns: 2 })
  })
})

describe('addressOfCell', () => {
  it('names the header row as -1, the way the parser counts it', () => {
    const host = root()
    expect(addressOfCell(cellAt(host, 0))).toEqual({ rowIndex: -1, colIndex: 0 })
    expect(addressOfCell(cellAt(host, 1))).toEqual({ rowIndex: -1, colIndex: 1 })
  })

  it('counts body rows from zero', () => {
    const host = root()
    expect(addressOfCell(cellAt(host, 2))).toEqual({ rowIndex: 0, colIndex: 0 })
    expect(addressOfCell(cellAt(host, 5))).toEqual({ rowIndex: 1, colIndex: 1 })
  })

  it('refuses an element that is not in a table', () => {
    const host = root()
    expect(addressOfCell(host.querySelector('.ink-prose')!)).toBeNull()
  })
})

/**
 * What the bubble refuses to touch, measured against the renderer rather than against a hand-written
 * table: the note counts a header line, a delimiter line and N body lines, while the drawn table
 * counts a header row and N body rows. A test that only ever saw one of the two numbers could not
 * tell those apart, and the first version of this gate did exactly that — and so hid every handle.
 */
describe('domAgreesWithParser against the real renderer', () => {
  const rendered = (body: string) => {
    const host = document.createElement('div')
    host.className = 'ink-prose'
    host.innerHTML = renderMarkdown(body, {}).html
    return host
  }

  for (const rows of [1, 2, 3, 8]) {
    it(`accepts a table of ${rows} body row${rows === 1 ? '' : 's'}`, () => {
      const lines = [
        '| a | b |',
        '| --- | ---: |',
        ...Array.from({ length: rows }, (_, index) => `| ${index} | ${index * 2} |`),
      ]
      const host = rendered(lines.join('\n'))
      const wrap = findEditableTable(host.querySelector('td'))
      expect(wrap).not.toBeNull()
      const parsed = parseMarkdownTable(lines, Number(wrap!.dataset.line))
      expect(parsed).not.toBeNull()
      expect(domAgreesWithParser(parsed!, domShapeOf(wrap!))).toBe(true)
      expect(parsed!.columnCount).toBe(domShapeOf(wrap!)!.columns)
    })
  }

  it('rejects a block the parser read longer than the table on screen', () => {
    const lines = ['| a | b |', '| --- | --- |', '| 1 | 2 |']
    const parsed = parseMarkdownTable(lines, 0)!
    expect(domAgreesWithParser(parsed, { rows: parsed.rows.length, columns: 2 })).toBe(false)
    expect(domAgreesWithParser(parsed, { rows: parsed.rows.length + 2, columns: 2 })).toBe(false)
    expect(domAgreesWithParser(parsed, null)).toBe(false)
  })

  it('accepts the table a note of several blocks renders', () => {
    const body = ['# Title', '', 'a leading paragraph', '', '| item | qty |', '| :-: | -: |', '| computer | 5 |', '| phone | 50 |', '', 'a trailing paragraph'].join('\n')
    const host = rendered(body)
    const wrap = findEditableTable(host.querySelector('td'))!
    const line = Number(wrap.dataset.line)
    const parsed = parseMarkdownTable(body.split('\n'), line)!
    expect(domAgreesWithParser(parsed, domShapeOf(wrap))).toBe(true)
  })
})
