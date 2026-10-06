import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../lib/i18n'
import { api } from '../lib/api'
import { localDb } from '../lib/db'
import { useSession } from './session'

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title: string; description?: string; tone?: string }) => false))
const notes = vi.hoisted(() => ({ pendingCount: 2, flushFails: true }))

vi.mock('../components/overlay', () => ({ confirm: confirmMock }))
vi.mock('../store/notes', () => ({
  useNotes: {
    getState: () => ({
      pendingCount: notes.pendingCount,
      flush: async () => {
        if (notes.flushFails) throw new Error('offline')
      },
    }),
  },
}))

beforeEach(async () => {
  localStorage.clear()
  notes.pendingCount = 2
  notes.flushFails = true
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(false)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  vi.spyOn(window, 'confirm').mockImplementation(() => true)
  vi.spyOn(api, 'logout').mockResolvedValue({ ok: true })
  vi.spyOn(localDb, 'clear').mockResolvedValue(undefined)
  vi.stubGlobal('location', { reload: vi.fn(), href: 'http://localhost/' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('signing out with unsynced edits', () => {
  it('asks through the confirmation dialog and stops when it is cancelled', async () => {
    await useSession.getState().logout()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const options = confirmMock.mock.calls[0][0]
    expect(options.title).toBe(t('common.log_out'))
    expect(options.description).toBe(t('session.logout_pending_changes', { count: '2' }))
    expect(options.tone).toBe('danger')
    expect(api.logout).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('signs out and clears the local cache once the dialog is accepted', async () => {
    confirmMock.mockResolvedValue(true)
    await useSession.getState().logout()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(api.logout).toHaveBeenCalledTimes(1)
    expect(localDb.clear).toHaveBeenCalledTimes(1)
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('signs out without asking when nothing is waiting to sync', async () => {
    notes.pendingCount = 0
    notes.flushFails = false
    confirmMock.mockResolvedValue(false)
    await useSession.getState().logout()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(api.logout).toHaveBeenCalledTimes(1)
  })
})
