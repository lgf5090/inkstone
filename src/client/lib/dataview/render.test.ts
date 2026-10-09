import { describe, expect, it } from 'vitest'
import { appendValue, renderInlineText, renderNotice, renderResult, renderTruncation } from './render'
import type { QueryRuntimeSettings } from './functions'
import { DEFAULT_QUERY_SETTINGS } from './functions'
import { DvDuration, DvLink, Grouping, type DataObject, type Literal } from './value'
import { narrowWeekdayLabels, weekStartFor } from '../time'

const settings: QueryRuntimeSettings = {
  ...DEFAULT_QUERY_SETTINGS,
  renderNullAs: '—',
  dateFormat: 'yyyy-MM-dd',
  datetimeFormat: 'yyyy-MM-dd HH:mm',
  durationFormat: 'long',
  locale: 'en-US',
}

const context = { settings, originPath: 'Home.md' }

function host(): HTMLElement {
  return document.createElement('div')
}

describe('value rendering', () => {
  it('writes plain values as text, and null as the configured placeholder', () => {
    const el = host()
    appendValue(el, 'hello', context)
    expect(el.textContent).toBe('hello')
    const nil = host()
    appendValue(nil, null, context)
    expect(nil.textContent).toBe('—')
    const custom = host()
    appendValue(custom, null, { settings: { ...settings, renderNullAs: '?' }, originPath: null })
    expect(custom.textContent).toBe('?')
  })

  it('never lets a value inject markup', () => {
    const el = host()
    appendValue(el, '<img src=x onerror=alert(1)>', context)
    expect(el.querySelector('img')).toBeNull()
    expect(el.childNodes).toHaveLength(1)
    expect((el.firstChild as Text).nodeType).toBe(Node.TEXT_NODE)
  })

  it('turns a link into the app’s own wikilink anchor', () => {
    const el = host()
    appendValue(el, DvLink.file('Reading/Alpha.md', 'Alpha'), context)
    const anchor = el.querySelector('a')!
    expect(anchor.className).toBe('wikilink')
    expect(anchor.textContent).toBe('Alpha')
    expect(anchor.getAttribute('href')).toBe('#')
    expect(anchor.dataset.wikilink).toBeTruthy()
    expect(anchor.dataset.wikilink).not.toContain('Alpha.md')
  })

  it('marks a link that points back at the note the block lives in', () => {
    const el = host()
    appendValue(el, DvLink.file('Home.md'), context)
    expect(el.querySelector('a')?.classList.contains('is-current')).toBe(true)
  })

  it('joins a list and keeps a nested list bracketed', () => {
    const flat = host()
    appendValue(flat, ['a', 'b'], context)
    expect(flat.textContent).toBe('a, b')
    const nested = host()
    appendValue(nested, [['a', 'b']], context)
    expect(nested.textContent).toBe('[a, b]')
  })

  it('renders an object as labelled pairs', () => {
    const el = host()
    appendValue(el, { rating: 5 }, context)
    expect(el.querySelector('.dataview-object-key')?.textContent).toBe('rating')
    expect(el.querySelector('.dataview-object-value')?.textContent).toBe('5')
  })

  it('renders a grouping as a list of its rows', () => {
    const el = host()
    const group = new Grouping('books', [
      { file: { link: DvLink.file('A.md') } as unknown as Literal },
      { file: { link: DvLink.file('B.md') } as unknown as Literal },
    ] as DataObject[])
    appendValue(el, group, context)
    expect(el.querySelectorAll('.dataview-group li')).toHaveLength(2)
    expect(el.textContent).toContain('A')
  })

  it('formats dates and durations with the settings pattern', () => {
    const date = host()
    appendValue(date, new Date(2024, 4, 6), context)
    expect(date.textContent).toBe('2024-05-06')
    const duration = host()
    appendValue(duration, new DvDuration({ days: 3 }), context)
    expect(duration.textContent).toBe('3 days')
  })
})

