// @vitest-environment jsdom
/**
 * The note-writing routine, reachable from the screen that lists schedules.
 *
 * The server side of this feature (`tests/assistant-automation-note-write.test.ts`) already proves that a
 * `note_write` schedule is refused unless it names exactly one target, and that a run reports the page it
 * filed. None of that is worth anything while the schedule editor has no way to say which page it means —
 * a column the API writes and no screen can read is the defect this file exists to catch.
 *
 * So every case here is the seam: the kind is selectable, one of the two pickers appears under it, the id
 * the reader picked is the id that leaves the browser, the *other* id never does, and the words that say
 * why a control is dead are in the document rather than in a hover hint. A run's receipt is held to the
 * same contract the memory row already keeps — the page named, or its absence named, never a bare "failed".
 *
 * jsdom lays nothing out: every claim is about structure, role and accessible name.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type Automation, type AutomationRun } from '@shared/assistant'
import type { ScheduleSpec } from '@shared/assistant-schedule'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { AutomationsView } from './AutomationsView'
import { useAssistant } from './assistant-store'

const LIVE_PAGE_ID = '01hzzzzzzzzzzzzzzzzzzzzz31'
const TRASHED_PAGE_ID = '01hzzzzzzzzzzzzzzzzzzzzz32'
const DAILY_FOLDER_ID = 'f1'

const mocks = vi.hoisted(() => ({
  createAutomation: vi.fn(async (_body: Record<string, unknown>) => ({ automation: {} })),
  /** What the notebook's own search answers with, behind `api.search`. */
  pages: { current: [] as { id: string, title: string }[] },
  folders: { current: [] as { id: string, name: string, parentId: string | null }[] },
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: async (query: string) => ({
      results: mocks.pages.current
        .filter((row) => !query || row.title.toLowerCase().includes(query.toLowerCase()))
        .map((row) => ({ note: row })),
    }),
    folders: { list: async () => ({ folders: mocks.folders.current }) },
    notes: {},
    assistant: {
      automations: async () => ({ automations: [], runs: [], timezone: 'UTC' }),
      createAutomation: mocks.createAutomation,
      updateAutomation: vi.fn(async () => ({ automation: {} })),
      deleteAutomation: vi.fn(async () => ({ deleted: true })),
    },
  },
}))

const DAILY = { id: DAILY_FOLDER_ID, name: 'Daily', parentId: null }
const LIVE_PAGE = { id: LIVE_PAGE_ID, title: 'Quarterly plan', deletedAt: null }
const TRASHED_PAGE = { id: TRASHED_PAGE_ID, title: 'Old draft', deletedAt: 1_000 }

function schedule(): ScheduleSpec {
  return { type: 'daily', time: '07:00' }
}

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Morning log',
    kind: 'note_write',
    message: 'Write the log for yesterday.',
    schedule: schedule(),
    enabled: true,
    status: 'scheduled',
    nextRun: Date.now() + 3_600_000,
    lastRun: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
    targetFolderId: null,
    targetNoteId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    automationName: 'Morning log',
    startedAt: Date.now(),
    finishedAt: Date.now() + 1_000,
    status: 'success',
    result: null,
    error: null,
    noteId: null,
    ...over,
  }
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byText = (text: string) => buttons().find((node) => node.textContent?.trim() === text)
const byName = (name: string) => buttons().find((node) => (node.getAttribute('aria-label') ?? '') === name)
const radios = () => [...document.body.querySelectorAll<HTMLElement>('[role="radio"]')]
const text = () => document.body.textContent ?? ''

