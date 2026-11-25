import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { mergeSettings } from '@shared/constants'

const mocks = vi.hoisted(() => ({
  note: { id: 'a'.repeat(26), isEncrypted: false, deletedAt: null },
  contents: {} as Record<string, string>,
  offlineNoteIds: [] as string[],
  get: vi.fn(),
  setContent: vi.fn(async () => {}),
  updateSettings: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../lib/api', () => ({ api: { notes: { get: mocks.get } } }))
vi.mock('../../lib/db', () => ({ localDb: { setContent: mocks.setContent } }))
vi.mock('../../store/notes', () => ({
  useNotes: { getState: () => ({ notes: { [mocks.note.id]: mocks.note }, contents: mocks.contents }) },
}))
vi.mock('../../store/session', () => ({
  useSession: { getState: () => ({
    settings: { notes: { offlineNoteIds: mocks.offlineNoteIds } },
    updateSettings: mocks.updateSettings,
  }) },
}))
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast: mocks.toast }) } }))

import { pinNoteForOffline, prefetchOfflineNotes, toggleOfflineNoteId } from './offline-notes'

beforeEach(async () => {
  await initI18n()
  mocks.contents = {}
  mocks.offlineNoteIds = []
  mocks.get.mockReset().mockResolvedValue({ id: mocks.note.id, content: 'offline body', rev: 2, updatedAt: 3 })
  mocks.setContent.mockClear()
  mocks.updateSettings.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
})

describe('selective offline notes', () => {
  it('toggles ids without duplicates and respects the account ceiling', () => {
    expect(toggleOfflineNoteId([], 'a'.repeat(26), true)).toEqual(['a'.repeat(26)])
    expect(toggleOfflineNoteId(['a'.repeat(26)], 'a'.repeat(26), false)).toEqual([])
    const full = Array.from({ length: 200 }, (_, index) => String(index).padStart(26, '0'))
    expect(toggleOfflineNoteId(full, 'z'.repeat(26), true)).toHaveLength(200)
  })

  it('validates persisted offline ids through the settings merge', () => {
    const merged = mergeSettings({ notes: { offlineNoteIds: [mocks.note.id, mocks.note.id, 'bad'] } })
    expect(merged.notes.offlineNoteIds).toEqual([mocks.note.id])
  })

  it('fetches and caches the body before persisting the offline pin', async () => {
    await pinNoteForOffline(mocks.note.id)
    expect(mocks.get).toHaveBeenCalledWith(mocks.note.id)
    expect(mocks.setContent).toHaveBeenCalledWith(mocks.note.id, { content: 'offline body', rev: 2, updatedAt: 3 })
    expect(mocks.updateSettings).toHaveBeenCalledWith({ notes: expect.objectContaining({ offlineNoteIds: [mocks.note.id] }) })
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
  })

  it('prefetches only missing bodies', async () => {
    mocks.contents[mocks.note.id] = 'cached'
    await prefetchOfflineNotes([mocks.note.id])
    expect(mocks.get).not.toHaveBeenCalled()
    mocks.contents = {}
    await prefetchOfflineNotes([mocks.note.id])
    expect(mocks.get).toHaveBeenCalledOnce()
  })
})