describe('inline text rendering', () => {
  it('renders the small Markdown subset a cell understands', () => {
    const el = host()
    renderInlineText(el, 'Ship **it** by [[Alpha|the first]] with `code` and #todo', context)
    expect(el.querySelector('strong')?.textContent).toBe('it')
    expect(el.querySelector('code')?.textContent).toBe('code')
    const link = el.querySelector('a.wikilink')!
    expect(link.textContent).toBe('the first')
    expect(el.querySelector('.inline-tag')?.textContent).toBe('#todo')
  })

  it('keeps the boundary character that introduced a tag', () => {
    const el = host()
    renderInlineText(el, 'and #later on', context)
    expect(el.textContent).toContain('and ')
    expect(el.querySelector('.inline-tag')).not.toBeNull()
  })

  it('does not read a heading or a bare number as a tag', () => {
    const el = host()
    renderInlineText(el, '# 12 items', context)
    expect(el.querySelector('.inline-tag')).toBeNull()
  })

  it('renders a markdown link to a note as a wikilink and an external one as an anchor', () => {
    const el = host()
    renderInlineText(el, '[site](https://example.com) and [note](Other.md)', context)
    const external = el.querySelector<HTMLAnchorElement>('a[target="_blank"]')!
    // `new URL()` is what decides the spelling, so the host is what is pinned rather than the
    // root path it adds.
    expect(external.href).toBe('https://example.com/')
    expect(external.getAttribute('rel')).toBe('noopener noreferrer')
    expect(el.querySelectorAll('a')).toHaveLength(2)
  })

  it('refuses a javascript: target', () => {
    const el = host()
    renderInlineText(el, '[boom](javascript:alert(1))', context)
    expect(el.querySelector('a[href]')).toBeNull()
    expect(el.textContent).toContain('boom')
  })

  it('leaves unmatched characters alone', () => {
    const el = host()
    renderInlineText(el, 'a * b _ c ~ d', context)
    expect(el.textContent).toBe('a * b _ c ~ d')
    expect(el.children).toHaveLength(0)
  })
})

describe('view rendering', () => {
  it('builds a table that reuses the prose table markup', () => {
    const table = renderResult({
      kind: 'table',
      names: ['name', 'rating'],
      showId: true,
      rows: [{ id: DvLink.file('A.md'), cells: [5 as Literal] }],
    }, context)
    expect(table.querySelector('table')?.classList.contains('dataview-table')).toBe(true)
    expect(table.querySelectorAll('th')).toHaveLength(2)
    expect(table.querySelector('tbody tr')?.textContent).toContain('A')
  })

  it('says so when a table matched nothing', () => {
    const table = renderResult({ kind: 'table', names: ['name'], showId: true, rows: [] }, context)
    expect(table.querySelector('.dataview-empty')?.textContent).toBeTruthy()
  })

  it('draws a task row with a static checkbox and its source link', () => {
    const tasks = renderResult({
      kind: 'task',
      tasks: [{
        source: DvLink.file('A.md'),
        task: { text: 'buy **milk**', completed: false, due: new Date(2024, 4, 6) } as unknown as DataObject,
      }],
    }, context)
    const row = tasks.querySelector('.dataview-task')!
    expect(row.querySelector('.dataview-task-checkbox.is-checked')).toBeNull()
    expect(row.querySelector('.dataview-task-text strong')?.textContent).toBe('milk')
    expect(row.querySelector<HTMLElement>('.dataview-task-chip')?.dataset.field).toBe('due')
    expect(row.querySelector('.dataview-task-source a')?.textContent).toBe('A')
  })

  it('marks a completed task both ways a reader can tell', () => {
    const tasks = renderResult({
      kind: 'task',
      tasks: [{ source: DvLink.file('A.md'), task: { text: 'done', completed: true } as unknown as DataObject }],
    }, context)
    expect(tasks.querySelector('.dataview-task-checkbox.is-checked')).not.toBeNull()
    expect(tasks.querySelector('.dataview-task-text.is-done')).not.toBeNull()
  })

  it('lays a calendar month out on the locale week start, with counts and a jump target', () => {
    const calendar = renderResult({
      kind: 'calendar',
      days: [
        { date: new Date(2024, 0, 1), rows: [{ id: DvLink.file('A.md'), data: {} }] },
        { date: new Date(2024, 0, 3), rows: [{ id: DvLink.file('B.md'), data: {} }, { id: DvLink.file('C.md'), data: {} }] },
      ],
    }, context) as HTMLElement
    expect(calendar.querySelector('.dataview-calendar-title')?.textContent).toContain('2024')
    const cells = calendar.querySelectorAll('.dataview-calendar-day')
    expect(cells.length).toBeGreaterThanOrEqual(31)
    const first = [...cells].find((cell) => cell.classList.contains('has-items'))! as unknown as HTMLElement
    expect(first.getAttribute('aria-label')).toBe('1 · 1')
    expect(first.dataset.dataviewOpen).toBeTruthy()
    expect(calendar.querySelector('.dataview-calendar-weekday')?.textContent).toBe(narrowWeekdayLabels('en-US', weekStartFor('en-US'))[0])
  })

  it('renders a list with and without its ids', () => {
    const withIds = renderResult({ kind: 'list', showId: true, items: [{ id: DvLink.file('A.md'), value: 'x' as Literal, members: [] }] }, context)
    expect(withIds.querySelector('li')?.textContent).toBe('A: x')
    const values = renderResult({ kind: 'list', showId: false, items: [{ id: DvLink.file('A.md'), value: 2 as Literal, members: [] }] }, context)
    expect(values.querySelector('li')?.textContent).toBe('2')
    const grouped = renderResult({ kind: 'list', showId: true, items: [{ id: 'Reading' as Literal, value: null, members: [DvLink.file('A.md'), DvLink.file('B.md')] }] }, context)
    expect(grouped.querySelector('li')?.textContent).toContain('Reading')
    expect(grouped.querySelector('.dataview-group')?.querySelectorAll('li')).toHaveLength(2)
    expect(grouped.querySelector('.dataview-group a.wikilink')?.textContent).toBe('A')
  })

  it('states a failure and, when asked, the detail', () => {
    const notice = renderNotice('error', 'Query failed', 'Expected a field at line 1')
    expect(notice.classList.contains('is-error')).toBe(true)
    expect(notice.querySelector('pre')?.textContent).toContain('Expected a field')
  })

  it('distinguishes a row ceiling from a body ceiling', () => {
    // The catalog is not loaded in a unit run, so what is pinned is that the two cases are
    // different messages and both are a paragraph: the placeholders themselves are checked by
    // the i18n gate, which compares the two languages for the same parameter names.
    const rows = renderTruncation(200, 412, false)
    const bodies = renderTruncation(500, 500, true)
    expect(rows.tagName).toBe('P')
    expect(bodies.tagName).toBe('P')
    expect(rows.textContent).not.toBe(bodies.textContent)
  })
})

