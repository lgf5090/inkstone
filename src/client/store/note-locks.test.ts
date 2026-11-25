import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteLockSession, NoteUnlockError, openNote, sealNote } from '@shared/crypto'
import { ApiError } from '../lib/api'
import { decryptNotePermanently, installNoteLockLifecycle, lockNoteWithPassword, lockNow, resolveLockedNoteAttachment, saveUnlockedNoteEdit, unlockNote, updateUnlockedNoteDraft, useNoteLocks } from './note-locks'

const mocks = vi.hoisted(() => ({
  state: {
    notes: {} as Record<string, { id: string, title: string, rev: number, isEncrypted: boolean }>,
    contents: {} as Record<string, string>,
    openNote: vi.fn(),
    saveNoteEnvelope: vi.fn(),
    sealNoteRecord: vi.fn(),
    openNoteRecord: vi.fn(),
  },
  filesList: vi.fn(),
  filesReplace: vi.fn(),
  noteGet: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  toast: vi.fn(),
}))

vi.mock('./notes', () => ({ useNotes: { getState: () => mocks.state, subscribe: mocks.subscribe } }))
vi.mock('./session', () => ({ useSession: { getState: () => ({ settings: { notes: { lockTimeoutMinutes: 5 } } }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: mocks.toast }), subscribe: mocks.subscribe } }))
vi.mock('../lib/folders', () => ({ folderDescendantIds: () => new Set() }))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, api: { notes: { get: mocks.noteGet }, files: { list: mocks.filesList, replace: mocks.filesReplace } } }
})

const PASSWORD = 'correct horse battery staple'

async function sealedFixture() {
  const session = await NoteLockSession.create(PASSWORD, { iterations: 100_000 })
  const sealed = await sealNote(session, 'note-1', { title: 'Secret title', content: 'Secret body' })
  mocks.state.notes['note-1'] = { id: 'note-1', title: sealed.title, rev: 1, isEncrypted: true }
  mocks.state.contents['note-1'] = sealed.content
  mocks.state.saveNoteEnvelope.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
    mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: 2, isEncrypted: true }
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
  mocks.state.sealNoteRecord.mockReset()
  mocks.state.openNoteRecord.mockReset()
  mocks.filesList.mockReset().mockResolvedValue({ files: [], nextCursor: null })
  mocks.filesReplace.mockReset().mockResolvedValue({})
  mocks.noteGet.mockReset()
  useNoteLocks.setState({ unlocked: {}, drafts: {} })
})

