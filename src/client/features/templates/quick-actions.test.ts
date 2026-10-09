import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { Folder, NoteTemplate, PublicUser } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { TemplateQuickActions } from './quick-actions'

const create = vi.hoisted(() => vi.fn())

vi.mock('../../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    setContent: vi.fn(async () => {}),
    setContentBatch: vi.fn(async () => {}),
    dropContent: vi.fn(async () => {}),
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => { await task(); return true },
  },
  publishBroadcast: vi.fn(),
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, api: { ...actual.api, notes: { ...actual.api.notes, create } } }
})

const JOURNAL: Folder = {
  id: 'f-journal', name: 'Journal', parentId: null, icon: null, color: null,
  position: 0, createdAt: 1, updatedAt: 1,
}
const IDEAS: Folder = {
  id: 'f-ideas', name: 'Ideas', parentId: null, icon: null, color: null,
  position: 1, createdAt: 1, updatedAt: 1,
}

function template(overrides: Partial<NoteTemplate> & { id: string }): NoteTemplate {
  return {
    categoryId: null,
    name: overrides.id,
    description: '',
    content: `# ${overrides.id}`,
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let root: Root
let container: HTMLDivElement

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
}

function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
}

async function render(props: Parameters<typeof TemplateQuickActions>[0] = {}) {
  await act(async () => {
    root.render(createElement(TemplateQuickActions, props))
    await Promise.resolve()
  })
}

async function click(node: Element | undefined, type = 'click') {
  expect(node, 'the trigger to click is missing').toBeDefined()
  await act(async () => {
    const init: MouseEventInit = { bubbles: true, cancelable: true }
    if (type === 'pointerenter') {
      // React derives onPointerEnter from the bubbled pointerover, so drive that.
      node?.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerId: 1 } as PointerEventInit))
    } else {
      node?.dispatchEvent(type === 'pointerdown' ? new PointerEvent('pointerdown', init) : new MouseEvent(type, init))
    }
    await Promise.resolve()
  })
}

