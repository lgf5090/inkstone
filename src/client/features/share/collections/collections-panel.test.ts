// @vitest-environment jsdom
/**
 * The published-directory panel, pinned at the three places a UI can promise more than the server gives.
 *
 * The first is the one that has broken before: a tag collection stores the tag *record id*, while the
 * shares it lists carry the tag's *name*, and the reference's editor wrote the name — publishing a page
 * that matched nothing next to a sidebar count that said it was full. The assertion below uses a tag whose
 * id and name differ, because an id that happens to look like the name would prove nothing.
 *
 * The second is the preview, which has to be the unauthenticated read: an owner-side rendering would show
 * the directory with its passcode already answered, which is the one thing the owner is checking. The
 * third is revoking, which cannot be undone and therefore cannot be a single click.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicCollection, ShareCollection, ShareFolder, ShareTag } from '@shared/share-hub'
import type { ShareListItem } from '@shared/types'
import { ConfirmHost, PromptHost } from '../../../components/overlay'
import { Toaster } from '../../../components/feedback'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals } from '../../../lib/test-render'
import { ShareCollectionsPanel } from './collections-panel'

const { request, ApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number
    readonly code: string

    constructor(status: number, code: string, message: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return { request: vi.fn(), ApiError: MockApiError }
})

vi.mock('../../../lib/api', () => ({ ApiError, request }))

const TAG_ID = 'tag_01HXX'
const TAG_NAME = 'Field notes'
const FOLDER: ShareFolder = { id: 'folder_01', parentId: null, name: 'Notes', position: 0, createdAt: 1, updatedAt: 1 }
const TAG: ShareTag = { id: TAG_ID, name: TAG_NAME, isPinned: false, createdAt: 1 }

let paths: Array<{ path: string, method: string, body: Record<string, unknown> | undefined }>
let collection: ShareCollection
let directory: PublicCollection
let root: Root
let host: HTMLElement
let copied: string[]

function baseCollection(overrides: Partial<ShareCollection> = {}): ShareCollection {
  return {
    id: 'coll_01',
    slug: 'dirslug0000000000000',
    title: TAG_NAME,
    targetType: 'tag',
    targetValue: TAG_ID,
    count: 4,
    hasPassword: false,
    expiresAt: null,
    isEnabled: true,
    memberSort: null,
    createdAt: 1,
    ...overrides,
  }
}

function share(noteId: string, noteTitle: string): ShareListItem {
  return {
    slug: `s-${noteId}`,
    noteId,
    url: `https://notes.test/s/${noteId}`,
    hasPassword: false,
    expiresAt: null,
    views: 0,
    createdAt: 1,
    isEnabled: true,
    lastViewedAt: null,
    folderId: null,
    tags: [],
    noteTitle,
    deletedAt: null,
    isPinned: false,
    isStarred: false,
  }
}

function byText(text: string): HTMLElement | null {
  return [...document.body.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="radio"]')]
    .find((node) => node.textContent?.trim() === text) ?? null
}

/**
 * The dialog's own button with that text.
 *
 * Modal portals to the end of document.body, and the panel header's "Publish a directory" button shares
 * the dialog submit's label, so a body-wide byText finds the header first and never presses submit.
 */
function dialogButton(text: string): HTMLElement | null {
  return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"] button')]
    .find((node) => node.textContent?.trim() === text) ?? null
}

async function show(): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null,
      createElement(ConfirmHost),
      createElement(PromptHost),
      createElement(Toaster),
      createElement(ShareCollectionsPanel, { onPreview: () => {} }),
    ))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(node: HTMLElement | null): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function choose(label: string, value: string): Promise<void> {
  const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
    ?? document.body.querySelector<HTMLSelectElement>('select')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select?.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

function posts(pathFragment: string): Array<{ path: string, method: string, body: Record<string, unknown> | undefined }> {
  return paths.filter((call) => call.path.includes(pathFragment) && call.method === 'POST')
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  paths = []
  copied = []
  collection = baseCollection()
  directory = { title: TAG_NAME, count: 4, notes: [{ slug: 'n1', title: 'Pond survey', excerpt: 'Four years of it.', hasPassword: false }], nextCursor: null, limit: 50 }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => { copied.push(text); return Promise.resolve() } },
  })
  request.mockImplementation((path: string, init: { method?: string, body?: unknown } = {}) => handle(path, init))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

