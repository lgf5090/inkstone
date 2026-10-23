/**
 * The chooser as a surface a reader can use with no mouse.
 *
 * The runs themselves are faked: this file is about which template the reader reached, what the create form
 * handed along, and what the list says when it has nothing to show. `run-shell.test.ts` is where the run is
 * proved, and proving both from here would mean a second copy of the engine's fixtures in a UI test.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary, NoteTemplate } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { Z_INDEX } from '../../lib/z-index'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useUi } from '../../store/ui'
import { TemplatePicker, TemplaterPickerHost } from './template-picker'
import { closeTemplaterPicker, openTemplaterPicker, peekTemplaterPicker, type TemplaterPickerMode } from './picker-request'

const calls = vi.hoisted(() => ({
  insert: [] as string[],
  create: [] as { template: string; folderId: string | null; title: string }[],
  replace: [] as string[],
  /** Which of the three answers "the note was not written", so the refusal cases can keep the dialog open. */
  refuse: false,
}))

vi.mock('./run-shell', () => ({
  async insertTemplateIntoActiveNote(template: NoteTemplate) {
    calls.insert.push(template.name)
    return !calls.refuse
  },
  async createNoteFromTemplate(template: NoteTemplate, destination: { folderId: string | null; title: string }) {
    calls.create.push({ template: template.name, ...destination })
    return !calls.refuse
  },
  async replaceActiveNoteWithTemplate(template: NoteTemplate) {
    calls.replace.push(template.name)
    return !calls.refuse
  },
  async confirmReplace() {
    return true
  },
}))

/**
 * Template names in the language the reader types them in, because the filter is a pinyin path.
 * `check-i18n.mjs` keeps Han out of `src/` since interface copy belongs in the catalog; a name a reader
 * wrote is not interface copy, and this is the same exemption the QuickAdd launcher's cases take.
 */
const NAMES = {
  daily: '每日笔记',
  meeting: '会议纪要',
  tagged: '读书',
  query: '会议',
  noMatch: '不存在的东西',
}

