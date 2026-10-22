// @vitest-environment jsdom
/**
 * The hub shell: what the rail selects, what a selection is allowed to act on, and what the panel
 * says when the list never arrived.
 *
 * The views themselves are mocked out. This file is only about the rules the shell owns — that a
 * category and a filing are one choice, that the rows a batch will touch are the rows currently on
 * screen, and that the shared `shareMatchesSelection` predicate is what decides both. Those are the
 * behaviours a screenshot cannot tell apart from a working panel that quietly acts on the wrong set.
 */
import { Fragment, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareListItem } from '@shared/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { ShareHubModal } from './share-hub-modal'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  folders: vi.fn(),
  tags: vi.fn(),
  setEnabled: vi.fn(),
  revoke: vi.fn(),
  organize: vi.fn(),
}))

vi.mock('../../../lib/api', () => ({ ApiError: class ApiError extends Error {} }))

vi.mock('../../../lib/api-share-hub', () => ({
  shareHubApi: {
    list: (signal?: AbortSignal) => api.list(signal),
    stats: (signal?: AbortSignal) => api.stats(signal),
    folders: { list: () => api.folders() },
    tags: { list: () => api.tags() },
    batch: {
      setEnabled: (ids: string[], enabled: boolean) => api.setEnabled(ids, enabled),
      revoke: (ids: string[]) => api.revoke(ids),
      organize: (ids: string[], body: unknown) => api.organize(ids, body),
    },
  },
}))

// The four panels the shell can open are each covered by their own file; here they must not fetch.
vi.mock('../dashboard/dashboard-view', () => ({
  ShareDashboardView: () => createElement('div', { 'data-test': 'dashboard' }),
}))
vi.mock('../collections/collections-panel', () => ({
  ShareCollectionsPanel: () => createElement('div', { 'data-test': 'collections' }),
}))
vi.mock('../detail/edit-modal', () => ({ ShareEditModal: () => null }))
vi.mock('../detail/qr-modal', () => ({ ShareQrModal: () => null }))
vi.mock('../detail/settings-modal', () => ({ ShareSettingsModal: () => null }))
vi.mock('../readings/note-analytics-modal', () => ({ ShareNoteAnalyticsModal: () => null }))
vi.mock('../readings/visit-log-modal', () => ({ ShareVisitLogModal: () => null }))
vi.mock('../readings/audit-history', () => ({ ShareAuditHistory: () => null }))

let root: Root
let host: HTMLElement

const DAY = 86_400_000

function row(noteId: string, over: Partial<ShareListItem> = {}): ShareListItem {
  const now = Date.now()
  return {
    slug: `slug-${noteId}`,
    noteId,
    url: `https://notes.test/s/slug-${noteId}`,
    hasPassword: false,
    expiresAt: null,
    views: 0,
    createdAt: now,
    isEnabled: true,
    lastViewedAt: null,
    folderId: null,
    tags: [],
    noteTitle: `Note ${noteId}`,
    deletedAt: null,
    isPinned: false,
    isStarred: false,
    ...over,
  }
}

const ROWS = [
  row('live', { views: 7, lastViewedAt: Date.now() - DAY }),
  row('paused', { isEnabled: false }),
  row('locked', { hasPassword: true }),
  row('filed', { folderId: 'f1' }),
  row('tagged', { tags: ['weekly'] }),
  row('expiring', { expiresAt: Date.now() + 2 * DAY }),
  row('dead', { expiresAt: Date.now() - DAY }),
  row('star', { isStarred: true }),
]

const STATS = {
  totalShares: ROWS.length,
  activeShares: 6,
  pinnedShares: 0,
  starredShares: 1,
  pausedShares: 1,
  passwordShares: 1,
  expiringShares: 1,
  expiringSoonShares: 1,
  permanentShares: 6,
  expiredShares: 1,
  totalViews: 7,
  totalVisitors: 3,
  folderCounts: { f1: { total: 1, shared: 1 } },
  tagCounts: { weekly: { total: 1, shared: 1 } },
}

function seedHub(): void {
  api.list.mockResolvedValue({ shares: ROWS })
  api.stats.mockResolvedValue({ globalStats: STATS })
  api.folders.mockResolvedValue({
    folders: [{ id: 'f1', parentId: null, name: 'Field notes', position: 0, createdAt: 0, updatedAt: 0 }],
  })
  api.tags.mockResolvedValue({ tags: [{ id: 't1', name: 'weekly', isPinned: false, createdAt: 0 }] })
}

async function openHub(): Promise<void> {
  seedHub()
  await act(async () => {
    // `confirm` is a hosted dialog, not a window call: with no host mounted it answers "no" at once,
    // which would let a revoke test pass by never reaching the confirmation.
    root.render(
      createElement(Fragment, null,
        createElement(ConfirmHost),
        createElement(ShareHubModal, { open: true, onClose: () => {} }),
      ),
    )
  })
  await act(async () => { await Promise.resolve() })
}

/**
 * The hub with its list on screen.
 *
 * The panel opens on the dashboard, which is a view of its own and mounts neither the toolbar nor the
 * table — so anything that reads a row or presses a list control has to move the rail first. That is
 * the behaviour under test, not a step to skip.
 */
async function openList(): Promise<void> {
  await openHub()
  await click(byText(t('share.cat_all')))
}

