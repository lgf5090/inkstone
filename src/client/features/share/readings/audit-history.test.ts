// @vitest-environment jsdom
/**
 * The audit trail's one promise: it may say what changed, and it may never say what the secret was.
 *
 * The worker records a passcode as a boolean for that reason, so this surface normally has nothing to
 * hide. The guard is for the case where it does not — a payload that carried a hash, or a value shaped
 * like one arriving in any other field — because a change history is exactly the kind of list an owner
 * reads aloud on a screen share, pastes into an issue, or leaves open on a second monitor.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareAuditLogEntry, ShareAuditLogResponse } from '@shared/share-hub'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals } from '../../../lib/test-render'
import { ShareAuditHistory } from './audit-history'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status = 500, readonly code = 'error', message = 'failed') {
      super(message)
    }
  },
  request,
}))

const NOTE_ID = 'note-one'
const SECRET = '5e4b7a1c0d2f3e6b8a9c1d2e3f4051627384950a1b2c3d4e5f60718293a4b5c6'

let calls: string[]
let page: ShareAuditLogResponse
let root: Root
let host: HTMLElement

function entry(overrides: Partial<ShareAuditLogEntry> & { id: string }): ShareAuditLogEntry {
  return {
    noteId: NOTE_ID,
    slug: 'abc',
    action: 'update',
    changed: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function byText(text: string): HTMLElement | null {
  return [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === text) ?? null
}

async function show(): Promise<void> {
  await act(async () => {
    root.render(createElement(ShareAuditHistory, { noteId: NOTE_ID }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  calls = []
  page = { entries: [], total: 0, page: 1, limit: 100 }
  request.mockImplementation((path: string) => {
    calls.push(path)
    return Promise.resolve(page)
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the passcode entry', () => {
  it('says a passcode was set, and never what it was', async () => {
    page = {
      ...page,
      entries: [entry({ id: 'e1', changed: [{ field: 'has_password', from: false, to: true }] })],
      total: 1,
    }
    await show()
    expect(document.body.textContent).toContain(t('share.audit_value_password_set'))
    expect(document.body.textContent).not.toContain('true')
  })

  it('says a passcode was cleared', async () => {
    page = {
      ...page,
      entries: [entry({ id: 'e2', changed: [{ field: 'has_password', from: true, to: false }] })],
      total: 1,
    }
    await show()
    expect(document.body.textContent).toContain(t('share.audit_value_password_cleared'))
  })

  it('redacts a value that looks like a secret wherever it turns up', async () => {
    page = {
      ...page,
      entries: [entry({ id: 'e3', changed: [{ field: 'has_password', from: false, to: true }, { field: 'slug', from: SECRET, to: 'abc' }] })],
      total: 1,
    }
    await show()
    const text = document.body.textContent ?? ''
    expect(text).toContain(t('share.audit_value_redacted'))
    expect(text).not.toContain(SECRET)
    // A share address is not a secret to its own owner, so the new slug still prints.
    expect(text).toContain('abc')
  })
})

describe('the trail as a reading', () => {
  it('prints the entries in the order the server sent them', async () => {
    page = {
      ...page,
      entries: [
        entry({ id: 'newest', createdAt: 1_700_000_200_000, changed: [{ field: 'is_enabled', from: false, to: true }] }),
        entry({ id: 'older', createdAt: 1_700_000_100_000, changed: [{ field: 'expires_at', from: null, to: 1_700_000_900_000 }] }),
      ],
      total: 2,
    }
    await show()
    const items = [...document.body.querySelectorAll('section > ul > li')].map((node) => node.textContent ?? '')
    expect(items[0]).toContain(t('share.audit_value_enabled'))
    expect(items[1]).not.toContain(t('share.audit_value_enabled'))
  })

  it('names an unknown field by its stored name instead of dropping it', async () => {
    page = { ...page, entries: [entry({ id: 'e4', changed: [{ field: 'widget_mode', from: 'a', to: 'b' }] })], total: 1 }
    await show()
    expect(document.body.textContent).toContain('widget_mode')
  })

  it('says there is no history, and says so when the history cannot be read', async () => {
    await show()
    expect(document.body.textContent).toContain(t('share.audit_empty'))

    act(() => {
      request.mockImplementation(() => Promise.reject(new Error('boom')))
    })
    await act(async () => {
      root.render(createElement(ShareAuditHistory, { noteId: 'other-note' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain(t('share.audit_load_failed'))
    expect(byText(t('common.retry'))).toBeTruthy()
  })

  it('pages by the limit the route answered with, not one it assumed', async () => {
    page = {
      entries: [entry({ id: 'e5', changed: [{ field: 'is_enabled', from: true, to: false }] })],
      total: 140,
      page: 1,
      limit: 100,
    }
    await show()
    expect(document.body.textContent).toContain(t('share.reading_page_info', { page: 1, totalPages: 2 }))
    expect(byText(t('share.reading_next_page'))?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      byText(t('share.reading_next_page'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(calls.at(-1)).toContain('page=2')
    expect(calls.at(-1)).toContain(`limit=${page.limit}`)
  })
})
