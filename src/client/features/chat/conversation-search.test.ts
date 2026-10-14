// @vitest-environment jsdom
/**
 * The conversation list's search box is the app's shared filter box, not a bare input.
 *
 * The notes rails and the assistant rail asked the same question with two different controls: one drew
 * a search icon, a clear button and an Escape that takes the text back out, and the other drew a text
 * field with none of them, so the same action looked different and cost different keystrokes depending
 * on which sidebar the reader was in. What is pinned here is the chrome the shared box owes every
 * listing, and the one thing a listing with a server behind it must not claim: the settled text is
 * handed to the store verbatim, because the endpoint answers a `LIKE` and not the compiled query.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBOUNCE } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ConversationList } from './ChatView'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { assistant: {} },
}))

const original = useAssistant.getState()
let root: Root
let container: HTMLDivElement

const box = () => container.querySelector<HTMLInputElement>('input[type="search"]')
const clearButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.getAttribute('aria-label') === t('notes.clear_filters'))

function typeInto(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    conversations: [],
    conversationQuery: '',
    folderFilter: 'all',
    tagFilter: null,
    listTab: 'folders',
    folderNodes: [],
    tagNodes: [],
    unfiledCount: 0,
    flagged: { starred: [], pinned: [] },
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    // The real setter writes the settled text back into the store, which is what keeps the box's own
    // draft and the committed query from drifting apart between the two commits below.
    setConversationQuery: vi.fn(async (value: string) => {
      useAssistant.setState({ conversationQuery: value })
    }),
    setListTab: vi.fn(async () => undefined),
    setFolderFilter: vi.fn(async () => undefined),
    setTagFilter: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(ConversationList, { activeId: null, onPick: () => undefined }))
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  useAssistant.setState(original, true)
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('the conversation search box', () => {
  it('is the shared filter box: search type, its own label and a search icon of its own', () => {
    const input = box()
    expect(input, 'the box is not the shared filter input').not.toBeNull()
    expect(input?.type).toBe('search')
    expect(input?.getAttribute('aria-label')).toBe(t('assistant.chat.search'))
    // The empty box holds one icon, so the one inside its own wrapper is the search glyph.
    expect(input?.parentElement?.querySelector('svg'), 'the box drew no search icon').not.toBeNull()
  })

  it('offers a clear control once there is something to clear, and it empties the box', async () => {
    const input = box()
    if (!input) throw new Error('the search box is missing')
    await act(async () => { typeInto(input, 'quarterly report') })
    // One commit per settled burst: the text reaches the store, which is what asks the server again.
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE.search) })
    const setQuery = useAssistant.getState().setConversationQuery
    expect(setQuery).toHaveBeenCalledWith('quarterly report')
    const clear = clearButton()
    expect(clear, 'a box with text in it owes a way to take it back out').not.toBeNull()
    await act(async () => { clear?.click() })
    expect(box()?.value).toBe('')
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE.search) })
    expect(setQuery).toHaveBeenLastCalledWith('')
  })

  it('answers Escape by taking the text out, not by closing what is behind it', async () => {
    const input = box()
    if (!input) throw new Error('the search box is missing')
    await act(async () => { typeInto(input, 'roadmap') })
    const escaped = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(escaped) })
    expect(box()?.value).toBe('')
    expect(escaped.defaultPrevented, 'Escape reached the panel behind a box that had text').toBe(true)
  })

  it('says so when what was typed is not a pattern', async () => {
    const input = box()
    if (!input) throw new Error('the search box is missing')
    await act(async () => { typeInto(input, '/((/') })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain(t('filter.regex_syntax'))
  })
})
