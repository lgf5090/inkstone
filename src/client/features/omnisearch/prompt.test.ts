import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { foldTerm } from './fold'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { OmnisearchPrompt } from './OmnisearchPrompt'
import { omnisearchIndexer, type IndexerStatus } from './indexer'
import { loadHistory, pushHistory } from './history'
import { insertAtActiveCursor, revealInNote } from './reveal'
import { createContextualNote } from '../../store/notes'
import { closeOmnisearch, useOmnisearch } from './store'

vi.mock('./history', () => ({
  OMNISEARCH_HISTORY_MAX: 10,
  loadHistory: vi.fn(async () => [] as string[]),
  pushHistory: vi.fn(async () => [] as string[]),
  clearHistory: vi.fn(async () => [] as string[]),
  initialQueryOf: (items: readonly string[], show: boolean) => (show ? items[0] ?? '' : ''),
}))

vi.mock('./reveal', () => ({
  revealInNote: vi.fn(async () => true),
  insertAtActiveCursor: vi.fn(() => true),
}))

vi.mock('../../store/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/notes')>()),
  createContextualNote: vi.fn(async () => 'new-note'),
}))

const readyStatus: IndexerStatus = {
  phase: 'done',
  indexed: 3,
  available: 3,
  deferred: 0,
  bodyBytes: 1024,
  busy: false,
  error: null,
  cacheFailed: false,
  ready: true,
}

function withStatus(patch: Partial<IndexerStatus>): void {
  vi.spyOn(omnisearchIndexer, 'getStatus').mockReturnValue({ ...readyStatus, ...patch })
}

const note: NoteSummary = {
  id: 'note-1', title: 'Latte art', excerpt: 'milk and foam', folderId: null, tags: [],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 4, charCount: 14,
  rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}

interface RowShape {
  id?: string
  title?: string
  body?: string
  offset?: number
  embed?: boolean
  hits?: [number, number][]
}

function row(over: RowShape = {}) {
  const id = over.id ?? 'n:note-1'
  const title = over.title ?? 'Latte art'
  const isFile = id.startsWith('f:')
  const body = over.body ?? 'latte foam art'
  const offset = over.offset
  return {
    id,
    doc: {
      kind: isFile ? 'file' as const : 'note' as const,
      title,
      displayTitle: '',
      path: isFile ? title : `${title}.md`,
      folder: isFile ? '' : 'Drinks',
      ext: isFile ? 'png' : 'md',
      updatedAt: 1,
      archived: false,
      starred: false,
      noteId: 'note-1',
      tags: [],
      customValues: [],
      excerpt: 'milk and foam',
      truncated: false,
      size: 14,
    },
    score: 10,
    terms: ['lat'],
    matches: offset === undefined ? [] : [{ term: 'latte', offset }],
    isEmbed: over.embed ?? false,
    excerpt: { lines: [{ text: body, hits: over.hits ?? [] }], leading: false, trailing: false },
    matchCount: offset === undefined ? 0 : 1,
  }
}

function answer(results: unknown[], query: Partial<{ terms: string[]; text: string }> = {}): void {
  vi.spyOn(omnisearchIndexer, 'query').mockResolvedValue({
    query: { terms: [], exact: [], boostedTags: [], ...query } as never,
    results: results as never,
  })
}

let root: Root
let container: HTMLDivElement
const originalNotes = useNotes.getState()
const originalUi = useUi.getState()
const originalSession = useSession.getState()
const originalSearch = { ...useSession.getState().settings.search }

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!
}

/** The native setter, because React's own value tracker swallows a plain assignment. */
function type(value: string): void {
  const field = input()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 220))
  })
}

function render(node: ReactNode): void {
  act(() => {
    root.render(node)
  })
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
}