function template(id: string, name: string, over: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id,
    categoryId: null,
    name,
    description: '',
    content: 'x',
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const DAILY = template('tpl-daily', NAMES.daily, { categoryId: 'cat-journal' })
const MEETING = template('tpl-meeting', NAMES.meeting, { description: 'One page per meeting' })
const READING = template('tpl-reading', NAMES.tagged, { tags: ['书'] })

const OPEN_NOTE: NoteSummary = {
  id: 'n1',
  title: 'Open note',
  excerpt: '',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 1,
  charCount: 4,
  rev: 1,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

let rendered: RenderedElement | null = null
let closed = 0

function open(mode: TemplaterPickerMode = 'insert'): void {
  closed = 0
  rendered = renderElement(createElement(TemplatePicker, { mode, onClose: () => { closed += 1 } }))
}

function dialog(): HTMLElement {
  const node = document.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('the chooser is not mounted')
  return node
}

function rows(): HTMLElement[] {
  return [...dialog().querySelectorAll('[role="option"]')] as HTMLElement[]
}

function filter(): HTMLInputElement {
  const input = dialog().querySelector('input[type="search"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('the chooser has no filter box')
  return input
}

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(filter(), value)
    filter().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  act(() => {
    filter().dispatchEvent(event)
  })
  return event
}

function clickText(fragment: string): void {
  const button = [...dialog().querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(fragment))
  if (!button) throw new Error(`no control labelled "${fragment}"`)
  act(() => {
    button.click()
  })
}

function clickRow(index: number): void {
  const row = rows()[index]
  if (!row) throw new Error(`no chooser row at ${index}`)
  act(() => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function switchTo(mode: 'insert' | 'create'): void {
  const wanted = mode === 'create' ? t('templates.new_note_from_template') : t('templates.insert_into_note')
  const radio = [...dialog().querySelectorAll('[role="radio"]')].find((node) => node.textContent === wanted)
  if (!(radio instanceof HTMLButtonElement)) throw new Error(`no mode choice for ${wanted}`)
  act(() => {
    radio.click()
  })
}

function drawer(): HTMLElement | null {
  return document.querySelector('[data-surface="drawer"]')
}

function settle(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  calls.insert = []
  calls.create = []
  calls.replace = []
  calls.refuse = false
  document.body.replaceChildren()
  useNoteTemplates.setState({
    templates: [DAILY, MEETING, READING],
    categories: [{ id: 'cat-journal', name: '日志', builtin: false, position: 0, createdAt: 1 }],
    hydrated: true,
    owner: 'u1',
  })
  useNotes.setState({
    notes: { n1: { ...OPEN_NOTE } },
    contents: { n1: 'body' },
    folders: [
      { id: 'f-a', parentId: null, name: 'Journal', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 },
      { id: 'f-b', parentId: 'f-a', name: '2026', icon: null, color: null, position: 1, createdAt: 1, updatedAt: 1 },
    ],
  })
  useUi.setState({ activeNoteId: 'n1', toasts: [], panel: null, folderId: null })
  // The ask is module state; a case that leaves one standing must not hand it to the next one.
  closeTemplaterPicker()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

describe('the list', () => {
  it('shows every template the reader has, and names the one that is filed somewhere', () => {
    open()
    const names = rows().map((row) => row.textContent ?? '')
    expect(names.join('|')).toContain(NAMES.daily)
    expect(names.join('|')).toContain(NAMES.meeting)
    expect(names.join('|')).toContain(NAMES.tagged)
    // The category is the second line of the row it belongs to, and the description of the one without.
    expect(names.find((name) => name.includes(NAMES.daily))).toContain('日志')
    expect(names.find((name) => name.includes(NAMES.meeting))).toContain('One page per meeting')
  })

  it('narrows to what the reader types, by name, category or tag', () => {
    open()
    type(NAMES.query)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain(NAMES.meeting)
    type('')
    expect(rows()).toHaveLength(3)
    type('书')
    expect(rows().map((row) => row.textContent ?? '')).toEqual([expect.stringContaining(NAMES.tagged)])
    type('日志')
    expect(rows().map((row) => row.textContent ?? '')).toEqual([expect.stringContaining(NAMES.daily)])
  })

  it('keeps the highlight on the row the arrows land on, and announces it', () => {
    open()
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    expect(filter().getAttribute('aria-activedescendant')).toBe(rows()[0]?.id)
    press('ArrowDown')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(filter().getAttribute('aria-activedescendant')).toBe(rows()[1]?.id)
    press('End')
    expect(rows()[2]?.getAttribute('aria-selected')).toBe('true')
    press('Home')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    expect(filter().getAttribute('aria-controls')).toBe(dialog().querySelector('[role="listbox"]')?.id)
  })

  it('runs the highlighted row on Enter and closes', async () => {
    open()
    press('ArrowDown')
    press('Enter')
    await settle()
    expect(calls.insert).toEqual([NAMES.meeting])
    expect(closed).toBe(1)
  })

  it('walks back up the list and turns around at either end', () => {
    // Two halves of one rule the arrows share: the highlight is a cursor over a ring, not a pointer that
    // stops at the first row. A reader who lands in the chooser with the arrows, and reaches the top, gets
    // the same answer as one who came down from the bottom — and `aria-activedescendant` has to follow it,
    // or the screen reader announces a row the Enter key will not run.
    open()
    press('ArrowUp')
    expect(rows()[2]?.getAttribute('aria-selected'), 'ArrowUp on the first row goes to the last').toBe('true')
    expect(filter().getAttribute('aria-activedescendant')).toBe(rows()[2]?.id)
    press('ArrowUp')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    press('ArrowDown')
    press('ArrowDown')
    expect(rows()[0]?.getAttribute('aria-selected'), 'ArrowDown past the last row comes back to the first').toBe('true')
  })

  it('runs nothing when the arrows and Enter find no row at all', async () => {
    // The list is empty because the filter hid every template, so the cursor has nowhere to go. Pressing
    // through it must not be a crash and must not be a run of some row the reader cannot see; and Enter
    // stays the browser's, because a keystroke that runs nothing should not be swallowed either.
    open()
    type(NAMES.noMatch)
    expect(press('ArrowDown').defaultPrevented, 'the arrows still own the keystroke they answer').toBe(true)
    expect(press('Enter').defaultPrevented, 'Enter with no row is not consumed').toBe(false)
    press('ArrowUp')
    press('Enter')
    await settle()
    expect(rows()).toHaveLength(0)
    expect(calls.insert).toEqual([])
    expect(closed).toBe(0)
    expect(filter().getAttribute('aria-activedescendant')).toBeNull()
  })

  it('says the library is empty and offers the way out of that', () => {
    useNoteTemplates.setState({ templates: [] })
    open()
    expect(rows()).toHaveLength(0)
    expect(dialog().textContent).toContain(t('templates.no_templates'))
    clickText(t('templates.open_template_library'))
    expect(useUi.getState().panel).toBe('templates')
    expect(closed).toBe(1)
  })

  it('reports no match rather than an empty library when the filter finds nothing', () => {
    open()
    type(NAMES.noMatch)
    expect(rows()).toHaveLength(0)
    expect(dialog().textContent).toContain(t('templates.no_matching_templates'))
    expect(dialog().textContent).not.toContain(t('templates.no_templates'))
  })

  it('stays open when the run refused, because the reader may have another template in mind', async () => {
    calls.refuse = true
    open()
    clickRow(0)
    await settle()
    expect(calls.insert).toEqual([NAMES.daily])
    expect(closed).toBe(0)
  })
})

describe('the create form', () => {
  it('carries the name and the folder the reader chose', async () => {
    open('create')
    // Queried by what the reader sees rather than by `input[type=text]`: the app's `Input` carries no `type`
    // attribute (the browser default is what it wants), so a type selector would test an attribute no other
    // field in the app has.
    const name = dialog().querySelector<HTMLInputElement>(`input[placeholder="${t('templater.picker.name_placeholder')}"]`)
    if (!(name instanceof HTMLInputElement)) throw new Error('the create form has no name field')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(name, '2026-10-21')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      dialog().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click()
    })
    // The destination is the app's own folder drawer, not a second folder control.
    const choice = [...(drawer()?.querySelectorAll('button[type="button"]') ?? [])]
      .find((button) => button.textContent?.includes('Journal / 2026'))
    if (!choice) throw new Error('the folder drawer did not offer the nested folder')
    act(() => {
      (choice as HTMLElement).click()
    })
    expect(drawer()).toBeNull()
    clickRow(1)
    await settle()
    expect(calls.create).toEqual([{ template: NAMES.meeting, folderId: 'f-b', title: '2026-10-21' }])
    expect(calls.insert).toEqual([])
  })

  it('lifts the destination rail above the dialog that opened it', () => {
    // The dialog's scrim covers the whole viewport, so a rail left on the drawer tier cannot be pressed at
    // all: the press lands on the scrim, which closes the dialog — and the reader's half-filled form goes
    // with it. jsdom does no hit-testing, so the tier the call site asks for is what this can hold; that the
    // tier itself clears `--z-modal` is policed in `tests/shared-component-contract.test.ts`.
    open('create')
    act(() => {
      dialog().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click()
    })
    const rail = drawer()?.parentElement
    expect(rail?.style.zIndex, 'the folder rail carries no stack level').toBe(String(Z_INDEX.picker))
  })

  it('switches between the two modes without leaving the dialog', () => {
    const nameField = () => dialog().querySelector(`input[placeholder="${t('templater.picker.name_placeholder')}"]`)
    open('insert')
    expect(nameField()).toBeNull()
    switchTo('create')
    expect(nameField()).not.toBeNull()
    switchTo('insert')
    expect(nameField()).toBeNull()
    // The dialog itself is still the one that opened: switching modes is not a second screen.
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
  })

  it('defaults the folder to the one the reader is browsing', async () => {
    useUi.setState({ folderId: 'f-a' })
    open('create')
    press('Enter')
    await settle()
    expect(calls.create).toEqual([{ template: NAMES.daily, folderId: 'f-a', title: '' }])
  })

  it('shows the destination as the path the reader recognises', () => {
    open('create')
    // Nothing chosen and nothing browsed: the note would land at the top level, and the button says so.
    expect(dialog().querySelector('[aria-haspopup="dialog"]')?.textContent).toBe(t('folders.top_level'))
    rendered?.unmount()
    rendered = null
    useUi.setState({ folderId: 'f-a' })
    open('create')
    expect(dialog().querySelector('[aria-haspopup="dialog"]')?.textContent).toBe('Journal')
  })

  it('keeps replace on one surface, so a command named for it cannot be switched out of', async () => {
    open('replace')
    expect(dialog().querySelector('[role="radio"]'), 'replace is not a choice the list offers').toBeNull()
    expect(dialog().textContent).toContain(t('templater.cmd.replace'))
    clickRow(0)
    await settle()
    expect(calls.replace).toEqual([NAMES.daily])
    expect(calls.insert).toEqual([])
  })
})

describe('the dialog chrome', () => {
  it('hands the focus back to whatever opened it', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    open()
    expect(document.activeElement).toBe(filter())
    rendered?.unmount()
    rendered = null
    expect(document.activeElement, 'closing gives the caret back where it came from').toBe(trigger)
  })

  it('closes on Escape', () => {
    open()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(closed).toBe(1)
  })
})

describe('the host', () => {
  it('drops the ask once the panel that was hosting it has moved on', () => {
    // The library is what hosts the chooser, so closing the library takes the dialog down with it. An ask
    // left standing behind that comes back on the next library press — a dialog for a run nobody asked for
    // twice, which is what this pins shut.
    useUi.setState({ panel: 'templates' })
    rendered = renderElement(createElement(TemplaterPickerHost))
    act(() => {
      openTemplaterPicker('insert')
    })
    expect(document.querySelector('[role="dialog"]'), 'the host adopted the ask').not.toBeNull()
    useUi.setState({ panel: null })
    rendered.unmount()
    rendered = null
    expect(peekTemplaterPicker()).toBeNull()
    rendered = renderElement(createElement(TemplaterPickerHost))
    expect(document.querySelector('[role="dialog"]'), 'reopening the library finds nothing waiting').toBeNull()
  })

  it('keeps the ask standing through a remount of the same panel', () => {
    // StrictMode unwinds an effect just after mounting it, and nothing has moved on in that moment. Reading
    // that teardown as the reader leaving would swallow the press that opened the chooser in the first place.
    useUi.setState({ panel: 'templates' })
    const first = renderElement(createElement(TemplaterPickerHost))
    act(() => {
      openTemplaterPicker('create')
    })
    first.unmount()
    expect(peekTemplaterPicker(), 'a remount is not a departure').not.toBeNull()
    rendered = renderElement(createElement(TemplaterPickerHost))
    expect(document.querySelector('[role="dialog"]'), 'the chooser is back up after the remount').not.toBeNull()
  })
})