describe('the settings a drawn result honours', () => {
  const oneRow = [{ id: DvLink.file('A.md'), cells: [5 as Literal] }]

  it('prints the tally only when it was asked for', () => {
    const counted = renderResult({ kind: 'table', names: ['File', 'rating'], showId: true, rows: oneRow }, { ...context, settings: { ...settings, showResultCount: true } })
    expect(counted.querySelector('.dataview-result-count')?.getAttribute('data-count')).toBe('1')
    expect(counted.querySelector('table')).not.toBeNull()
    const plain = renderResult({ kind: 'table', names: ['File', 'rating'], showId: true, rows: oneRow }, { ...context, settings: { ...settings, showResultCount: false } })
    expect(plain.querySelector('.dataview-result-count')).toBeNull()
    expect(plain.classList.contains('dataview-table-wrap')).toBe(true)
  })

  it('leaves the gap when the empty warning is turned off', () => {
    const quiet = renderResult({ kind: 'table', names: ['File'], showId: true, rows: [] }, { ...context, settings: { ...settings, warnOnEmptyResult: false } })
    expect(quiet.querySelector('.dataview-empty')).toBeNull()
  })

  it('stops expanding a value at the depth it was given', () => {
    const deep = [[[['x']]]] as unknown as Literal
    const shallow = document.createElement('td')
    appendValue(shallow, deep, { ...context, settings: { ...settings, maxRecursiveRenderDepth: 1 } })
    expect(shallow.textContent).not.toContain('x')
    expect(shallow.textContent).toContain('…')
    const roomy = document.createElement('td')
    appendValue(roomy, deep, { ...context, settings: { ...settings, maxRecursiveRenderDepth: 8 } })
    expect(roomy.textContent).toContain('x')
    expect(roomy.textContent).not.toContain('…')
  })
})