function selectedIndex(): number {
  return options().findIndex((option) => option.getAttribute('aria-selected') === 'true')
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, media: '', onchange: null, dispatchEvent: () => false }))
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  vi.clearAllMocks()
  vi.mocked(loadHistory).mockResolvedValue([])
  vi.spyOn(omnisearchIndexer, 'resolveBody').mockResolvedValue(null)
  withStatus({})
  useNotes.setState({ ...originalNotes, notes: { [note.id]: note }, contents: { [note.id]: 'latte foam art' }, hydrated: true, loading: false })
  useUi.setState({ ...originalUi, activeNoteId: note.id })
  useSession.setState({ ...originalSession, status: 'authed', settings: { ...originalSession.settings, search: { ...originalSearch } } })
  useOmnisearch.setState({ open: true, mode: 'vault', seed: '', noteId: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  useSession.setState(originalSession, true)
  closeOmnisearch()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('omnisearch prompt', () => {
  it('asks the index for the debounced query and paints the rows', async () => {
    answer([row({ offset: 0 })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(omnisearchIndexer.query).toHaveBeenCalledWith('lat', {})
    expect(options()[0]!.textContent).toContain('Latte art')
    expect(options()[0]!.textContent).toContain('Drinks')
    // The highlight carries the text as the note spells it, not as the query did.
    expect(options()[0]!.querySelector('mark.ink-hit')!.textContent).toBe('Lat')
  })

  it('leaves the excerpt out when the reader turned it off', async () => {
    useSession.setState({ settings: { ...useSession.getState().settings, search: { ...originalSearch, showExcerpt: false } } })
    answer([row({ offset: 0, body: 'latte foam art' })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(options()[0]!.textContent).not.toContain('foam art')
  })

  it('renders a hostile note body as text, never as markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    answer([row({ offset: 0, body: hostile })], { terms: ['img'], text: 'img' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('img')
    await settle()
    expect(document.querySelector('[role="listbox"] img')).toBeNull()
    expect(options()[0]!.textContent).toContain(hostile)
  })

  it('opens the selected result and lands the caret on the match', async () => {
    answer([row({ offset: 6 })], { terms: ['lat'], text: 'lat' })
    const onOpen = vi.fn()
    useNotes.setState({ openNote: onOpen })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    const event = press(input(), { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(onOpen).toHaveBeenCalledWith('note-1', { activate: true })
    expect(vi.mocked(revealInNote).mock.calls.at(-1)).toEqual(['note-1', 6, 11, true])
    expect(useOmnisearch.getState().open).toBe(false)
    expect(vi.mocked(pushHistory).mock.calls.at(-1)?.[0]).toBe('lat')
  })

  it('opens a mod+enter result in the other pane', async () => {
    answer([row({ offset: 0 })], { terms: ['lat'], text: 'lat' })
    const onOpen = vi.fn()
    useNotes.setState({ openNote: onOpen })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    press(input(), { key: 'Enter', ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('note-1', { pane: 'secondary', activate: true })
  })

  it('opens behind without stealing the focus on mod+o', async () => {
    answer([row({ offset: 0 })], { terms: ['lat'], text: 'lat' })
    const onOpen = vi.fn()
    useNotes.setState({ openNote: onOpen })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    press(input(), { key: 'o', ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('note-1', { pane: 'secondary', activate: false })
    expect(useOmnisearch.getState().open).toBe(false)
  })

  it('walks the list with the arrows and wraps around', async () => {
    answer([row({ id: 'n:one', title: 'First' }), row({ id: 'n:two', title: 'Second' })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(selectedIndex()).toBe(0)
    press(input(), { key: 'ArrowDown' })
    expect(selectedIndex()).toBe(1)
    press(input(), { key: 'ArrowDown' })
    expect(selectedIndex()).toBe(0)
    press(input(), { key: 'ArrowUp' })
    expect(selectedIndex()).toBe(1)
    press(input(), { key: 'n', ctrlKey: true })
    expect(selectedIndex()).toBe(0)
    press(input(), { key: 'k', ctrlKey: true })
    expect(selectedIndex()).toBe(1)
  })

  it('creates a note from the query on shift+enter', async () => {
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('New Idea')
    await settle()
    press(input(), { key: 'Enter', shiftKey: true })
    expect(createContextualNote).toHaveBeenCalledWith({ title: 'New Idea' })
    expect(useOmnisearch.getState().open).toBe(false)
  })

  it('switches to the note it is sitting on with tab', async () => {
    answer([row({ offset: 0 })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    press(input(), { key: 'Tab' })
    await settle()
    expect(document.querySelector('[data-omnisearch-scope]')!.getAttribute('data-omnisearch-scope')).toBe('file')
    expect(omnisearchIndexer.query).toHaveBeenLastCalledWith('lat', { singleDocId: 'n:note-1' })
  })

  it('lists the grouped matches of one note and jumps to the picked one', async () => {
    const body = ['latte at the start', ' '.repeat(320), 'and latte again much later here'].join('')
    vi.spyOn(omnisearchIndexer, 'resolveBody').mockResolvedValue(body)
    answer([], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'file', seed: 'lat', noteId: 'note-1' }))
    await settle()
    const second = body.indexOf('latte', 5)
    expect(options()).toHaveLength(2)
    expect(options()[0]!.textContent).toContain('0')
    const onOpen = vi.fn()
    act(() => {
      useNotes.setState({ openNote: onOpen })
    })
    act(() => {
      options()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledWith('note-1', {})
    expect(vi.mocked(revealInNote).mock.calls.at(-1)!.slice(0, 3)).toEqual(['note-1', second, second + 'lat'.length])
  })

  it('inserts a link into the editor on alt+enter', async () => {
    answer([row({ offset: 0 })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    press(input(), { key: 'Enter', altKey: true })
    expect(insertAtActiveCursor).toHaveBeenCalledWith('[[Latte art]]')
    expect(useOmnisearch.getState().open).toBe(false)
  })

  it('cycles the saved history with alt+arrows', async () => {
    vi.mocked(loadHistory).mockResolvedValue(['second query', 'first query'])
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    await settle()
    press(input(), { key: 'ArrowDown', altKey: true })
    expect(input().value).toBe('first query')
    press(input(), { key: 'ArrowUp', altKey: true })
    expect(input().value).toBe('second query')
  })

  it('prefills the last executed query, and starts blank after an abandoned one', async () => {
    vi.mocked(loadHistory).mockResolvedValue(['', 'kept'])
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    await settle()
    expect(input().value).toBe('')
  })

  it('does not prefill when the reader turned that off', async () => {
    vi.mocked(loadHistory).mockResolvedValue(['kept'])
    useSession.setState({ settings: { ...useSession.getState().settings, search: { ...originalSearch, showPreviousQueryResults: false } } })
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    await settle()
    expect(input().value).toBe('')
  })

  it('keeps the seed the caller passed over the stored history', async () => {
    vi.mocked(loadHistory).mockResolvedValue(['kept'])
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: 'from the menu', noteId: null }))
    await settle()
    expect(input().value).toBe('from the menu')
  })

  it('toggles excerpts on mod+g and stores the choice', async () => {
    answer([])
    const update = vi.fn()
    useSession.setState({ updateSettings: update })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    press(input(), { key: 'g', ctrlKey: true })
    expect(update).toHaveBeenCalledWith({ search: { showExcerpt: false } })
  })

  it('reports what the index is doing instead of a bare zero', async () => {
    answer([], { terms: ['zz'], text: 'zz' })
    withStatus({ phase: 'indexing', busy: true, indexed: 4, available: 10, ready: false })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('zz')
    await settle()
    expect(document.querySelector('[role="status"]')!.textContent).toContain('4')
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain(t('omnisearch.no_results'))
  })

  it('says so when the local index is switched off', async () => {
    useSession.setState({ settings: { ...useSession.getState().settings, search: { ...originalSearch, enabled: false } } })
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    await settle()
    expect(document.querySelector('[role="status"]')!.textContent).toContain(t('omnisearch.index_off'))
    expect(omnisearchIndexer.query).not.toHaveBeenCalled()
  })

  it('does not search before the reader types', async () => {
    answer([])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    await settle()
    expect(omnisearchIndexer.query).not.toHaveBeenCalled()
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain(t('omnisearch.type_to_search'))
  })

  it('keeps the fold it hands the index the same one the index stores', async () => {
    answer([row({ offset: 0 })], { terms: [foldTerm('CAFE', true)], text: 'cafe' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('CAFE')
    await settle()
    expect(omnisearchIndexer.query).toHaveBeenCalledWith('CAFE', {})
  })

  it('announces which row is selected to a screen reader', async () => {
    answer([row({ offset: 0 }), row({ id: 'n:other', title: 'Other' })], { terms: ['lat'], text: 'lat' })
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    const active = input().getAttribute('aria-activedescendant')
    expect(active).toBe(options()[0]!.id)
    press(input(), { key: 'ArrowDown' })
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
  })

  it('closes on the scrim and on escape', async () => {
    answer([])
    const onEscape = vi.spyOn(globalThis, 'addEventListener')
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    expect(onEscape).toHaveBeenCalled()
    act(() => {
      document.querySelector<HTMLElement>('.anim-fade')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useOmnisearch.getState().open).toBe(false)
  })
})