afterEach(() => {
  lockNow('note-1')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('saves a pending draft before the inactivity timeout relocks it', async () => {
    await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    updateUnlockedNoteDraft('note-1', { title: 'Saved at timeout', content: 'Body' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.useRealTimers()
    await vi.waitFor(() => expect(mocks.state.saveNoteEnvelope).toHaveBeenCalledTimes(1))
    expect(useNoteLocks.getState().unlocked['note-1']).toBeUndefined()
    expect(useNoteLocks.getState().drafts['note-1']).toBeUndefined()
  })

  it('warns and postpones auto-lock when a pending draft cannot be saved', async () => {
    await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    updateUnlockedNoteDraft('note-1', { content: 'Still mine' })
    mocks.state.saveNoteEnvelope.mockRejectedValue(new ApiError(409, 'conflict', 'changed'))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.useRealTimers()
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' })))
    expect(useNoteLocks.getState().drafts['note-1']?.content).toBe('Still mine')
  })

  it('fails closed instead of resealing over a remotely replaced envelope', async () => {
    const { session } = await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    const remote = await sealNote(session, 'note-1', { title: 'Remote', content: 'Changed' })
    mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: remote.title }
    mocks.state.contents['note-1'] = remote.content
    await expect(saveUnlockedNoteEdit('note-1', { title: 'Mine', content: 'Draft' })).rejects.toBeInstanceOf(NoteUnlockError)
    expect(mocks.state.saveNoteEnvelope).not.toHaveBeenCalled()
    expect(useNoteLocks.getState().unlocked['note-1']).toBeUndefined()
  })

  it('drops the session when a remote seal event replaces the envelope', async () => {
    const { session } = await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    const remote = await sealNote(session, 'note-1', { title: 'Remote', content: 'Changed' })
    mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: remote.title }
    mocks.state.contents['note-1'] = remote.content
    const cleanup = installNoteLockLifecycle()
    window.dispatchEvent(new CustomEvent('inkstone:note-sealed', { detail: 'note-1' }))
    expect(useNoteLocks.getState().unlocked['note-1']).toBeUndefined()
    cleanup()
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

describe('note attachment migration', () => {
  function plaintextFixture() {
    mocks.state.notes['note-1'] = { id: 'note-1', title: 'Plain title', rev: 1, isEncrypted: false }
    mocks.state.contents['note-1'] = 'Plain body'
    mocks.state.sealNoteRecord.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
      mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: 2, isEncrypted: true }
      mocks.state.contents['note-1'] = next.content
      return { ...mocks.state.notes['note-1']!, content: next.content }
    })
    mocks.state.openNoteRecord.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
      mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: mocks.state.notes['note-1']!.rev + 1, isEncrypted: false }
      mocks.state.contents['note-1'] = next.content
      return { ...mocks.state.notes['note-1']!, content: next.content }
    })
  }

  it('refuses to reseal a plaintext note that still has ciphertext attachments', async () => {
    plaintextFixture()
    mocks.filesList.mockResolvedValue({ files: [{ id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'note-lock-v1', sha256: 'original-hash' }], nextCursor: null })
    await expect(lockNoteWithPassword('note-1', PASSWORD)).rejects.toThrow()
    expect(mocks.state.sealNoteRecord).not.toHaveBeenCalled()
    expect(mocks.state.notes['note-1']?.isEncrypted).toBe(false)
  })

  it('encrypts existing plaintext attachments under the new note key', async () => {
    plaintextFixture()
    mocks.filesList.mockResolvedValue({ files: [{ id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'none', sha256: 'original-hash' }], nextCursor: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))))
    await lockNoteWithPassword('note-1', PASSWORD)
    const [, uploaded, options] = mocks.filesReplace.mock.calls[0]!
    expect(options).toMatchObject({ encryption: 'note-lock-v1', plaintextSize: 3, expectedSha256: 'original-hash' })
    const session = await NoteLockSession.fromEnvelope(PASSWORD, mocks.state.notes['note-1']!.title)
    expect([...await session.openNoteAttachment('note-1', 'attachment-1', new Uint8Array(await (uploaded as File).arrayBuffer()))]).toEqual([1, 2, 3])
  })

  it('restores the note when the first attachment replacement fails', async () => {
    plaintextFixture()
    mocks.filesList.mockResolvedValue({ files: [{ id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'none', sha256: 'original-hash' }], nextCursor: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    mocks.filesReplace.mockRejectedValue(new Error('offline'))
    mocks.noteGet.mockResolvedValue({ ...mocks.state.notes['note-1']!, rev: 2, isEncrypted: true })
    await expect(lockNoteWithPassword('note-1', PASSWORD)).rejects.toThrow()
    expect(mocks.state.openNoteRecord).toHaveBeenCalledWith('note-1', { title: 'Plain title', content: 'Plain body' }, 2)
    expect(mocks.state.notes['note-1']?.isEncrypted).toBe(false)
  })

  it('restores the note and already migrated attachments when a later replacement fails', async () => {
    plaintextFixture()
    mocks.filesList.mockResolvedValue({ files: [
      { id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'none' },
      { id: 'attachment-2', noteId: 'note-1', filename: 'b.bin', mime: 'application/octet-stream', encryption: 'none' },
    ], nextCursor: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    mocks.filesReplace.mockResolvedValueOnce({ sha256: 'encrypted-hash' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
    mocks.noteGet.mockResolvedValue({ ...mocks.state.notes['note-1']!, rev: 2, isEncrypted: true })
    await expect(lockNoteWithPassword('note-1', PASSWORD)).rejects.toThrow()
    expect(mocks.state.openNoteRecord).toHaveBeenCalledWith('note-1', { title: 'Plain title', content: 'Plain body' }, 2)
    expect(mocks.filesReplace.mock.calls[2]?.[2]).toEqual({ encryption: 'none', expectedSha256: 'encrypted-hash' })
    expect(mocks.state.notes['note-1']?.isEncrypted).toBe(false)
  })

  it('restores the sealed note and already decrypted attachments when opening fails', async () => {
    const { session, sealed: noteSealed } = await sealedFixture()
    const first = await session.sealNoteAttachment('note-1', 'attachment-1', new Uint8Array([1]))
    const second = await session.sealNoteAttachment('note-1', 'attachment-2', new Uint8Array([2]))
    mocks.filesList.mockResolvedValue({ files: [
      { id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'note-lock-v1' },
      { id: 'attachment-2', noteId: 'note-1', filename: 'b.bin', mime: 'application/octet-stream', encryption: 'note-lock-v1' },
    ], nextCursor: null })
    const responses = [first, second]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(responses.shift()!).buffer as ArrayBuffer, {
      headers: { 'X-Inkstone-Attachment-Encryption': 'note-lock-v1' },
    })))
    mocks.state.openNoteRecord.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
      mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: 2, isEncrypted: false }
      mocks.state.contents['note-1'] = next.content
      return { ...mocks.state.notes['note-1']!, content: next.content }
    })
    mocks.filesReplace.mockResolvedValueOnce({ sha256: 'plain-hash' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
    mocks.noteGet.mockResolvedValue({ ...mocks.state.notes['note-1']!, rev: 2, isEncrypted: false })
    await expect(decryptNotePermanently('note-1', PASSWORD)).rejects.toThrow()
    expect(mocks.state.saveNoteEnvelope).toHaveBeenCalledWith('note-1', { title: noteSealed.title, content: noteSealed.content }, 2)
    expect(mocks.filesReplace.mock.calls[2]?.[2]).toMatchObject({ encryption: 'note-lock-v1', expectedSha256: 'plain-hash' })
    expect(mocks.state.notes['note-1']?.isEncrypted).toBe(true)
  })

  it('decrypts existing attachments when the note lock is removed permanently', async () => {
    const { session } = await sealedFixture()
    const sealed = await session.sealNoteAttachment('note-1', 'attachment-1', new Uint8Array([4, 5, 6]))
    mocks.filesList.mockResolvedValue({ files: [{ id: 'attachment-1', noteId: 'note-1', filename: 'a.bin', mime: 'application/octet-stream', encryption: 'note-lock-v1', sha256: 'original-hash' }], nextCursor: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(sealed).buffer as ArrayBuffer, {
      headers: { 'X-Inkstone-Attachment-Encryption': 'note-lock-v1' },
    })))
    mocks.state.openNoteRecord.mockImplementation(async (_id: string, next: { title: string, content: string }) => {
      mocks.state.notes['note-1'] = { ...mocks.state.notes['note-1']!, title: next.title, rev: 2, isEncrypted: false }
      mocks.state.contents['note-1'] = next.content
      return { ...mocks.state.notes['note-1']!, content: next.content }
    })
    await decryptNotePermanently('note-1', PASSWORD)
    const [, uploaded, options] = mocks.filesReplace.mock.calls[0]!
    expect(options).toMatchObject({ encryption: 'none', expectedSha256: 'original-hash' })
    expect([...new Uint8Array(await (uploaded as File).arrayBuffer())]).toEqual([4, 5, 6])
    expect(mocks.state.notes['note-1']?.isEncrypted).toBe(false)
  })
})