function payload(): Record<string, unknown> {
  return create.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  create.mockReset()
  create.mockImplementation(async (body: Record<string, unknown>) => {
    const now = Date.now()
    return {
      id: 'n-1', title: String(body?.title ?? ''), content: String(body?.content ?? ''), excerpt: '',
      folderId: (body?.folderId as string | null | undefined) ?? null, tags: [], isPinned: false, isStarred: false,
      isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: now,
      createdAt: now, updatedAt: now, deletedAt: null,
    }
  })
  await initI18n()
  useSession.setState({ settings: { ...DEFAULT_SETTINGS }, status: 'authed', user: null } as never)
  useNotes.setState({ folders: [JOURNAL, IDEAS], notes: {}, tags: [] } as never)
  useUi.setState({ view: 'all', folderId: null, tags: [], tag: null, panel: null } as never)
  useNoteTemplates.setState({
    hydrated: true,
    owner: 'u-1',
    categories: [],
    templates: [
      template({ id: 'plain', isStarred: false }),
      template({ id: 'alpha', name: 'Alpha', isStarred: true, updatedAt: 100 }),
      template({ id: 'pinned', name: 'Pinned', isStarred: true, isPinned: true, updatedAt: 50 }),
      template({ id: 'zeta', name: 'Zeta', isStarred: true, updatedAt: 200 }),
    ],
  } as never)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('the template quick actions', () => {
  it('offers the library from the template button', async () => {
    await render()
    await click(buttonNamed(t('templates.new_note_from_template')))
    expect(useUi.getState().panel).toBe('templates')
  })

  it('lists the starred templates pinned first, then by recency, and hides the rest', async () => {
    await render()
    await click(buttonNamed(t('templates.new_note_from_favorites')))
    const labels = menuItems().map((node) => node.textContent?.trim())
    expect(labels).toEqual(['Pinned', 'Zeta', 'Alpha'])
  })

  it('creates the note through the same contextual rules as the + button', async () => {
    useUi.setState({ view: 'folder', folderId: JOURNAL.id } as never)
    await render()
    await click(buttonNamed(t('templates.new_note_from_favorites')))
    await click(menuItems().find((node) => node.textContent?.trim() === 'Zeta'))
    expect(payload().title).toBe('Zeta')
    expect(payload().folderId).toBe(JOURNAL.id)
  })

  it('honours the folder the caller names over the open view, which is how the sidebar asks', async () => {
    useUi.setState({ view: 'folder', folderId: JOURNAL.id } as never)
    await render({ folderId: IDEAS.id })
    await click(buttonNamed(t('templates.new_note_from_favorites')))
    await click(menuItems().find((node) => node.textContent?.trim() === 'Alpha'))
    expect(payload().folderId).toBe(IDEAS.id)
  })

  it('points at the library when nothing is starred instead of opening an empty menu', async () => {
    useNoteTemplates.setState({ templates: [template({ id: 'plain' })] } as never)
    await render()
    await click(buttonNamed(t('templates.new_note_from_favorites')))
    const items = menuItems()
    expect(items.map((node) => node.disabled)).toEqual([true, false])
    await click(items[1])
    expect(useUi.getState().panel).toBe('templates')
    expect(create).not.toHaveBeenCalled()
  })

  it('waits for intent or idle before reading the library, then reads it for the signed-in account', async () => {
    const hydrate = vi.fn(async () => {})
    useNoteTemplates.setState({ hydrated: false, owner: null, hydrate } as never)
    useSession.setState({ user: { id: 'u-9', name: 'me' } as unknown as PublicUser } as never)
    await render()
    expect(hydrate, 'boot must not pay for a library the visitor may never open').not.toHaveBeenCalled()
    await click(buttonNamed(t('templates.new_note_from_favorites')), 'pointerdown')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(hydrate).toHaveBeenCalledWith('u-9')
  })

  it('hovering the favorites button is enough intent to read the library', async () => {
    const hydrate = vi.fn(async () => {})
    useNoteTemplates.setState({ hydrated: false, owner: null, hydrate } as never)
    useSession.setState({ user: { id: 'u-9', name: 'me' } as unknown as PublicUser } as never)
    await render()
    expect(hydrate).not.toHaveBeenCalled()
    await click(buttonNamed(t('templates.new_note_from_favorites')), 'pointerenter')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(hydrate).toHaveBeenCalledWith('u-9')
  })

  it('arms the read from requestIdleCallback when the browser offers one', async () => {
    let idleCallback: (() => void) | null = null
    const win = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    const timerFallback = vi.spyOn(window, 'setTimeout')
    win.requestIdleCallback = (cb) => {
      idleCallback = cb
      return 7
    }
    const hydrate = vi.fn(async () => {})
    useNoteTemplates.setState({ hydrated: false, owner: null, hydrate } as never)
    useSession.setState({ user: { id: 'u-9', name: 'me' } as unknown as PublicUser } as never)
    await render()
    expect(idleCallback, 'the component must register an idle callback, not only a timer').toBeTypeOf('function')
    expect(timerFallback.mock.calls.filter((call) => typeof call[1] === 'number' && call[1] >= 1000)).toEqual([])
    expect(hydrate).not.toHaveBeenCalled()
    await act(async () => {
      idleCallback?.()
      await Promise.resolve()
    })
    expect(hydrate).toHaveBeenCalledWith('u-9')
    delete win.requestIdleCallback
    vi.restoreAllMocks()
  })

  it('says the library is still being read instead of claiming nothing is starred', async () => {
    useNoteTemplates.setState({ hydrated: false, templates: [] } as never)
    await render()
    await click(buttonNamed(t('templates.new_note_from_favorites')))
    const items = menuItems()
    expect(items.length).toBe(1)
    expect(items[0].disabled).toBe(true)
    expect(items[0].textContent?.trim()).toBe(t('templates.favorites_loading'))
  })

  it('reads the library on its own once the page goes idle', async () => {
    vi.useFakeTimers()
    try {
      const hydrate = vi.fn(async () => {})
      useNoteTemplates.setState({ hydrated: false, owner: null, hydrate } as never)
      useSession.setState({ user: { id: 'u-9', name: 'me' } as unknown as PublicUser } as never)
      await act(async () => {
        root.render(createElement(TemplateQuickActions, {}))
      })
      expect(hydrate).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(1600)
      })
      expect(hydrate).toHaveBeenCalledWith('u-9')
    } finally {
      vi.useRealTimers()
    }
  })
})
