// @vitest-environment jsdom
/**
 * The conversation list's three filters outlive the page they were set on.
 *
 * `listTab`, `folderFilter` and `tagFilter` are this device's view of rows the server owns, so they are
 * kept the way `store/ui.ts` keeps `expandedFolders`: read once when the store is built, validated per
 * key, and written back by one debounced write. What is pinned here is the three parts of that contract
 * a reader can feel — the write happens once and after the debounce, a stored entry comes back on the
 * next build of the store, and an entry naming a folder or tag that no longer exists is taken back off
 * rather than left to answer "no conversations" forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBOUNCE } from '@shared/constants'
import type { ChatFolderNode, ConversationTag } from '@shared/assistant'
import { installTestGlobals } from '../../lib/test-render'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      conversations: vi.fn(async () => ({ conversations: [] })),
      conversationFolders: vi.fn(async () => ({ folders: [], unfiled: 0 })),
      conversationTags: vi.fn(async () => ({ tags: [] })),
    },
  },
}))

const FOLDER: ChatFolderNode = { id: 'live', name: 'Live', parentId: null, icon: null, color: null, count: 1 }

interface Generation {
  store: typeof import('./assistant-store').useAssistant
  key: string
  assistant: typeof import('../../lib/api').api.assistant
}

/**
 * The store built from scratch, with the same generation's API mock.
 *
 * The persisted entry is read while the module is being built, so a test that wants to know what a
 * reload does has to reload — and the mock the new store reached for is a new instance too.
 */
async function rebuild(): Promise<Generation> {
  vi.resetModules()
  const module = await import('./assistant-store')
  const api = await import('../../lib/api')
  await (await import('../../lib/i18n')).initI18n()
  return { store: module.useAssistant, key: module.ASSISTANT_UI_STORAGE_KEY, assistant: api.api.assistant }
}

beforeEach(() => {
  installTestGlobals()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('the conversation list filters', () => {
  it('are written once, after the persist debounce', async () => {
    const { store, key } = await rebuild()
    await store.getState().setTagFilter('t1')
    await store.getState().setFolderFilter('f1')
    expect(localStorage.getItem(key), 'a write per click is not what the debounce is for').toBeNull()
    await store.getState().setListTab('tags')
    vi.advanceTimersByTime(DEBOUNCE.persist)
    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toEqual({
      listTab: 'tags', folderFilter: 'f1', tagFilter: 't1',
    })
  })

  it('come back when the store is built again', async () => {
    const first = await rebuild()
    localStorage.setItem(first.key, JSON.stringify({ listTab: 'pinned', folderFilter: 'f7', tagFilter: null }))
    const { store } = await rebuild()
    expect(store.getState().listTab).toBe('pinned')
    expect(store.getState().folderFilter).toBe('f7')
    expect(store.getState().tagFilter).toBeNull()
  })

  it('fall back to the defaults when the stored entry is not one', async () => {
    const first = await rebuild()
    localStorage.setItem(first.key, '{"listTab":"settings","folderFilter":42}')
    const { store } = await rebuild()
    expect(store.getState().listTab).toBe('folders')
    expect(store.getState().folderFilter).toBe('all')
  })

  it('drop a filter the tree no longer offers', async () => {
    const first = await rebuild()
    localStorage.setItem(first.key, JSON.stringify({ listTab: 'folders', folderFilter: 'gone', tagFilter: 'also-gone' }))
    const { store, assistant } = await rebuild()
    vi.mocked(assistant.conversationFolders).mockResolvedValue({ folders: [FOLDER], unfiled: 0 })
    vi.mocked(assistant.conversationTags).mockResolvedValue({ tags: [] as (ConversationTag & { count: number })[] })
    expect(store.getState().folderFilter).toBe('gone')
    await store.getState().loadTaxonomy()
    expect(store.getState().folderFilter).toBe('all')
    expect(store.getState().tagFilter).toBeNull()
  })

  it('keep a filter the tree still offers', async () => {
    const first = await rebuild()
    localStorage.setItem(first.key, JSON.stringify({ listTab: 'folders', folderFilter: 'live', tagFilter: 'kept' }))
    const { store, assistant } = await rebuild()
    vi.mocked(assistant.conversationFolders).mockResolvedValue({ folders: [FOLDER], unfiled: 0 })
    const kept: ConversationTag & { count: number } = { id: 'kept', name: 'Kept', color: null, count: 3 }
    vi.mocked(assistant.conversationTags).mockResolvedValue({ tags: [kept] })
    await store.getState().loadTaxonomy()
    expect(store.getState().folderFilter).toBe('live')
    expect(store.getState().tagFilter).toBe('kept')
  })
})
