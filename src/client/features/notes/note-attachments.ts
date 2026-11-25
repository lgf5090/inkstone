import { api } from '../../lib/api'
import { randomLocalId } from '../../lib/random-id'
import { sealLockedNoteAttachment } from '../../store/note-locks'

export async function uploadNoteAttachment(file: File, noteId: string, encrypted: boolean) {
  if (!encrypted) return api.files.upload(file, noteId)
  const attachmentId = randomLocalId().slice(0, 26)
  const plaintext = new Uint8Array(await file.arrayBuffer())
  const sealed = await sealLockedNoteAttachment(noteId, attachmentId, plaintext)
  const encryptedFile = new File([new Uint8Array(sealed)], file.name, { type: file.type || 'application/octet-stream' })
  return api.files.upload(encryptedFile, noteId, {
    encryption: 'note-lock-v1',
    attachmentId,
    plaintextSize: plaintext.byteLength,
  })
}
