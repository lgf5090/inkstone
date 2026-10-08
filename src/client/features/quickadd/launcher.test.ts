import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultQuickAddSettings,
  newCaptureChoice,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  type QuickAddChoice,
} from '@shared/quickadd'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useQuickAdd } from '../../store/quickadd'
import { useUi } from '../../store/ui'
import QuickAddLauncher from './launcher'

const runs = vi.hoisted(() => ({
  calls: [] as { id: string; sourceNoteId?: string; day: Date | null }[],
  day: null as string | null,
}))

vi.mock('../../lib/quickadd/runner', () => ({
  runQuickAddChoice: async (id: string, options: { sourceNoteId?: string; day?: Date } = {}) => {
    runs.calls.push({ id, sourceNoteId: options.sourceNoteId, day: options.day ?? null })
    return { kind: 'written', noteId: 'n-target', created: false, summary: 'ran' }
  },
}))

vi.mock('./prompt-queue', () => ({
  askQuickAddPrompts: async () => (runs.day === null ? new Map<string, string>() : new Map([['day', runs.day]])),
  recallDraft: () => null,
  currentPromptGroup: () => null,
  currentPromptSequence: () => 0,
  resetQuickAddPrompts: () => {},
  subscribeQuickAddPrompts: () => () => {},
}))

let rendered: RenderedElement
let closed: number

function library(choices: QuickAddChoice[], recent: { id: string; at: number }[] = []) {
  useQuickAdd.setState({
    choices,
    settings: { ...defaultQuickAddSettings(), recent },
    hydrated: true,
    owner: 'user-1',
  })
}

function openLauncher(): void {
  closed = 0
  rendered = renderElement(createElement(QuickAddLauncher, { onClose: () => { closed += 1 } }))
}

function dialog(): HTMLElement {
  const node = document.querySelector('[role="dialog"]')
  if (!(node instanceof HTMLElement)) throw new Error('the launcher is not mounted')
  return node
}

function rows(): HTMLElement[] {
  return [...dialog().querySelectorAll('[role="option"]')] as HTMLElement[]
}

function filterInput(): HTMLInputElement {
  const input = dialog().querySelector('input[type="search"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('the launcher has no filter box')
  return input
}

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(filterInput(), value)
    filterInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, options: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  act(() => {
    filterInput().dispatchEvent(event)
  })
}

function clickRow(index: number, options: { shift?: boolean } = {}): void {
  const row = rows()[index]
  if (!row) throw new Error(`no launcher row at ${index}`)
  act(() => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: options.shift === true }))
  })
}