describe('encrypted attachment URLs', () => {
  it('decrypts once, reuses the session URL, and revokes it on relock', async () => {
    const { session } = await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    const plaintext = new Uint8Array([1, 2, 3, 255])
    const sealed = await session.sealNoteAttachment('note-1', 'attachment-1', plaintext)
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(sealed).buffer as ArrayBuffer, {
      headers: {
        'X-Inkstone-Attachment-Encryption': 'note-lock-v1',
        'X-Inkstone-Attachment-Type': 'image/png',
        'X-Inkstone-Attachment-Filename': 'photo.png',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decrypted')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const first = await resolveLockedNoteAttachment('note-1', 'attachment-1')
    expect(first).toEqual({ url: 'blob:decrypted', filename: 'photo.png', mime: 'image/png' })
    expect(await resolveLockedNoteAttachment('note-1', 'attachment-1')).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toBeInstanceOf(Blob)
    lockNow('note-1')
    expect(revoke).toHaveBeenCalledWith('blob:decrypted')
  })

  it('does not publish a URL when the note is relocked during the fetch', async () => {
    const { session } = await sealedFixture()
    await unlockNote('note-1', PASSWORD)
    const sealed = await session.sealNoteAttachment('note-1', 'attachment-1', new Uint8Array([7]))
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const create = vi.spyOn(URL, 'createObjectURL')
    const pending = resolveLockedNoteAttachment('note-1', 'attachment-1')
    lockNow('note-1')
    finish(new Response(new Uint8Array(sealed).buffer as ArrayBuffer, {
      headers: { 'X-Inkstone-Attachment-Encryption': 'note-lock-v1' },
    }))
    await expect(pending).rejects.toBeInstanceOf(NoteUnlockError)
    expect(create).not.toHaveBeenCalled()
  })
})
