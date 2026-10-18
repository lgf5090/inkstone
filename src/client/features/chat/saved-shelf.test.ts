// @vitest-environment jsdom
/**
 * The kept answers have to be reachable from the chat sidebar, not only writable from a bubble.
 *
 * The shelf is the read half of a keep: `MessageParts` already offers the press, the worker already lists
 * what was kept (`src/worker/assistant/store.ts`'s `listSavedMessages`, pinned by
 * `tests/assistant-saved-message.test.ts`), and until the reader can walk to the list from a control they
 * can see, a keep is a write into nowhere. So every case here starts at a press of a real control in the
 * strip the starred/archived shortlists already live in, and follows what the panel answers with.
 *
 * The list call itself is spied on rather than stubbed at the module, so the rows are the shape
 * `api.assistant.savedMessages` answers with and the cursor the shelf sends back is the one the previous
 * page handed out.
 *
 * jsdom lays nothing out, so each claim is about structure, role and accessible name.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { SavedMessage } from '@shared/assistant'
import { ApiError, api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { CHAT_TAXONOMY_PANEL_ID, ConversationTabStrip, ConversationTaxonomyPanel } from './ChatTaxonomy'
import { useAssistant } from './assistant-store'
import { useSavedShelf } from './saved-shelf'

const original = useAssistant.getState()
const originalShelf = useSavedShelf.getState()

function kept(id: string, over: Partial<SavedMessage> = {}): SavedMessage {
  return {
    id,
    conversationId: 'c1',
    conversationTitle: 'Reading list',
    role: 'assistant',
    excerpt: 'Three ways to skim a book',
    savedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

let root: Root
let container: HTMLDivElement

/** What `api.assistant.savedMessages` answers with, spelled once so the deferred page below is the real shape. */
type SavedPage = { items: SavedMessage[], nextCursor: string | null }
let list: MockInstance<(params?: { cursor?: string, limit?: number }, signal?: AbortSignal) => Promise<SavedPage>>

async function render(element: ReactElement) {
  await act(async () => { root.render(element) })
}

