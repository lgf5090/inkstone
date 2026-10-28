// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionNode, TagNode } from '../src/shared/development/api-tester/types'
import { defaultRequest, defaultState } from '../src/shared/development/api-tester/state'
import { childrenOf } from '../src/client/features/development/api-tester/lib/tree'
import { useApiTesterStore } from '../src/client/features/development/api-tester/store'
import { CollectionsPanel } from '../src/client/features/development/api-tester/components/CollectionsPanel'
import { ConfirmHost } from '../src/client/components/overlay'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'

const initialStore = useApiTesterStore.getState()
const INITIAL_FIELDS = {
  loaded: initialStore.loaded,
  loading: initialStore.loading,
  loadError: initialStore.loadError,
  state: initialStore.state,
  activeId: initialStore.activeId,
  openTabs: initialStore.openTabs,
  results: initialStore.results,
  loadingTabs: initialStore.loadingTabs,
  testResults: initialStore.testResults,
}

const TAGS: TagNode[] = [
  { id: 'tag-backend', name: 'Backend', parentId: null, color: 'blue', sortOrder: 0, createdAt: 1 },
  { id: 'tag-auth', name: 'Auth', parentId: 'tag-backend', color: 'emerald', sortOrder: 0, createdAt: 2 },
]

function requestNode(
  id: string,
  name: string,
  parentId: string | null,
  order: number,
  extra: Partial<CollectionNode> = {},
): CollectionNode {
  return {
    id,
    type: 'request',
    kind: 'rest',
    name,
    parentId,
    order,
    tags: [],
    updatedAt: 0,
    request: { ...defaultRequest(), url: `https://api.example.com/${id}` },
    ...extra,
  }
}

function folderNode(id: string, name: string, parentId: string | null, order: number): CollectionNode {
  return { id, type: 'folder', name, parentId, order, tags: [], updatedAt: 0 }
}

const FOLDER = folderNode('folder-products', 'Products', null, 1)
const LIST_USERS = requestNode('req-list', 'List users', FOLDER.id, 1, {
  tags: ['tag-auth'],
  lastStatus: 201,
  request: { ...defaultRequest(), method: 'GET', url: 'https://api.example.com/users' },
})
const HEALTH = requestNode('req-health', 'Health', null, 2, {
  request: { ...defaultRequest(), method: 'POST', url: 'https://api.example.com/health' },
})

const NODES = [FOLDER, LIST_USERS, HEALTH]

let rendered: RenderedElement | null = null

function installState(nodes: CollectionNode[] = NODES, activeId: string | null = null): void {
  const state = defaultState('workspace-ui-test')
  state.nodes = nodes
  state.tags = TAGS
  useApiTesterStore.setState({
    loaded: true,
    loading: false,
    loadError: null,
    state,
    activeId,
    openTabs: activeId ? [activeId] : [],
    results: {},
    loadingTabs: {},
    testResults: {},
  })
}

function mount(compact = false): {
  container: HTMLElement
  onOpenTagManager: ReturnType<typeof vi.fn>
  onRunCollection: ReturnType<typeof vi.fn>
  onRequestClose: ReturnType<typeof vi.fn>
} {
  const onOpenTagManager = vi.fn()
  const onRunCollection = vi.fn()
  const onRequestClose = vi.fn()
  rendered = renderElement(
    <>
      <CollectionsPanel
        compact={compact}
        onOpenTagManager={onOpenTagManager}
        onRunCollection={onRunCollection}
        onRequestClose={onRequestClose}
      />
      <ConfirmHost />
    </>,
  )
  return { container: rendered.container, onOpenTagManager, onRunCollection, onRequestClose }
}

