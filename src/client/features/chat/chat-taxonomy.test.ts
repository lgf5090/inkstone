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
import { TREE_INDENT_BASE, TREE_INDENT_STEP } from '../../lib/tree'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { CHAT_TAXONOMY_PANEL_ID, ConversationTabStrip, ConversationTaxonomyPanel, chatTaxonomyTabId, moveMenuTree } from './ChatTaxonomy'
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
    folderFilter: 'all',
    tagFilter: null,
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

  /**
   * The chip is the app's shared one: the same box, the same `aria-pressed`, the same colour dot and the
   * same tabular count as every other tag surface, and a tag that labels nothing is still shown, because
   * hiding it says "deleted" when the reader meant "not used yet".
   */
  it('draws the tag picks as the shared chips, including the ones that count nothing', async () => {
    useAssistant.setState({
      tagNodes: [
        { id: 't1', name: 'urgent', color: '#e5484d', count: 3 },
        { id: 't2', name: 'quiet', color: null, count: 0 },
      ],
      tagFilter: null,
      // Picking a tag asks the server for the list; the chip's own state is what is under test here.
      setTagFilter: vi.fn(async () => undefined),
    })
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    await act(async () => { tabs()[1].click() })
    const chips = [...panel()?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? []]
    expect(chips).toHaveLength(2)
    expect(chips[0]?.textContent).toContain('urgent')
    expect(chips[0]?.textContent).toContain('3')
    expect(chips[0]?.querySelector<HTMLElement>('span[aria-hidden="true"]')?.style.backgroundColor).toBe('rgb(229, 72, 77)')
    expect(chips[1]?.textContent).toContain('quiet')
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    await act(async () => { chips[1].click() })
    expect(useAssistant.getState().setTagFilter).toHaveBeenCalledWith('t2')
  })

  it('reads the tag in force back out of the chip that holds it', async () => {
    useAssistant.setState({
      tagNodes: [{ id: 't1', name: 'urgent', color: null, count: 1 }],
      tagFilter: 't1',
      setTagFilter: vi.fn(async () => undefined),
    })
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
    await act(async () => { tabs()[1].click() })
    const chip = panel()?.querySelector<HTMLButtonElement>('button[aria-pressed]')
    expect(chip?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { chip?.click() })
    // Pressing the chip that is in force is how the reader takes the filter off again.
    expect(useAssistant.getState().setTagFilter).toHaveBeenCalledWith(null)
  })
})

/**
 * The folder picker is the notes rail's tree, not a list that happens to be indented: the rows say what
 * level they sit at and whether they are open, the arrow keys walk them, a branch folds, and the
 * folder's own mark and colour are the ones the server chose for it.
 */
const NESTED: ChatFolderNode[] = [
  { id: 'ship', name: 'Ship-it', parentId: null, icon: '🚀', color: '#e5484d', count: 2 },
  { id: 'drafts', name: 'Drafts', parentId: 'ship', icon: null, color: null, count: 1 },
]