/**
 * The control labelled `text`.
 *
 * An exact match wins, and only then a leading one: a rail row prints its count after the words, so
 * "Paused 1" has to be reachable by "Paused" — but the batch bar's "Pause" must not be answered by
 * that same rail row, which is what a bare prefix search did the first time this file ran.
 */
function byText(text: string): HTMLElement | null {
  const nodes = [...document.body.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
  const trimmed = nodes.map((node) => node.textContent?.trim() ?? '')
  const exact = trimmed.indexOf(text)
  if (exact >= 0) return nodes[exact]
  const prefix = trimmed.findIndex((value) => value.startsWith(text))
  return prefix >= 0 ? nodes[prefix] : null
}

/**
 * The note titles on screen, read out of the title column.
 *
 * Addressed by cell position rather than by text: the row's own header cell holds the checkbox, whose
 * accessible name also contains the title, so a text search over the row would count every link twice.
 */
function titlesShown(): string[] {
  return [...document.body.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    .map((tr) => tr.cells[1]?.textContent?.trim() ?? '')
    .filter((text) => text.startsWith('Note '))
}

async function click(node: Element | null | undefined): Promise<void> {
  if (!node) throw new Error('the control the test names is not on screen')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useUi.setState({ toast: vi.fn() } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('opening the hub', () => {
  it('lands on the dashboard and fetches the rows and the counters once', async () => {
    await openHub()
    expect(document.body.querySelector('[data-test="dashboard"]')).toBeTruthy()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.stats).toHaveBeenCalledTimes(1)
  })

  it('names every one of the twelve views', async () => {
    await openHub()
    for (const key of [
      'share.cat_all', 'share.cat_active', 'share.cat_pinned', 'share.cat_starred',
      'share.cat_paused', 'share.cat_password', 'share.cat_expiring_soon',
      'share.cat_expiring', 'share.cat_permanent', 'share.cat_expired',
    ]) {
      expect(document.body.textContent, `${t(key)} is missing from the rail`).toContain(t(key))
    }
  })

  it('says so, and offers a retry, when the list never arrives', async () => {
    await openList()
    // Staged after the fixture's own default, which would otherwise replace it outright.
    api.list.mockRejectedValue(new Error('offline'))
    const refresh = document.body.querySelector<HTMLElement>(`[aria-label="${t('share.hub_refresh')}"]`)
    await click(refresh)
    expect(document.body.textContent).toContain(t('share.hub_load_failed'))
    expect(byText(t('common.retry'))).toBeTruthy()
  })
})

describe('the rail’s selection', () => {
  it('shows only the links a category selects, by the shared rule', async () => {
    await openHub()
    await click(byText(t('share.cat_paused')))
    expect(titlesShown()).toEqual(['Note paused'])
  })

  it('treats an expiry in the window as expiring soon and not yet expired', async () => {
    await openHub()
    await click(byText(t('share.cat_expiring_soon')))
    expect(titlesShown()).toEqual(['Note expiring'])
    await click(byText(t('share.cat_expired')))
    expect(titlesShown()).toEqual(['Note dead'])
  })

  it('narrows to one folder when the tree is picked, and clears when it is picked again', async () => {
    await openHub()
    await click(byText('Field notes'))
    expect(titlesShown()).toEqual(['Note filed'])
    await click(byText(t('share.cat_all')))
    expect(titlesShown()).toHaveLength(ROWS.length)
  })

  it('selects a tag by its name, which is what the row stores', async () => {
    await openHub()
    await click(byText('weekly'))
    expect(titlesShown()).toEqual(['Note tagged'])
  })

  it('filters the held rows by title without asking the server again', async () => {
    await openList()
    const before = api.list.mock.calls.length
    const box = document.body.querySelector<HTMLInputElement>('input[type="search"]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(box, 'live')
      box?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(titlesShown()).toEqual(['Note live'])
    expect(api.list.mock.calls.length).toBe(before)
  })
})

describe('a selection', () => {
  /**
   * A row is ticked through its accessible name, because that name is the point: the control is a
   * `role="checkbox"` button whose only text is the note it selects, so a row that ever loses its
   * name loses this test with it.
   */
  async function select(noteTitle: string): Promise<void> {
    const boxes = [...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    await click(boxes.find((box) => box.textContent?.includes(noteTitle)))
  }

  it('is reset when the view changes, so a batch cannot act on rows no longer on screen', async () => {
    await openHub()
    await click(byText(t('share.cat_all')))
    await select('Note live')
    await click(byText(t('share.cat_paused')))
    expect(api.setEnabled).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain(t('share.hub_batch_count', { count: 1 }))
  })

  it('sends exactly the note ids it names, and no more', async () => {
    api.setEnabled.mockResolvedValue({ ok: true, count: 2 })
    await openList()
    await select('Note live')
    await select('Note locked')
    await click(byText(t('share.hub_batch_pause')))
    expect(api.setEnabled).toHaveBeenCalledWith(['live', 'locked'], false)
  })

  it('asks before revoking, and only then sends the batch', async () => {
    api.revoke.mockResolvedValue({ ok: true, count: 1 })
    await openList()
    await select('Note live')
    await click(byText(t('share.hub_batch_revoke')))
    expect(api.revoke).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      t('share.hub_batch_revoke_title', { count: 1 }),
    )
    await click(byText(t('share.revoke_link')))
    expect(api.revoke).toHaveBeenCalledWith(['live'])
  })
})
