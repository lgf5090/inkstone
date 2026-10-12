/**
 * The conversation list's four pickers live in one tab container, the same shape the notebook's sidebar
 * uses. What is pinned here is the coupling between the strip and the panel: exactly one tab is
 * selected, the panel answers to that tab, and the two shortlists reach the store's flag endpoints
 * rather than re-reading the whole conversation list.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation, ChatFolderNode, ConversationTag } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { CHAT_TAXONOMY_PANEL_ID, ConversationTabStrip, ConversationTaxonomyPanel, chatTaxonomyTabId } from './ChatTaxonomy'
import { useAssistant, CONVERSATION_LIST_TABS } from './assistant-store'

const original = useAssistant.getState()

function conversation(id: string, title: string, over: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    id, title, pinned: false, starred: false, folderId: null,
    createdAt: 1, updatedAt: 2, messageCount: 1, ...over,
  }
}

const FOLDERS: ChatFolderNode[] = [{ id: 'f1', name: 'Project-A', parentId: null, icon: null, color: null, count: 2 }]
const TAGS: (ConversationTag & { count: number })[] = [{ id: 't1', name: 'urgent', color: null, count: 1 }]

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    listTab: 'folders',
    folderNodes: FOLDERS,
    unfiledCount: 1,
    tagNodes: TAGS,
    flagged: { starred: [conversation('s1', 'Starred one')], pinned: [conversation('p1', 'Pinned one')] },
    loadFlagged: vi.fn().mockResolvedValue(undefined),
    openConversation: vi.fn().mockResolvedValue(undefined),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render(createElement(ConversationTabStrip))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAssistant.setState(original, true)
  vi.unstubAllGlobals()
})

async function render(element: ReactElement) {
  await act(async () => { root.render(element) })
}

const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const panel = () => container.querySelector<HTMLElement>(`#${CHAT_TAXONOMY_PANEL_ID}`)

describe('conversation tab strip', () => {
  it('offers the four pickers in the order the store names them', () => {
    expect(tabs().map((tab) => tab.dataset.tab)).toEqual([...CONVERSATION_LIST_TABS])
    expect(tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })

  it('names each tab in the reader language and points it at the panel', () => {
    for (const tab of tabs()) {
      expect(tab.title.length, `${tab.dataset.tab} has no tooltip`).toBeGreaterThan(0)
      expect(tab.getAttribute('aria-controls')).toBe(CHAT_TAXONOMY_PANEL_ID)
    }
    expect(tabs().map((tab) => tab.title)).toEqual([
      t('assistant.chat.tab.folders'), t('assistant.chat.tab.tags'),
      t('assistant.chat.tab.starred'), t('assistant.chat.tab.pinned'),
    ])
  })

  it('moves the selection with the arrow keys and wraps at both ends', async () => {
    await act(async () => {
      tabs()[0].focus()
      tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    expect(useAssistant.getState().listTab).toBe('pinned')
    await act(async () => {
      tabs()[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(useAssistant.getState().listTab).toBe('folders')
  })

  it('asks for the shortlist only when a flag tab is opened', async () => {
    const loadFlagged = useAssistant.getState().loadFlagged
    expect(loadFlagged).not.toHaveBeenCalled()
    await act(async () => { tabs()[2].click() })
    expect(loadFlagged).toHaveBeenCalledTimes(1)
    await act(async () => { tabs()[0].click() })
    expect(loadFlagged).toHaveBeenCalledTimes(1)
  })
})

describe('conversation taxonomy panel', () => {
  it('shows the folder tree while the folders tab is selected', async () => {
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    expect(panel()?.getAttribute('aria-labelledby')).toBe(chatTaxonomyTabId('folders'))
    expect(panel()?.textContent).toContain('Project-A')
    expect(panel()?.textContent).toContain(t('assistant.chat.all'))
    expect(panel()?.querySelector('[role="group"]')).toBeNull()
  })

  it('swaps to the tag chips, and says so when there are none', async () => {
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    await act(async () => { tabs()[1].click() })
    expect(panel()?.getAttribute('aria-labelledby')).toBe(chatTaxonomyTabId('tags'))
    expect(panel()?.querySelector('[role="group"]')).not.toBeNull()
    expect(panel()?.textContent).toContain('urgent')
    await act(async () => { useAssistant.setState({ tagNodes: [] }) })
    expect(panel()?.textContent).toContain(t('assistant.chat.tag_none'))
  })

  it('opens a shortlisted conversation and hands the picker back to the caller', async () => {
    const onOpen = vi.fn()
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel, { onOpen })))
    await act(async () => { tabs()[2].click() })
    expect(panel()?.textContent).toContain('Starred one')
    const row = panel()!.querySelectorAll('button')[0]
    await act(async () => { row.click() })
    expect(useAssistant.getState().openConversation).toHaveBeenCalledWith('s1')
    expect(onOpen).toHaveBeenCalledTimes(1)
    await act(async () => { tabs()[3].click() })
    expect(panel()?.textContent).toContain('Pinned one')
    expect(panel()?.textContent).not.toContain('Starred one')
  })

  it('says so when a shortlist is empty', async () => {
    useAssistant.setState({ flagged: { starred: [], pinned: [] } })
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    await act(async () => { tabs()[2].click() })
    expect(panel()?.textContent).toContain(t('assistant.chat.empty_starred'))
    await act(async () => { tabs()[3].click() })
    expect(panel()?.textContent).toContain(t('assistant.chat.empty_pinned'))
  })
})