const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const rowAt = (index: number) => rows()[index]?.querySelector<HTMLButtonElement>('[data-tree-row]')
const rowNames = () => rows().map((row) => row.querySelector<HTMLButtonElement>('[data-tree-row]')?.textContent)
const press = async (node: HTMLElement | null | undefined, key: string) => {
  if (!node) throw new Error('the tree row is missing')
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('the conversation folder tree', () => {
  beforeEach(async () => {
    // A branch left open by the case before this one would be the state this case reads as its own.
    useUi.setState({ expandedFolders: [] })
    useAssistant.setState({
      folderNodes: NESTED,
      unfiledCount: 0,
      folderFilter: 'all',
      tagFilter: null,
      // Choosing a folder asks the server for the list; which folder the row shows as in force is the
      // part this tree owns, so the action is replaced rather than the network reached for.
      setFolderFilter: vi.fn(async () => undefined),
    })
    await render(createElement('div', null,
      createElement(ConversationTabStrip), createElement(ConversationTaxonomyPanel)))
  })

  it('exposes the levels, sizes and positions a screen reader asks a tree for', () => {
    const tree = panel()?.querySelector('[role="tree"]')
    expect(tree, 'the folder picker is not a tree').not.toBeNull()
    expect(tree?.getAttribute('aria-label')).toBe(t('assistant.chat.folder_filter'))
    // Ship-it is a root with a child, so it states it is closed; Drafts is folded away inside it.
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.getAttribute('aria-level')).toBe('1')
    expect(rows()[0]?.getAttribute('aria-setsize')).toBe('1')
    expect(rows()[0]?.getAttribute('aria-posinset')).toBe('1')
    expect(rows()[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')
    expect(rowAt(0)?.getAttribute('aria-current')).toBeNull()
  })

  it('keeps a folded branch out of the tree until the reader opens it', async () => {
    expect(rowNames()).toEqual(['Ship-it'])
    await act(async () => { rows()[0].querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click() })
    expect(rowNames()).toEqual(['Ship-it', 'Drafts'])
    expect(rows()[1]?.getAttribute('aria-level')).toBe('2')
    expect(rows()[1]?.getAttribute('aria-setsize')).toBe('1')
    expect(rows()[1]?.getAttribute('aria-posinset')).toBe('1')
    expect(rows()[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(rowAt(1)?.getAttribute('aria-current')).toBeNull()
    // The open set is the notes rail's, keyed by the same folder ids, so it outlives this panel.
    expect(useUi.getState().expandedFolders).toContain('ship')
  })

  it('marks the row in force the way the rail marks its own', async () => {
    await act(async () => { useAssistant.setState({ folderFilter: 'ship' }) })
    expect(rowAt(0)?.getAttribute('aria-current')).toBe('page')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('chooses the folder and opens its branch on the way in, like the rail', async () => {
    await act(async () => { rowAt(0)?.click() })
    expect(useAssistant.getState().setFolderFilter).toHaveBeenCalledWith('ship')
    expect(useUi.getState().expandedFolders).toContain('ship')
  })

  it('opens the branch that holds the folder being filtered', async () => {
    await act(async () => { useAssistant.setState({ folderFilter: 'drafts' }) })
    expect(useUi.getState().expandedFolders).toContain('ship')
    expect(rowNames()).toEqual(['Ship-it', 'Drafts'])
    expect(rowAt(1)?.getAttribute('aria-current')).toBe('page')
  })

  it('walks the rows with the arrows and folds on the way back out', async () => {
    await act(async () => { rows()[0].querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click() })
    rowAt(0)?.focus()
    await press(rowAt(0), 'ArrowDown')
    expect(document.activeElement).toBe(rowAt(1))
    await press(rowAt(1), 'ArrowLeft')
    // ArrowLeft on a leaf returns to its parent; it is the parent's own turn to close.
    expect(document.activeElement).toBe(rowAt(0))
    expect(useUi.getState().expandedFolders).toContain('ship')
    await press(rowAt(0), 'ArrowLeft')
    expect(useUi.getState().expandedFolders).not.toContain('ship')
    expect(rowNames()).toEqual(['Ship-it'])
    await press(rowAt(0), 'ArrowRight')
    expect(useUi.getState().expandedFolders).toContain('ship')
  })

  it('draws the folder its own mark and colour, the way the rail does', async () => {
    await act(async () => { rows()[0].querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click() })
    const glyph = rowAt(0)?.parentElement
    expect(glyph?.textContent).toContain('🚀')
    // The rail's own rule: the colour the folder carries is written on the mark, not left to a class.
    // jsdom answers a hex colour as its rgb form, so that is what the assertion names.
    expect(glyph?.querySelector<HTMLElement>('span[style]')?.style.color).toBe('rgb(229, 72, 77)')
    // A folder with no mark of its own gets the rail's animated one, not a second glyph.
    expect(rows()[1].querySelector('.folder-motion-icon')).not.toBeNull()
  })

  it('indents by the shared step, not by one the row worked out', async () => {
    await act(async () => { rows()[0].querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click() })
    const indentOf = (index: number) => rowAt(index)?.parentElement?.style.paddingLeft
    expect(indentOf(0)).toBe(`${TREE_INDENT_BASE}px`)
    expect(indentOf(1)).toBe(`${TREE_INDENT_BASE + TREE_INDENT_STEP}px`)
  })
})

/**
 * The move picker is the notes rail's, so the chat hands it the nesting rather than a flat list with the
 * depth written into the label: children under their parent, the count of what sits directly inside, and
 * the folder's own mark and colour, which is what the picker draws beside each row.
 */
describe('the tree handed to the move picker', () => {
  it('keeps the hierarchy and the marks a folder owns', () => {
    expect(moveMenuTree(NESTED)).toEqual([
      {
        id: 'ship', name: 'Ship-it', directNotes: 2, icon: '🚀', color: '#e5484d',
        children: [{ id: 'drafts', name: 'Drafts', directNotes: 1, icon: null, color: null, children: [] }],
      },
    ])
  })

  it('keeps a folder whose parent is gone as a root instead of losing it', () => {
    const orphans: ChatFolderNode[] = [
      { id: 'drafts', name: 'Drafts', parentId: 'gone', icon: null, color: null, count: 1 },
      { id: 'inbox', name: 'Alpha', parentId: null, icon: null, color: null, count: 0 },
    ]
    // Roots sort by name, and the orphan joins them rather than vanishing with its missing parent.
    expect(moveMenuTree(orphans).map((node) => node.id)).toEqual(['inbox', 'drafts'])
  })
})
