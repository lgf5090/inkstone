import { act, createElement, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { NoteNameInput, type NoteNameCandidate } from './note-name-input'

const NOTES: NoteNameCandidate[] = [
  { title: 'Standup', folderPath: 'Work' },
  { title: 'Standup', folderPath: 'Journal' },
  { title: 'Reading', folderPath: null },
  { title: 'Inbox', folderPath: 'Work/Deep' },
]

let rendered: RenderedElement | null = null

function field(): HTMLInputElement {
  const input = rendered?.container.querySelector('input')
  if (!input) throw new Error('the field did not render')
  return input
}

function rows(): string[] {
  return [...(rendered?.container.querySelectorAll('[role=option]') ?? [])]
    .map((row) => row.textContent ?? '')
}

function open(): boolean {
  return rendered?.container.querySelector('[role=listbox]') !== null
}

function render(notes: NoteNameCandidate[], value = '', onCommit: (next: string) => void = () => {}): void {
  held = notes
  current = value
  commit = onCommit
  rendered = renderElement(fieldElement())
}

/** The field is controlled, so a keystroke is the draft's own state changing under it. */
function fieldElement() {
  return createElement(NoteNameInput, {
    notes: held,
    value: current,
    onChange: (next: string) => {
      current = next
      commit(next)
      rendered?.rerender(fieldElement())
    },
  })
}

let held: NoteNameCandidate[] = []
let current = ''
let commit: (next: string) => void = () => {}

function focusField(): void {
  act(() => {
    field().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

function type(text: string): void {
  act(() => {
    current = text
    rendered?.rerender(fieldElement())
  })
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    field().dispatchEvent(event)
  })
  return event
}

function clickRow(index: number): void {
  const row = rendered?.container.querySelectorAll('[role=option]')[index]
  if (!row) throw new Error(`there is no row ${index}`)
  act(() => {
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    ;(row as HTMLElement).click()
  })
}

beforeAll(async () => {
  await initI18n()
})

describe('the target-note field', () => {
  it('keeps the list closed until the field has focus', () => {
    render(NOTES)
    expect(open()).toBe(false)
    focusField()
    expect(open()).toBe(true)
    rendered?.unmount()
  })

  it('says where each name lives, and hands back only the title', () => {
    const given: string[] = []
    render(NOTES, '', (next) => given.push(next))
    focusField()
    expect(rows()).toEqual([
      `Standup (Work, Journal)`,
      'Reading',
      `Inbox (Work/Deep)`,
    ])
    clickRow(2)
    expect(given).toEqual(['Inbox'])
    expect(open()).toBe(false)
    rendered?.unmount()
  })

  it('names the copy that sits at the root beside the filed ones', () => {
    const made = renderRows([{ title: 'Standup', folderPath: 'Work' }, { title: 'Standup', folderPath: null }])
    expect(made).toEqual([`Standup (Work, ${t('navigation.unfiled')})`])
  })

  it('leaves a root-only name alone, because there is nothing left to tell apart', () => {
    expect(renderRows([{ title: 'Reading', folderPath: null }])).toEqual(['Reading'])
  })

  it('filters by the letters a reader types', () => {
    render(NOTES)
    focusField()
    type('stan')
    expect(rows()).toEqual(['Standup (Work, Journal)'])
    rendered?.unmount()
  })

  it('filters by the folder a name lives in when the query is a pattern', () => {
    render(NOTES)
    focusField()
    type('/Work/')
    expect(rows()).toEqual(['Standup (Work, Journal)', 'Inbox (Work/Deep)'])
    rendered?.unmount()
  })

  it('says which pattern it refused instead of listing nothing', () => {
    render(NOTES)
    focusField()
    type('/(/')
    expect(open()).toBe(false)
    expect(rendered?.container.textContent).toContain(t('filter.regex_syntax'))
    rendered?.unmount()
  })

  it('moves the caret with the arrow keys and commits the row that holds it', () => {
    const given: string[] = []
    render(NOTES, '', (next) => given.push(next))
    focusField()
    // The first row holds the caret the moment the list opens, so two steps land on the third name.
    press('ArrowDown')
    press('ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).toBe(
      field().getAttribute('aria-controls') ? `${field().getAttribute('aria-controls')}-2` : null,
    )
    press('Enter')
    expect(given).toEqual(['Inbox'])
    rendered?.unmount()
  })

  it('walks back up the list', () => {
    const given: string[] = []
    render(NOTES, '', (next) => given.push(next))
    focusField()
    press('ArrowDown')
    press('ArrowUp')
    press('Enter')
    expect(given).toEqual(['Standup'])
    rendered?.unmount()
  })

  it('leaves Enter to the rest of the page while the list is closed', () => {
    render(NOTES)
    const event = press('Enter')
    expect(event.defaultPrevented).toBe(false)
    rendered?.unmount()
  })

  it('gives the first Escape to the list and the second one to whatever holds the field', () => {
    let bubbled = 0
    const outer = (event: ReactKeyboardEvent) => {
      bubbled += 1
      void event
    }
    rendered = renderElement(createElement('div', { onKeyDown: outer },
      createElement(NoteNameInput, { notes: NOTES, value: '', onChange: () => {} })))
    focusField()
    expect(open()).toBe(true)
    press('Escape')
    expect(open()).toBe(false)
    expect(bubbled).toBe(0)
    press('Escape')
    expect(bubbled).toBe(1)
    rendered.unmount()
  })

  it('holds the field open through the mousedown that reaches for a row', () => {
    render(NOTES)
    focusField()
    const row = rendered?.container.querySelector('[role=option]')
    if (!row) throw new Error('no row to press')
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      row.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    rendered?.unmount()
  })

  it('caps the list and says how many names it left out', () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ title: `Note ${index + 1}`, folderPath: null }))
    render(many)
    focusField()
    expect(rows().length).toBe(50)
    expect(rendered?.container.textContent).toContain(t('quickadd.suggest_more').replace('{count}', '1'))
    rendered?.unmount()
  })

  it('tells an empty library apart from a name that matches nothing', () => {
    render([])
    focusField()
    expect(rendered?.container.textContent).toContain(t('quickadd.suggest_none_yet'))
    rendered?.unmount()

    render(NOTES)
    focusField()
    type('zzzz-no-such-note')
    expect(rendered?.container.textContent).toContain(t('quickadd.suggest_no_match'))
    rendered?.unmount()
  })

  it('lists two notes that share a name and a folder as one row, because nothing can tell them apart', () => {
    const made = renderRows([
      { title: 'Standup', folderPath: 'Work' },
      { title: 'Standup', folderPath: 'Work' },
    ])
    expect(made).toEqual(['Standup (Work)'])
  })

  it('points aria-controls at the list it is actually showing', () => {
    render(NOTES)
    expect(field().getAttribute('aria-controls')).toBeNull()
    focusField()
    const listId = field().getAttribute('aria-controls')
    if (!listId) throw new Error('the field lost its list id')
    expect(rendered?.container.querySelector(`#${CSS.escape(listId)}`)).not.toBeNull()
    rendered?.unmount()
  })
})

function renderRows(notes: NoteNameCandidate[]): string[] {
  render(notes)
  focusField()
  const made = rows()
  rendered?.unmount()
  return made
}
