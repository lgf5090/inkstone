import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { sealLockedNoteAttachment } from '../../store/note-locks'
import { uploadNoteAttachment } from './note-attachments'

vi.mock('../../lib/api', () => ({ api: { files: { upload: vi.fn() } } }))
vi.mock('../../store/note-locks', () => ({ sealLockedNoteAttachment: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('note attachment uploads', () => {
  it('keeps ordinary note uploads on the existing path', async () => {
    const file = new File(['plain'], 'a.txt', { type: 'text/plain' })
    await uploadNoteAttachment(file, 'note-1', false)
    expect(api.files.upload).toHaveBeenCalledWith(file, 'note-1')
    expect(sealLockedNoteAttachment).not.toHaveBeenCalled()
  })

  it('seals bytes under the retained note session before uploading ciphertext', async () => {
    vi.mocked(sealLockedNoteAttachment).mockResolvedValue(new Uint8Array([73, 75, 65, 49]))
    vi.mocked(api.files.upload).mockResolvedValue({ id: 'attachment' } as never)
    const file = new File([new Uint8Array([1, 2, 3])], 'a.bin', { type: 'application/octet-stream' })
    await uploadNoteAttachment(file, 'note-1', true)
    const [noteId, attachmentId, plaintext] = vi.mocked(sealLockedNoteAttachment).mock.calls[0]!
    expect(noteId).toBe('note-1')
    expect(attachmentId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect([...plaintext]).toEqual([1, 2, 3])
    const [uploaded, uploadedNote, options] = vi.mocked(api.files.upload).mock.calls[0]!
    expect(uploaded.name).toBe('a.bin')
    expect(uploaded.type).toBe('application/octet-stream')
    expect(uploadedNote).toBe('note-1')
    expect(options).toEqual({ encryption: 'note-lock-v1', attachmentId, plaintextSize: 3 })
  })
})