/** The name a control answers to, whether it is written on it or pointed at a heading beside it. */
function accessibleName(node: Element | null | undefined): string {
  const label = node?.getAttribute('aria-label') ?? ''
  if (label) return label
  return (node?.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim()
}

/**
 * The folder picker by its own label, not "the first `<select>`".
 *
 * The dialog holds a second select — the repeat rule — and a test that grabbed either one would pass while
 * the target block drew nothing at all.
 */
const folderSelect = () => [...document.body.querySelectorAll<HTMLSelectElement>('select')]
  .find((node) => accessibleName(node) === t('assistant.automations.target_folder')) ?? null

async function click(node: Element | undefined | null, where: string): Promise<void> {
  expect(node, `${where} is not rendered`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Type into a box the way a keyboard does, so React's own value tracking sees the change. */
async function type(node: Element | null | undefined, value: string): Promise<void> {
  expect(node, 'the box is not rendered').toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, value)
    node!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Choose an option the way a pointer does: a change event off the `<select>`, not a written value. */
async function chooseOption(select: HTMLSelectElement | null, value: string): Promise<void> {
  expect(select, 'the picker is not rendered').toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** The words a control's `aria-describedby` actually speaks. */
function describedBy(node: Element | null | undefined): string {
  return (node?.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim()
}

/** The list, at rest: no dialog open. */
async function mount(over: Partial<ReturnType<typeof useAssistant.getState>> = {}): Promise<void> {
  useAssistant.setState({
    ...assistantOriginal,
    automations: [],
    runs: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: 'UTC' },
    loadAutomations: vi.fn(async () => undefined),
    ...over,
  })
  await act(async () => { root.render(createElement(AutomationsView)) })
  await act(async () => { await Promise.resolve() })
}

/** The list, then its new-schedule dialog. */
async function openForm(over: Partial<ReturnType<typeof useAssistant.getState>> = {}): Promise<void> {
  await mount(over)
  await click(byText(t('assistant.automations.new')), 'the new-schedule button')
}

/** Pick the writing kind and give it the prompt the server requires of it. */
async function chooseWritingKind(): Promise<void> {
  await click(byText(t('assistant.automations.kind.note_write')), 'the write-a-note kind')
  await type(document.body.querySelector<HTMLInputElement>('input[maxlength="4000"]'), 'Summarise yesterday.')
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  mocks.createAutomation.mockClear()
  mocks.pages.current = [{ id: LIVE_PAGE_ID, title: 'Quarterly plan' }]
  mocks.folders.current = [DAILY]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useNotes.setState({ ...notesOriginal, hydrated: true, notes: { [LIVE_PAGE_ID]: LIVE_PAGE as never } })
  useUi.setState({ ...uiOriginal, toast: vi.fn(() => 'toast-id') })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('the writing kind in the schedule editor', () => {
  it('offers the kind, and asks which of the two targets it means', async () => {
    await openForm()
    expect(byText(t('assistant.automations.kind.note_write')), 'the writing kind is not selectable').toBeTruthy()
    await chooseWritingKind()
    const group = document.body.querySelector<HTMLElement>('[role="radiogroup"]')
    expect(group, 'the target choice is not a named radio group').toBeTruthy()
    expect(accessibleName(group)).toBe(t('assistant.automations.target'))
    expect(group!.getAttribute('aria-required')).toBe('true')
    expect(radios().map((node) => node.textContent?.trim())).toEqual([
      t('assistant.automations.target_folder'),
      t('assistant.automations.target_note'),
    ])
    // Mutually exclusive, and drawn that way: exactly one radio answers as checked.
    expect(radios().filter((node) => node.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(folderSelect(), 'the folder branch draws no picker').toBeTruthy()
  })

  it('sends the folder it was shown, and never a page id with it', async () => {
    await openForm()
    await chooseWritingKind()
    await chooseOption(folderSelect(), DAILY.id)
    await click(byText(t('assistant.automations.create')), 'the create button')
    expect(mocks.createAutomation, 'the create never reached the api').toHaveBeenCalledTimes(1)
    const sent = mocks.createAutomation.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ kind: 'note_write', folderId: DAILY.id })
    expect('noteId' in sent, 'a folder schedule also sent a page id').toBe(false)
  })

  it('sends the page picked from the notebook’s own search, and never a folder id with it', async () => {
    await openForm()
    await chooseWritingKind()
    await click(radios()[1], 'the page radio')
    expect(folderSelect(), 'the folder picker is still drawn under the page choice').toBeNull()
    await click(byText(t('assistant.automations.target_page_pick')), 'the pick-a-page button')
    const combobox = document.body.querySelector<HTMLElement>('[role="combobox"]')
    expect(combobox, 'the button opens no note search').toBeTruthy()
    await type(combobox, 'Quarterly')
    await click(buttons().find((node) => node.getAttribute('role') === 'option'), 'the searched-for page')
    expect(text()).toContain('Quarterly plan')
    await click(byText(t('assistant.automations.create')), 'the create button')
    const sent = mocks.createAutomation.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ kind: 'note_write', noteId: LIVE_PAGE_ID })
    expect('folderId' in sent, 'a page schedule also sent a folder id').toBe(false)
  })

  it('takes the folder off when the reader switches to a page, and the other way round', async () => {
    await openForm()
    await chooseWritingKind()
    await chooseOption(folderSelect(), DAILY.id)
    await click(radios()[1], 'the page radio')
    await click(radios()[0], 'the folder radio again')
    // An id that is not on screen any more is a target the reader did not choose in front of them.
    expect(folderSelect()?.value, 'the folder left behind came back').toBe('')
    await click(byText(t('assistant.automations.create')), 'the create button')
    expect(mocks.createAutomation, 'an empty target was sent anyway').not.toHaveBeenCalled()
  })

  it('says in words why a schedule with no target cannot be saved', async () => {
    await openForm()
    await chooseWritingKind()
    const create = byText(t('assistant.automations.create'))
    expect(create?.hasAttribute('disabled'), 'a targetless schedule is saveable').toBe(true)
    expect(text()).toContain(t('assistant.automations.target_folder_required'))
    expect(describedBy(create)).toContain(t('assistant.automations.target_folder_required'))
  })

  it('says when there is no folder to file into, instead of drawing an empty picker', async () => {
    mocks.folders.current = []
    await openForm()
    await chooseWritingKind()
    expect(text()).toContain(t('assistant.automations.target_folder_none'))
    expect(folderSelect(), 'an empty folder picker was drawn as if it worked').toBeNull()
    expect(byText(t('assistant.automations.create'))?.hasAttribute('disabled')).toBe(true)
  })

  it('says which page a standing schedule refills', async () => {
    await mount({ automations: [automation({ targetNoteId: LIVE_PAGE_ID })] })
    expect(text()).toContain(t('assistant.automations.onto', { name: 'Quarterly plan' }))
  })

  it('names the folder a standing schedule files into', async () => {
    await mount({ automations: [automation({ targetFolderId: DAILY.id })] })
    expect(text()).toContain(t('assistant.automations.into', { name: 'Daily' }))
  })

  it('names the page a schedule rewrites once that page has left the notebook', async () => {
    useNotes.setState({ ...notesOriginal, hydrated: true, notes: { [TRASHED_PAGE_ID]: TRASHED_PAGE as never } })
    await mount({ automations: [automation({ targetNoteId: TRASHED_PAGE_ID })] })
    expect(text()).toContain(t('assistant.automations.target_page_gone', { name: 'Old draft' }))
  })
})

describe('the receipt a writing run leaves', () => {
  it('names the page it wrote and opens it', async () => {
    const openNote = vi.fn(async () => undefined)
    useNotes.setState({ ...notesOriginal, hydrated: true, notes: { [LIVE_PAGE_ID]: LIVE_PAGE as never }, openNote })
    await mount({ runs: [run({ noteId: LIVE_PAGE_ID, result: 'Wrote “Quarterly plan”' })] })
    const entry = byName(`${t('assistant.automations.run_open_note')}: Quarterly plan`)
    expect(entry, 'the run offers no way to the page it wrote').toBeTruthy()
    await click(entry, 'the run’s page entry')
    expect(openNote).toHaveBeenCalledWith(LIVE_PAGE_ID)
    expect(window.location.pathname).toBe('/notes')
  })

  it('does not call a page gone before the note list has been read', async () => {
    // An unread list proves nothing about whether the page exists; the entry is still the one to press.
    useNotes.setState({ ...notesOriginal, hydrated: false, notes: {} })
    await mount({ runs: [run({ noteId: LIVE_PAGE_ID })] })
    expect(byName(t('assistant.automations.run_open_note')), 'an unread list was read as a deleted page').toBeTruthy()
    expect(text()).not.toContain(t('assistant.automations.run_note_gone'))
  })

  it('says the page it wrote is gone rather than offering a dead entry', async () => {
    useNotes.setState({ ...notesOriginal, hydrated: true, notes: { [TRASHED_PAGE_ID]: TRASHED_PAGE as never } })
    await mount({ runs: [run({ noteId: LIVE_PAGE_ID })] })
    expect(byName(t('assistant.automations.run_open_note')), 'a dead pointer is still offered as a link').toBeUndefined()
    expect(text()).toContain(t('assistant.automations.run_note_gone'))
  })

  it('keeps the sentence that names a missing target where failures are read', async () => {
    const reason = 'The page “Quarterly plan” this routine rewrites is in the trash, so nothing was written.'
    await mount({ automations: [automation({ status: 'failed', lastError: reason })], runs: [run({ status: 'error', error: reason })] })
    expect(text()).toContain(reason)
    expect(text()).toContain(t('assistant.automations.failed'))
  })
})