/** The strip and the panel it drives, mounted the way `ChatView` mounts them. */
async function openShelf(): Promise<void> {
  await render(createElement('div', null,
    createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
  const entry = tabs().find((node) => node.title === t('assistant.chat.tab.saved'))
  expect(entry, 'the kept answers have no tab in the sidebar’s strip').toBeTruthy()
  await act(async () => { entry!.click() })
}

const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const panel = () => container.querySelector<HTMLElement>(`#${CHAT_TAXONOMY_PANEL_ID}`)
const alert = () => document.body.querySelector('[role="alert"]')
const rowButtons = () => [...panel()?.querySelectorAll<HTMLButtonElement>('ul[aria-label] > li > button') ?? []]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  list = vi.spyOn(api.assistant, 'savedMessages').mockResolvedValue({ items: [kept('m1')], nextCursor: null })
  useAssistant.setState({
    ...original,
    listTab: 'folders',
    folderFilter: 'all',
    projectFilter: 'all',
    tagFilter: null,
    flagged: { starred: [], pinned: [], archived: [] },
    loadFlagged: vi.fn().mockResolvedValue(undefined),
    openConversation: vi.fn().mockResolvedValue(undefined),
  })
  useSavedShelf.setState(originalShelf, true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  useAssistant.setState(original, true)
  useSavedShelf.setState(originalShelf, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the shelf of kept answers', () => {
  it('is offered as a tab beside the shortlists it belongs with', async () => {
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    const entry = tabs().find((node) => node.title === t('assistant.chat.tab.saved'))
    expect(entry, 'the kept answers have no tab in the sidebar’s strip').toBeTruthy()
    await act(async () => { entry!.click() })
    expect(panel()?.getAttribute('aria-labelledby')).toBe('chat-taxonomy-tab-saved')
  })

  it('reads its rows from the saved-answers list, once the tab is pressed', async () => {
    await openShelf()
    expect(list, 'the shelf drew without asking the route that holds the keeps').toHaveBeenCalled()
    expect(panel()?.textContent).toContain('Three ways to skim a book')
    expect(panel()?.textContent).toContain('Reading list')
  })

  it('waits visibly rather than showing an empty shelf while the page is in flight', async () => {
    let release: (page: SavedPage) => void = () => {}
    list.mockReturnValue(new Promise<SavedPage>((resolve) => { release = resolve }))
    await openShelf()
    const waiting = panel()?.querySelector('[role="status"]')
    expect(waiting, 'a shelf still reading says nothing about it').toBeTruthy()
    expect(waiting?.getAttribute('aria-label')).toBe(t('common.loading'))
    expect(rowButtons()).toHaveLength(0)
    await act(async () => { release({ items: [kept('m1')], nextCursor: null }) })
    expect(rowButtons()).toHaveLength(1)
  })

  it('presses back into the thread the answer belongs to, at the kept turn', async () => {
    list.mockResolvedValue({ items: [kept('m9', { conversationId: 'c9' })], nextCursor: null })
    await openShelf()
    const row = rowButtons()[0]
    expect(row, 'the kept answer drew no row').toBeTruthy()
    await act(async () => { row.click() })
    expect(useAssistant.getState().openConversation).toHaveBeenCalledWith('c9', { focusMessageId: 'm9' })
  })

  it('names the thread it points back to, not only the answer', async () => {
    list.mockResolvedValue({ items: [kept('m1', { conversationTitle: 'Winter notes' })], nextCursor: null })
    await openShelf()
    const row = rowButtons()[0]
    const name = (row?.textContent ?? '').trim()
    expect(name).toContain('Winter notes')
    expect(name).toContain('Three ways to skim a book')
    // An untitled thread still names itself, rather than pointing the reader at a blank.
    list.mockResolvedValue({ items: [kept('m2', { conversationTitle: '' })], nextCursor: null })
    await act(async () => { void useSavedShelf.getState().load() })
    expect(rowButtons()[0]?.textContent).toContain(t('assistant.chat.untitled'))
  })

  it('says how a keep gets onto the shelf when there is nothing on it', async () => {
    list.mockResolvedValue({ items: [], nextCursor: null })
    await openShelf()
    const text = panel()?.textContent ?? ''
    expect(text).toContain(t('assistant.chat.saved_empty'))
    // Not a bare "nothing here": the sentence has to carry the press that fills the list.
    expect(text).toContain(t('assistant.chat.keep'))
    expect(rowButtons()).toHaveLength(0)
    expect(alert()).toBeNull()
  })

  it('prints the route’s own reason and retries the read', async () => {
    const reason = 'Too many kept answers to read at once.'
    list.mockRejectedValue(new ApiError(500, 'internal', 'Request failed', undefined, reason))
    await openShelf()
    expect(alert(), 'a refused shelf rendered as an empty one').toBeTruthy()
    const text = alert()?.textContent ?? ''
    expect(text).toContain(t('assistant.chat.saved_failed'))
    // The half the reader cannot guess: what the route said about the request it refused.
    expect(text).toContain(reason)
    expect(panel()?.textContent).not.toContain(t('assistant.chat.saved_empty'))

    list.mockResolvedValue({ items: [kept('m1')], nextCursor: null })
    const retry = [...(alert()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((node) => node.textContent?.trim() === t('common.retry'))
    expect(retry, 'the failure offers no way to ask again').toBeTruthy()
    await act(async () => { retry!.click() })
    expect(list).toHaveBeenCalledTimes(2)
    expect(rowButtons()).toHaveLength(1)
  })

  it('keeps reading from the cursor the last page handed back', async () => {
    list.mockResolvedValue({ items: [kept('m1')], nextCursor: 'CURSOR_1' })
    await openShelf()
    const more = [...panel()?.querySelectorAll<HTMLButtonElement>('button') ?? []]
      .find((node) => node.textContent?.includes(t('assistant.chat.saved_more')))
    expect(more, 'a page that says there is more offers no press for it').toBeTruthy()
    list.mockResolvedValue({ items: [kept('m2', { excerpt: 'Why index cards work' })], nextCursor: null })
    await act(async () => { more!.click() })
    expect(list).toHaveBeenLastCalledWith({ cursor: 'CURSOR_1' })
    expect(rowButtons()).toHaveLength(2)
    expect(panel()?.textContent).toContain('Why index cards work')
    // The last page ended, so the press goes away rather than promising another one.
    expect([...panel()?.querySelectorAll<HTMLButtonElement>('button') ?? []]
      .find((node) => node.textContent?.includes(t('assistant.chat.saved_more')))).toBeUndefined()
  })
})