function row(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-node-id="${id}"] [data-drag-row="${id}"]`)
  if (!element) throw new Error(`missing row ${id}`)
  return element
}

function click(element: Element | null): void {
  if (!element) throw new Error('missing element to click')
  act(() => {
    ;(element as HTMLElement).click()
  })
}

function setInput(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error('missing input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('missing input value setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: Element, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  useApiTesterStore.setState(INITIAL_FIELDS)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CollectionsPanel', () => {
  it('renders the folder tree, expands folders, marks the active request and shows its status', () => {
    installState(NODES, LIST_USERS.id)
    const { container } = mount()

    expect(container.querySelector('[data-node-id="folder-products"]')).not.toBeNull()
    expect(container.querySelector('[data-node-id="req-list"]')).toBeNull()
    expect(container.querySelector('[data-node-id="req-health"]')).not.toBeNull()

    click(container.querySelector(`[data-node-id="folder-products"] [data-action="toggle-folder"]`))
    expect(container.querySelector('[data-node-id="req-list"]')).not.toBeNull()

    const active = container.querySelector('[data-node-id="req-list"] [data-action="select-request"]')
    expect(active?.getAttribute('aria-current')).toBe('true')
    expect(row(container, 'req-list').textContent).toContain('201')
  })

  it('filters by name, URL and method, and auto-expands the matching ancestors', () => {
    installState()
    const { container } = mount()
    const search = container.querySelector<HTMLInputElement>(`input[placeholder="${t('development.apitester.search_requests')}"]`)

    setInput(search, 'users')
    expect(container.querySelector('[data-node-id="folder-products"]')).not.toBeNull()
    expect(container.querySelector('[data-node-id="req-list"]')).not.toBeNull()
    expect(container.querySelector('[data-node-id="req-health"]')).toBeNull()

    setInput(search, 'POST')
    expect(container.querySelector('[data-node-id="req-health"]')).not.toBeNull()
    expect(container.querySelector('[data-node-id="req-list"]')).toBeNull()

    setInput(search, 'missing')
    expect(container.textContent).toContain(t('development.apitester.no_match'))
  })

  it('filters the tree by tag, counts descendant tags and clears the filter on a second click', () => {
    installState()
    const { container } = mount()

    const backend = container.querySelector('[data-tag-id="tag-backend"]')
    expect(backend?.textContent).toContain('1')

    const tagSearch = container.querySelector<HTMLInputElement>(`input[placeholder="${t('development.apitester.search_tags')}"]`)
    setInput(tagSearch, 'Auth')
    expect(container.querySelector('[data-tag-id="tag-auth"]')).not.toBeNull()
    setInput(tagSearch, '')

    click(container.querySelector('[data-tag-id="tag-backend"] [data-action="toggle-tag"]'))
    expect(container.querySelector('[data-tag-id="tag-auth"]')).toBeNull()
    click(container.querySelector('[data-tag-id="tag-backend"] [data-action="toggle-tag"]'))
    expect(container.querySelector('[data-tag-id="tag-auth"]')).not.toBeNull()

    click(container.querySelector('[data-tag-id="tag-auth"] [data-action="select-tag"]'))
    expect(container.querySelector('[data-node-id="req-list"]')).not.toBeNull()
    expect(container.querySelector('[data-node-id="req-health"]')).toBeNull()

    click(container.querySelector('[data-tag-id="tag-auth"] [data-action="select-tag"]'))
    expect(container.querySelector('[data-node-id="req-health"]')).not.toBeNull()
  })

  it('renames on double click with Enter, and cancels with Escape', () => {
    installState()
    const { container } = mount()
    click(container.querySelector(`[data-node-id="folder-products"] [data-action="toggle-folder"]`))

    const nameButton = container.querySelector('[data-node-id="req-list"] [data-action="select-request"]')
    act(() => {
      nameButton?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    const input = container.querySelector<HTMLInputElement>('[data-node-id="req-list"] [data-action="rename-input"]')
    expect(input?.value).toBe('List users')
    setInput(input, 'Users list')
    press(input!, 'Enter')

    expect(useApiTesterStore.getState().state.nodes.find((node) => node.id === 'req-list')?.name).toBe('Users list')

    const renamed = container.querySelector('[data-node-id="req-list"] [data-action="select-request"]')
    act(() => {
      renamed?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    const again = container.querySelector<HTMLInputElement>('[data-node-id="req-list"] [data-action="rename-input"]')
    setInput(again, 'Ignored name')
    press(again!, 'Escape')
    expect(useApiTesterStore.getState().state.nodes.find((node) => node.id === 'req-list')?.name).toBe('Users list')
  })

  it('deletes a folder with all of its children', () => {
    installState()
    const { container } = mount()

    click(container.querySelector(`[data-node-id="folder-products"] button[aria-label="${t('development.apitester.more_actions')}"]`))
    click(menuItem(t('development.apitester.delete')) ?? null)
    expect(useApiTesterStore.getState().state.nodes.map((node) => node.id)).toEqual(['req-health'])
  })

  it('opens the new-node menu and starts an inline rename for the created folder', () => {
    installState()
    const { container } = mount()

    click(container.querySelector(`button[aria-label="${t('development.apitester.new_request')}"]`))
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(labels).toEqual([
      t('development.apitester.new_rest'),
      t('development.apitester.new_graphql'),
      t('development.apitester.new_websocket'),
      t('development.apitester.new_folder'),
    ])

    click(menuItem(t('development.apitester.new_folder')) ?? null)
    const created = useApiTesterStore.getState().state.nodes.find((node) => node.name === t('development.apitester.new_folder_name'))
    expect(created?.type).toBe('folder')

    const input = container.querySelector<HTMLInputElement>(`[data-node-id="${created?.id}"] [data-action="rename-input"]`)
    expect(input?.value).toBe(t('development.apitester.new_folder_name'))
    setInput(input, 'Renamed folder')
    press(input!, 'Enter')
    expect(useApiTesterStore.getState().state.nodes.find((node) => node.id === created?.id)?.name).toBe('Renamed folder')
  })

  it('reorders same-parent siblings from drag events', () => {
    installState([HEALTH, requestNode('req-a', 'Alpha', null, 1), requestNode('req-b', 'Beta', null, 2)])
    const { container } = mount()

    const from = container.querySelector('[data-drag-row="req-a"]')
    const target = container.querySelector('[data-drag-row="req-b"]')
    act(() => {
      from?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true }))
    })
    act(() => {
      target?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 100 }))
    })
    expect(target?.getAttribute('data-drop-position')).toBe('after')
    act(() => {
      target?.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 100 }))
    })

    expect(childrenOf(useApiTesterStore.getState().state.nodes, null).map((node) => node.id)).toEqual([
      'req-health',
      'req-b',
      'req-a',
    ])
  })

  it('moves a request into a folder through the keyboard-reachable menu', () => {
    installState()
    const { container } = mount()

    click(container.querySelector(`[data-node-id="req-health"] button[aria-label="${t('development.apitester.more_actions')}"]`))
    click(menuItem(t('development.apitester.move_to')) ?? null)
    const target = [...document.querySelectorAll<HTMLElement>('[data-submenu-row]')].find(
      (item) => item.textContent?.trim() === 'Products',
    )
    click(target ?? null)

    expect(useApiTesterStore.getState().state.nodes.find((node) => node.id === 'req-health')?.parentId).toBe('folder-products')
  })

  it('selects a request and closes the compact drawer', () => {
    installState()
    const { container, onRequestClose } = mount(true)
    click(container.querySelector(`[data-node-id="folder-products"] [data-action="toggle-folder"]`))
    click(container.querySelector('[data-node-id="req-list"] [data-action="select-request"]'))

    expect(useApiTesterStore.getState().activeId).toBe('req-list')
    expect(useApiTesterStore.getState().openTabs).toContain('req-list')
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})

describe('TagManagerDialog', () => {
  it('opens from the panel, creates a tag and deletes a parent tag with its descendants and node references', async () => {
    installState()
    const { container, onOpenTagManager } = mount()

    click(container.querySelector(`button[aria-label="${t('development.apitester.manage_tags')}"]`))
    expect(onOpenTagManager).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('development.apitester.tag_manager_title'))

    const nameInput = document.querySelector<HTMLInputElement>(`input[placeholder="${t('development.apitester.tag_name_placeholder')}"]`)
    setInput(nameInput, 'Release')
    click(
      [...document.querySelectorAll<HTMLElement>('button')].find(
        (button) => button.textContent?.trim() === t('development.apitester.add'),
      ) ?? null,
    )
    expect(useApiTesterStore.getState().state.tags.map((tag) => tag.name)).toContain('Release')

    const parentRow = document.querySelector('[role="dialog"] [data-tag-id="tag-backend"]')
    click(parentRow?.querySelector(`button[aria-label="${t('development.apitester.delete')}"]`) ?? null)

    expect(document.body.textContent).toContain(t('development.apitester.delete_tag_with_children', { name: 'Backend', count: 1 }))
    click(
      [...document.querySelectorAll<HTMLElement>('button')].find(
        (button) => button.textContent?.trim() === t('development.apitester.delete'),
      ) ?? null,
    )
    await settle()

    const state = useApiTesterStore.getState().state
    expect(state.tags).toHaveLength(1)
    expect(state.tags.some((tag) => tag.name === 'Release')).toBe(true)
    expect(state.tags.some((tag) => tag.id === 'tag-backend' || tag.id === 'tag-auth')).toBe(false)
    expect(state.nodes.find((node) => node.id === 'req-list')?.tags).toEqual([])
  })
})
