import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation } from '@shared/assistant'
import type { NoteSummary } from '@shared/types'
import { api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { OmnisearchPrompt } from './OmnisearchPrompt'
import { omnisearchIndexer, type IndexerStatus } from './indexer'
import { loadHistory } from './history'
import { closeOmnisearch, useOmnisearch } from './store'
import { CONVERSATION_RESULT_LIMIT } from './conversation-results'
import { openConversationInChat } from '../chat/start-chat'

// The chat app owns these rows, and the prompt only hands the thread over to it.
vi.mock('../chat/start-chat', () => ({
  openConversationInChat: vi.fn(),
}))

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

const note: NoteSummary = {
  id: 'note-1', title: 'Latte art', excerpt: 'milk and foam', folderId: null, tags: [],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 4, charCount: 14,
  rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}

function noteRow(title = 'Latte art', id = 'n:note-1') {
  return {
    id,
    doc: {
      kind: 'note' as const, title, displayTitle: '', path: `${title}.md`, folder: 'Drinks',
      ext: 'md', updatedAt: 1, archived: false, starred: false, noteId: 'note-1', tags: [],
      customValues: [], excerpt: 'milk and foam', truncated: false, size: 14,
    },
    score: 10,
    terms: ['lat'],
    matches: [{ term: 'lat', offset: 0 }],
    isEmbed: false,
    excerpt: { lines: [{ text: 'latte foam art', hits: [] }], leading: false, trailing: false },
    matchCount: 1,
  }
}

function answer(results: unknown[]): void {
  vi.spyOn(omnisearchIndexer, 'query').mockResolvedValue({
    query: { terms: ['lat'], exact: [], boostedTags: [], text: 'lat' } as never,
    results: results as never,
  })
}

function conversation(over: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    id: 'c-1',
    title: 'Ratio talk',
    pinned: false,
    starred: false,
    archived: false,
    ephemeral: false,
    folderId: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 4,
    match: { messageId: 'm-9', snippet: 'the latte ratio is one to two' },
    ...over,
  }
}

/** The server's own answer shape, so a case can hand back a page without naming the cursor. */
function page(conversations: AssistantConversation[]): { conversations: AssistantConversation[], nextCursor: string | null } {
  return { conversations, nextCursor: null }
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

let root: Root
let container: HTMLDivElement
let conversations: ReturnType<typeof vi.spyOn>
const originalNotes = useNotes.getState()
const originalUi = useUi.getState()
const originalSession = useSession.getState()

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!
}

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

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
}

function optionTexts(): string[] {
  return options().map((option) => option.textContent ?? '')
}