function settle(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function clickLabeled(label: string): void {
  const button = [...dialog().querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!button) throw new Error(`no control labelled "${label}"`)
  act(() => {
    button.click()
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  runs.calls = []
  runs.day = null
  document.body.replaceChildren()
  useUi.setState({ activeNoteId: 'n-open' })
})

afterEach(() => {
  rendered?.unmount()
  useQuickAdd.setState({ choices: [], settings: defaultQuickAddSettings(), hydrated: false, owner: '' })
})

/**
 * Choice names in the language the app's other readers write in. The filter is a fuzzy + pinyin path,
 * so the test has to feed it Chinese names; `check-i18n.mjs` keeps Han literals out of `src/` because
 * interface copy belongs in the catalog, and a name the reader typed is not interface copy.
 */
const CJK_CHOICE_FIXTURES = {
  daily: '每日笔记',
  inbox: '收集箱',
  off: '关掉的宏',
  group: '日志',
  weekly: '周记',
  inboxQuery: '收集',
  noMatch: '不存在的东西',
}

const DAILY = { ...newTemplateChoice('qa-daily', CJK_CHOICE_FIXTURES.daily, 0), asCommand: true }
const INBOX = { ...newCaptureChoice('qa-inbox', CJK_CHOICE_FIXTURES.inbox, 1), targetTitle: CJK_CHOICE_FIXTURES.inbox }
const OFF = { ...newMacroChoice('qa-off', CJK_CHOICE_FIXTURES.off, 2), enabled: false }
const GROUP = newGroupChoice('qa-group', CJK_CHOICE_FIXTURES.group, 3)
const CHILD = { ...newCaptureChoice('qa-child', CJK_CHOICE_FIXTURES.weekly, 0), parentId: 'qa-group' }

describe('the launcher list', () => {
  it('shows enabled top-level choices and nothing else', () => {
    library([DAILY, INBOX, OFF, GROUP, CHILD])
    openLauncher()
    const names = rows().map((row) => row.textContent ?? '')
    expect(names.join('|')).toContain(CJK_CHOICE_FIXTURES.daily)
    expect(names.join('|')).toContain(CJK_CHOICE_FIXTURES.inbox)
    expect(names.join('|')).toContain(CJK_CHOICE_FIXTURES.group)
    expect(names.join('|')).not.toContain(CJK_CHOICE_FIXTURES.off)
    expect(names.join('|')).not.toContain(CJK_CHOICE_FIXTURES.weekly)
  })

  it('names every row by what it is, so a keyboard reader hears the type', () => {
    library([DAILY, GROUP])
    openLauncher()
    const text = rows().map((row) => row.textContent ?? '').join('|')
    expect(text).toContain(t('quickadd.type_template'))
    expect(text).toContain(t('quickadd.type_group'))
    expect(filterInput().getAttribute('aria-label')).toBe(t('quickadd.launcher_filter'))
  })

  it('filters by what the reader types and runs the match on Enter', async () => {
    library([DAILY, INBOX])
    openLauncher()
    type(CJK_CHOICE_FIXTURES.inboxQuery)
    press('Enter')
    await settle()
    expect(runs.calls).toEqual([{ id: 'qa-inbox', sourceNoteId: 'n-open', day: null }])
    expect(closed).toBe(1)
  })

  it('moves the highlight with the arrow keys and wraps at both ends', () => {
    library([DAILY, INBOX])
    openLauncher()
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    press('ArrowDown')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')
    press('ArrowUp')
    press('ArrowUp')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    press('Home')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    press('End')
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('drills into a group instead of running it', async () => {
    library([DAILY, GROUP, CHILD])
    openLauncher()
    press('ArrowDown')
    press('Enter')
    await settle()
    expect(runs.calls).toEqual([])
    expect(closed).toBe(0)
    expect(dialog().textContent).toContain(CJK_CHOICE_FIXTURES.group)
    const names = rows().map((row) => row.textContent ?? '')
    expect(names.join('|')).toContain(CJK_CHOICE_FIXTURES.weekly)
    expect(names.join('|')).not.toContain(CJK_CHOICE_FIXTURES.daily)
    clickLabeled(t('quickadd.launcher_up'))
    expect(rows().map((row) => row.textContent ?? '').join('|')).toContain(CJK_CHOICE_FIXTURES.daily)
  })

  it('leaves a group with Backspace when nothing is typed', async () => {
    library([GROUP, CHILD])
    openLauncher()
    press('Enter')
    await settle()
    expect(rows().length).toBe(1)
    press('Backspace')
    expect(rows().map((row) => row.textContent ?? '').join('|')).toContain(CJK_CHOICE_FIXTURES.group)
  })

  it('lists by the order the author set, not by the order the records were saved', () => {
    // A reorder changes `position` and leaves the array alone, so a list that trusted array order
    // would keep showing the old one.
    library([
      { ...DAILY, position: 3 },
      { ...INBOX, position: 1 },
    ])
    openLauncher()
    const names = rows().map((row) => row.textContent ?? '')
    expect(names).toHaveLength(2)
    expect(names[0]).toContain(CJK_CHOICE_FIXTURES.inbox)
    expect(names[1]).toContain(CJK_CHOICE_FIXTURES.daily)
  })

  it('leads the top of the tree with recent runs, without listing them twice', () => {
    library([DAILY, INBOX], [{ id: 'qa-inbox', at: 2 }, { id: 'qa-gone', at: 1 }])
    openLauncher()
    const names = rows().map((row) => row.textContent ?? '')
    expect(names[0]).toContain(CJK_CHOICE_FIXTURES.inbox)
    expect(names[0]).toContain(t('quickadd.launcher_recent'))
    expect(names.filter((name) => name.includes(CJK_CHOICE_FIXTURES.inbox)).length).toBe(1)
  })

  it('says what to do when the library is empty', () => {
    library([])
    openLauncher()
    expect(rows().length).toBe(0)
    expect(dialog().textContent).toContain(t('quickadd.launcher_empty_library'))
  })

  it('reports no match rather than an empty library when a filter finds nothing', () => {
    library([DAILY])
    openLauncher()
    type(CJK_CHOICE_FIXTURES.noMatch)
    expect(rows().length).toBe(0)
    expect(dialog().textContent).toContain(t('quickadd.launcher_no_match'))
    expect(dialog().textContent).not.toContain(t('quickadd.launcher_empty_library'))
  })
})

describe('running a choice from the launcher', () => {
  it('picks the day first when the reader holds Shift', async () => {
    runs.day = '2024-03-04'
    library([DAILY])
    openLauncher()
    press('Enter', { shiftKey: true })
    await settle()
    expect(runs.calls.length).toBe(1)
    expect(runs.calls[0].id).toBe('qa-daily')
    expect(runs.calls[0].day?.getTime()).toBe(Date.parse('2024-03-04'))
  })

  it('runs nothing when the day question is dismissed', async () => {
    runs.day = null
    library([DAILY])
    openLauncher()
    clickRow(0, { shift: true })
    await settle()
    expect(runs.calls).toEqual([])
  })

  it('runs on a click as well as on Enter, and closes either way', async () => {
    library([DAILY, INBOX])
    openLauncher()
    clickRow(1)
    await settle()
    expect(runs.calls).toEqual([{ id: 'qa-inbox', sourceNoteId: 'n-open', day: null }])
    expect(closed).toBe(1)
  })

  it('takes the note the reader is in as the run’s source, and nothing when there is none', async () => {
    useUi.setState({ activeNoteId: null })
    library([INBOX])
    openLauncher()
    press('Enter')
    await settle()
    expect(runs.calls).toEqual([{ id: 'qa-inbox', sourceNoteId: undefined, day: null }])
  })
})

describe('the filter reaching into groups', () => {
  it('lists a nested choice and says where it lives', async () => {
    const group = newGroupChoice('g-work', 'Work', 0)
    const child = { ...newCaptureChoice('c-meeting', 'Meeting note', 0), parentId: 'g-work' }
    library([group, child])
    openLauncher()
    type('meeting')
    const found = rows().map((row) => row.textContent ?? '')
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Meeting note')
    expect(found[0], 'the reader needs to see which group holds it').toContain('Work')
    await settle()
    clickRow(0)
    await settle()
    expect(runs.calls.map((call) => call.id)).toEqual(['c-meeting'])
  })

  it('opens a nested group where it actually lives', async () => {
    const outer = newGroupChoice('g-outer', 'Outer', 0)
    const inner = { ...newGroupChoice('g-inner', 'Inner', 0), parentId: 'g-outer' }
    const deep = { ...newCaptureChoice('c-deep', 'Deep note', 0), parentId: 'g-inner' }
    library([outer, inner, deep])
    openLauncher()
    type('inner')
    expect(rows()).toHaveLength(1)
    clickRow(0)
    await settle()
    expect(rows().map((row) => row.textContent ?? '')).toEqual(expect.arrayContaining([expect.stringContaining('Deep note')]))
    expect(rows().some((row) => (row.textContent ?? '').includes('Outer'))).toBe(false)
  })

  it('lists a match once when both it and its group answer the same words', () => {
    const group = newGroupChoice('g-work', 'Work', 0)
    const child = { ...newCaptureChoice('c-work', 'Work log', 0), parentId: 'g-work' }
    library([group, child])
    openLauncher()
    type('work')
    const keys = rows().map((row) => row.textContent ?? '')
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('stays at the level on screen when the account says so', () => {
    const group = newGroupChoice('g-work', 'Work', 0)
    const child = { ...newCaptureChoice('c-meeting', 'Meeting note', 0), parentId: 'g-work' }
    library([group, child])
    useQuickAdd.setState((state) => ({ settings: { ...state.settings, searchNestedChoices: false } }))
    openLauncher()
    type('meeting')
    expect(rows()).toHaveLength(0)
    expect(dialog().textContent).toContain(t('quickadd.launcher_no_match'))
  })
})