/** The hub's own answers, with the directory read left switchable so a refusal can be staged. */
function handle(path: string, init: { method?: string, body?: unknown }): Promise<unknown> {
  const method = (init.method ?? 'GET') as string
  paths.push({ path, method, body: init.body as Record<string, unknown> | undefined })
  if (method === 'DELETE') return Promise.resolve({ ok: true })
  if (path.startsWith('/api/public/c/')) return Promise.resolve(directory)
  if (path === '/api/share/collections') return Promise.resolve({ collections: [collection] })
  if (path.startsWith('/api/share/collections/')) return Promise.resolve({ ok: true })
  if (path === '/api/share/folders') return Promise.resolve({ folders: [FOLDER] })
  if (path === '/api/share/tags') return Promise.resolve({ tags: [TAG] })
  if (path === '/api/share') return Promise.resolve({ shares: [share('n1', 'Pond survey'), share('n2', 'Hedge notes')] })
  return Promise.resolve({ ok: true })
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('publishing', () => {
  it('sends the tag record id, never the name the shares store', async () => {
    await show()
    await click(byText(t('share.collection_publish_action')))
    await click(byText(t('share.collection_kind_tag')))
    await choose(t('share.collection_tag_label'), TAG_ID)
    await click(dialogButton(t('share.collection_publish_action')))
    const created = posts('/api/share/collections')
    expect(created).toHaveLength(1)
    expect(created[0]?.body).toMatchObject({ targetType: 'tag', targetValue: TAG_ID })
    expect(created[0]?.body?.targetValue).not.toBe(TAG_NAME)
    // The name is what the directory prints, and the server derives it on every read: the form sends no copy.
    expect(created[0]?.body?.title ?? '').not.toBe(TAG_NAME)
  })

  it('refuses to publish a folder that was never picked', async () => {
    await show()
    await click(byText(t('share.collection_publish_action')))
    await click(dialogButton(t('share.collection_publish_action')))
    expect(posts('/api/share/collections')).toHaveLength(0)
    expect(document.body.textContent).toContain(t('share.collection_need_folder'))
  })

  it('requires a label and a member for a hand-picked directory', async () => {
    collection = baseCollection()
    await show()
    await click(byText(t('share.collection_publish_action')))
    await click(byText(t('share.collection_kind_manual')))
    await click(dialogButton(t('share.collection_publish_action')))
    expect(posts('/api/share/collections')).toHaveLength(0)
    expect(document.body.textContent).toContain(t('share.collection_need_title'))
  })
})

describe('the directory as the owner reads it', () => {
  it('lists a real table with a header per column and a row header per directory', async () => {
    await show()
    expect(document.body.querySelectorAll('thead th[scope="col"]')).toHaveLength(5)
    expect(document.body.querySelectorAll('tbody th[scope="row"]')).toHaveLength(1)
    expect(document.body.textContent).toContain(TAG_NAME)
    expect(document.body.textContent).toContain(t('share.collection_members', { count: 4 }))
  })

  it('pauses with a patch, and re-reads the list afterwards', async () => {
    await show()
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_pause')}"]`))
    const patch = paths.find((call) => call.method === 'PATCH')
    expect(patch?.path).toContain(`/api/share/collections/${collection.id}`)
    expect(patch?.body).toEqual({ isEnabled: false })
    expect(paths.filter((call) => call.path === '/api/share/collections').length).toBeGreaterThan(1)
  })

  it('copies the address, and the channel-marked variant, to the clipboard only', async () => {
    await show()
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_row_menu_label')}"]`))
    await click(byText(t('share.collection_copy_address')))
    expect(copied).toEqual([`${window.location.origin}/c/${collection.slug}`])
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_row_menu_label')}"]`))
    await click(byText(t('share.collection_copy_marked')))
    // The marker is this directory's own token, so its visits are a row of their own in the channel split.
    expect(copied[1]).toBe(`${window.location.origin}/c/${collection.slug}?ref=collection-${collection.slug}`)
    // Nothing about the capability went out on the wire, and nothing was logged.
    expect(paths.some((call) => call.path.includes('ref=collection'))).toBe(false)
  })
})

describe('previewing', () => {
  it('reads the public endpoint, so the owner sees what a stranger sees', async () => {
    await show()
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_preview')}"]`))
    expect(paths.some((call) => call.path === `/api/public/c/${collection.slug}` && call.method === 'POST')).toBe(true)
    expect(paths.some((call) => call.path.includes('/api/share/collections/') && call.method === 'GET')).toBe(false)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Pond survey')
    expect(document.body.textContent).toContain(t('share.collection_preview_count', { count: 4, shown: 1 }))
  })

  it('shows the refusal a passcode produces instead of the page behind it', async () => {
    request.mockImplementation((path: string, init: { method?: string } = {}) => {
      const method = (init.method ?? 'GET') as string
      paths.push({ path, method, body: undefined })
      if (path.startsWith('/api/public/c/')) {
        // A genuine ApiError: the route answers a missing passcode with 401, and the component only
        // trusts that status when the class behind it matches, exactly as the real request layer throws.
        return Promise.reject(new ApiError(401, 'passcode_required', 'An access password is required'))
      }
      if (path === '/api/share/collections') return Promise.resolve({ collections: [collection] })
      if (path === '/api/share/folders') return Promise.resolve({ folders: [FOLDER] })
      if (path === '/api/share/tags') return Promise.resolve({ tags: [TAG] })
      if (path === '/api/share') return Promise.resolve({ shares: [] })
      return Promise.resolve({ ok: true })
    })
    await show()
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_preview')}"]`))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain(t('share.collection_preview_locked'))
    expect(document.body.textContent).not.toContain('Pond survey')
  })
})

describe('revoking', () => {
  it('asks first, and only deletes once the answer is yes', async () => {
    await show()
    await click(document.body.querySelector(`button[aria-label="${t('share.collection_row_menu_label')}"]`))
    await click(byText(t('share.collection_delete')))
    expect(paths.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(document.body.textContent).toContain(t('share.collection_delete_confirm_title', { title: TAG_NAME }))

    await click(byText(t('share.collection_delete_confirm_action')))
    expect(paths.filter((call) => call.method === 'DELETE').map((call) => call.path))
      .toEqual([`/api/share/collections/${collection.id}`])
  })
})
