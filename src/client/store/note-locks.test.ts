import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteLockSession, NoteUnlockError, openNote, sealNote } from '@shared/crypto'
import { ApiError } from '../lib/api'
import { lockNow, saveUnlockedNoteEdit, unlockNote, updateUnlockedNoteDraft, useNoteLocks } from './note-locks'

const mocks = vi.hoisted(() => ({
  state: {
    notes: {} as Record<string, { id: string, title: string, rev: number, isEncrypted: boolean }>,
    contents: {} as Record<string, string>,
    openNote: vi.fn(),
    saveNoteEnvelope: vi.fn(),
  },
  subscribe: vi.fn(() => () => {}),
  toast: vi.fn(),
}))

vi.mock('./notes', () => ({ useNotes: { getState: () => mocks.state, subscribe: mocks.subscribe } }))
vi.mock('./session', () => ({ useSession: { getState: () => ({ settings: { notes: { lockTimeoutMinutes: 5 } } }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: mocks.toast }), subscribe: mocks.subscribe } }))
vi.mock('../lib/folders', () => ({ folderDescendantIds: () => new Set() }))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, api: { notes: { get: vi.fn() } } }
})

const PASSWORD = 'correct horse battery staple'

async function sealedFixture() {
  const session = await NoteLockSession.create(PASSWORD, { iterations: 100_000 })
  const sealed = await sealNote(session, 'note-1', { title: 'Secret title', content: 'Secret body' })
  mocks.state.notes['note-1'] = { id: 'note-1', title: sealed.title, rev: 1, isEncrypted: true }
  mocks.state.contents['note-1'] = sealed.content
  mocks.state.saveNoteEnvelope.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
    mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: 2 }
    mocks.state.contents['note-1'] = next.content
    return { ...mocks.state.notes['note-1']!, content: next.content }
  })
  return { session, sealed }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.state.notes = {}
  mocks.state.contents = {}
  mocks.state.openNote.mockReset()
  mocks.state.saveNoteEnvelope.mockReset()
  useNoteLocks.setState({ unlocked: {}, drafts: {} })
})

afterEach(() => {
  lockNow('note-1')
  vi.useRealTimers()
})

describe('encrypted note editing', () => {
  it('keeps plaintext only in the session draft and saves a fresh bound envelope', async () => {
    const { session, sealed } = await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    updateUnlockedNoteDraft('note-1', { title: 'Edited title', content: 'Edited body' })
    expect(mocks.state.contents['note-1']).toBe(sealed.content)
    expect(await saveUnlockedNoteEdit('note-1', { title: 'Edited title', content: 'Edited body' })).toBe('saved')
    const saved = mocks.state.saveNoteEnvelope.mock.calls[0]!
    expect(saved[0]).toBe('note-1')
    expect(saved[1].title).toMatch(/^memoenc:v2:/)
    expect(await openNote(session, 'note-1', saved[1])).toEqual({ title: 'Edited title', content: 'Edited body' })
    expect(useNoteLocks.getState().drafts['note-1']).toBeUndefined()
    expect(mocks.state.contents['note-1']).not.toContain('Edited body')
  })

  it('preserves the draft when the server reports a revision conflict', async () => {
    await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    updateUnlockedNoteDraft('note-1', { title: 'Draft', content: 'Keep me' })
    mocks.state.saveNoteEnvelope.mockRejectedValue(new ApiError(409, 'conflict', 'changed'))
    expect(await saveUnlockedNoteEdit('note-1', { title: 'Draft', content: 'Keep me' })).toBe('conflict')
    expect(useNoteLocks.getState().drafts['note-1']).toEqual({ title: 'Draft', content: 'Keep me' })
  })

  it('rejects a wrong password and clears all plaintext on relock', async () => {
    await sealedFixture()
    await expect(unlockNote('note-1', 'wrong password')).rejects.toBeInstanceOf(NoteUnlockError)
    await unlockNote('note-1', PASSWORD)
    updateUnlockedNoteDraft('note-1', { content: 'Draft body' })
    lockNow('note-1')
    expect(useNoteLocks.getState().unlocked['note-1']).toBeUndefined()
    expect(useNoteLocks.getState().drafts['note-1']).toBeUndefined()
  })
})