function listbox(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="listbox"]')!
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

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, media: '', onchange: null, dispatchEvent: () => false }))
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  vi.clearAllMocks()
  vi.mocked(loadHistory).mockResolvedValue([])
  vi.spyOn(omnisearchIndexer, 'getStatus').mockReturnValue(readyStatus)
  vi.spyOn(omnisearchIndexer, 'resolveBody').mockResolvedValue(null)
  conversations = vi.spyOn(api.assistant, 'conversations').mockResolvedValue(page([]))
  useNotes.setState({
    ...originalNotes,
    notes: { [note.id]: note },
    contents: { [note.id]: 'latte foam art' },
    hydrated: true,
    loading: false,
  })
  useUi.setState({ ...originalUi, activeNoteId: note.id })
  useSession.setState({ ...originalSession, status: 'authed' })
  useOmnisearch.setState({ open: true, mode: 'vault', seed: '', noteId: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  useSession.setState(originalSession, true)
  closeOmnisearch()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('conversations as a global-search category', () => {
  it('asks the conversation endpoint the reader is already looking at, with the settled text', async () => {
    answer([noteRow()])
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(conversations).toHaveBeenCalledWith({ q: 'lat', limit: String(CONVERSATION_RESULT_LIMIT) })
  })

  it('draws the match in its own category, and says which one it belongs to', async () => {
    answer([noteRow()])
    conversations.mockResolvedValue(page([conversation()]))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(listbox().textContent).toContain(t('omnisearch.category_notes'))
    expect(listbox().textContent).toContain(t('omnisearch.category_conversations'))
    // The note row keeps its own place; the conversation arrives after it, and names the app it lands in.
    expect(optionTexts()[0]).toContain('Latte art')
    expect(optionTexts().at(-1)).toContain('Ratio talk')
    expect(optionTexts().at(-1)).toContain(t('assistant.view.chat'))
    expect(optionTexts().at(-1)).toContain('the latte ratio is one to two')
  })

  it('walks into the conversation rows with the arrows and opens that thread on Enter', async () => {
    answer([noteRow()])
    conversations.mockResolvedValue(page([conversation()]))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    press(input(), { key: 'ArrowDown' })
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
    press(input(), { key: 'Enter' })
    await settle()
    // A search hit names the turn its words were found in, so the thread opens around it.
    expect(openConversationInChat).toHaveBeenCalledWith('c-1', 'm-9')
    expect(useOmnisearch.getState().open).toBe(false)
  })

  it('clicking a conversation row opens it too, and keeps the note rows out of the way', async () => {
    answer([noteRow()])
    conversations.mockResolvedValue(page([conversation({ match: null })]))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    act(() => {
      options()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
    expect(openConversationInChat).toHaveBeenCalledWith('c-1', undefined)
  })

  it('shows the refusal, and asks again on retry, instead of an empty list', async () => {
    answer([noteRow()])
    conversations.mockRejectedValue(new Error('HTTP 401'))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    const alert = document.querySelector('[role="alert"]')
    expect(alert, 'a refused conversation search must say so').not.toBeNull()
    expect(alert!.textContent).toContain(t('omnisearch.conversations_failed'))
    expect(listbox().textContent).not.toContain(t('omnisearch.no_results'))
    expect(conversations).toHaveBeenCalledTimes(1)
    conversations.mockResolvedValue(page([conversation()]))
    act(() => {
      const button = Array.from(alert!.querySelectorAll('button')).find((node) => node.textContent?.includes(t('common.retry')))
      expect(button, 'the refusal offers the way back').toBeTruthy()
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
    expect(conversations).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('says nothing found in the conversations without claiming the whole search came back empty', async () => {
    answer([noteRow()])
    conversations.mockResolvedValue(page([]))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(listbox().textContent).toContain(t('omnisearch.conversations_none'))
    expect(optionTexts()).toHaveLength(1)
  })

  it('keeps a fast conversation answer when the note index answers late', async () => {
    const late = deferred<unknown>()
    vi.spyOn(omnisearchIndexer, 'query').mockReturnValue(late.promise as never)
    conversations.mockResolvedValue(page([conversation()]))
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(optionTexts().some((text) => text.includes('Ratio talk'))).toBe(true)
    await act(async () => {
      late.resolve({ query: { terms: ['lat'], exact: [], boostedTags: [] }, results: [noteRow()] })
    })
    await settle()
    expect(optionTexts().some((text) => text.includes('Ratio talk'))).toBe(true)
    expect(optionTexts().some((text) => text.includes('Latte art'))).toBe(true)
  })

  it('keeps a fast note answer when the conversation search answers late', async () => {
    const late = deferred<ReturnType<typeof page>>()
    answer([noteRow()])
    conversations.mockReturnValue(late.promise)
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(optionTexts().some((text) => text.includes('Latte art'))).toBe(true)
    await act(async () => {
      late.resolve(page([conversation()]))
    })
    await settle()
    expect(optionTexts().some((text) => text.includes('Latte art'))).toBe(true)
    expect(optionTexts().some((text) => text.includes('Ratio talk'))).toBe(true)
  })

  it('drops the answer of a query the reader already replaced', async () => {
    const stale = deferred<ReturnType<typeof page>>()
    const fresh = deferred<ReturnType<typeof page>>()
    answer([])
    conversations.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    type('lattes')
    await settle()
    await act(async () => {
      fresh.resolve(page([conversation({ title: 'Fresh thread' })]))
    })
    await settle()
    await act(async () => {
      stale.resolve(page([conversation({ title: 'Stale thread' })]))
    })
    await settle()
    expect(optionTexts().some((text) => text.includes('Fresh thread'))).toBe(true)
    expect(listbox().textContent).not.toContain('Stale thread')
  })

  it('leaves the conversations out of an in-file search, which is about one note', async () => {
    answer([noteRow()])
    render(createElement(OmnisearchPrompt, { mode: 'file', seed: 'lat', noteId: 'note-1' }))
    await settle()
    expect(conversations).not.toHaveBeenCalled()
    expect(listbox().textContent).not.toContain(t('omnisearch.category_conversations'))
  })

  it('says the conversation search is running while it is owed an answer', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    answer([noteRow()])
    conversations.mockReturnValue(pending.promise)
    render(createElement(OmnisearchPrompt, { mode: 'vault', seed: '', noteId: null }))
    type('lat')
    await settle()
    expect(listbox().textContent).toContain(t('omnisearch.conversations_searching'))
    await act(async () => {
      pending.resolve(page([]))
    })
    await settle()
    expect(listbox().textContent).not.toContain(t('omnisearch.conversations_searching'))
  })
})
