/**
 * What an attached file means to the model.
 *
 * A reader who attaches a document expects the assistant to have read it, so a text file's bytes go
 * into the user's own turn — which is also what keeps them available on the next turn and in the rolling
 * summary. A side channel the model could only reach once would lose the file as soon as the
 * conversation moved on.
 *
 * A picture is a different shape of thing: it travels as an image part of the same turn, and only when
 * the model is marked able to see. The line the reader sees in the transcript says which of the two
 * happened, so nothing ever claims to have shown the model an image it did not receive.
 */
import type { AssistantModelModality } from '@shared/assistant'
import {
  CHAT_FILE_CHAR_CAP,
  CHAT_TEXT_INLINE_BYTES,
  CHAT_TOTAL_CHAR_CAP,
  base64FromBytes,
  fenceForAttachment,
  isTextualAttachment,
  readChatObject,
} from './chat-files'
import type { Env } from '../env'
import type { AssistantStore } from './store'

/**
 * The token each attachment line starts with.
 *
 * It is English on purpose: this block is model-facing prompt text, never the reader's UI, and the
 * reader's own labels come from the locale catalog the composer draws.
 */
export const ATTACHMENT_MARKER = '[attachment'

/** A picture is sent inline up to this size; past it the base64 body costs more than it answers. */
export const IMAGE_SEND_MAX_BYTES = 4 * 1024 * 1024

export interface AttachmentPayload {
  /** The block appended to the reader's own text for the model. */
  block: string
  images: { mime: string, dataUrl: string }[]
}

/**
 * Reads the reader's own attachments by id. An id that is not theirs, or whose bytes are gone, is named
 * in the block rather than silently dropped, so the transcript never claims a file arrived that did not.
 */
/** Which sense a file needs, if any: a clip and a recording are not the same ask of a model. */
export function modalityOf(mime: string, filename: string): AssistantModelModality | null {
  const lower = `${mime} ${filename}`.toLocaleLowerCase()
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac)$/.test(lower)) return 'audio'
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/.test(lower)) return 'video'
  return null
}

export async function expandChatAttachments(
  store: AssistantStore,
  env: Env,
  ids: readonly string[],
  vision: boolean,
  modalities: readonly AssistantModelModality[] = [],
): Promise<AttachmentPayload> {
  if (!ids.length) return { block: '', images: [] }
  const rows = await store.chatAttachments(ids)
  const found = new Map(rows.map((row) => [row.id, row]))
  const images: { mime: string, dataUrl: string }[] = []
  const lines: string[] = []
  let used = 0
  for (const id of ids) {
    const row = found.get(id)
    if (!row) {
      lines.push(`${ATTACHMENT_MARKER}: a file that is no longer here]`)
      continue
    }
    const header = `${ATTACHMENT_MARKER}: ${row.filename}, ${row.mime || 'unknown type'}, ${Math.round(row.size / 1024)} KB]`
    if (row.kind === 'image') {
      if (!vision) {
        lines.push(`${header} (the reader can see this picture; this model is not marked as able to)`)
        continue
      }
      const bytes = await readChatObject(env, row.key)
      if (!bytes) {
        lines.push(`${header} (the stored image could not be read)`)
      } else if (bytes.byteLength > IMAGE_SEND_MAX_BYTES) {
        lines.push(`${header} (larger than ${Math.round(IMAGE_SEND_MAX_BYTES / 1024 / 1024)} MB; not sent)`)
      } else {
        images.push({
          mime: row.mime || 'image/png',
          dataUrl: `data:${row.mime || 'image/png'};base64,${base64FromBytes(bytes)}`,
        })
        lines.push(`${header} (sent to the model with this turn)`)
      }
      continue
    }
    if (!isTextualAttachment(row.mime, row.filename)) {
      // A recording or a clip is named the way a picture is when the model cannot be shown one, so the
      // transcript never reads as if the model had been given something it was not.
      const modality = modalityOf(row.mime, row.filename)
      if (modality && !modalities.includes(modality)) {
        lines.push(`${header} (the reader can play this; this model is not marked as able to take ${modality})`)
        continue
      }
      lines.push(`${header} (not text; contents not read)`)
      continue
    }
    const bytes = await readChatObject(env, row.key)
    if (!bytes) {
      lines.push(`${header} (contents could not be read)`)
      continue
    }
    if (bytes.byteLength > CHAT_TEXT_INLINE_BYTES) {
      lines.push(`${header} (larger than ${Math.round(CHAT_TEXT_INLINE_BYTES / 1024)} KB; contents not read)`)
      continue
    }
    const text = new TextDecoder().decode(bytes)
    const room = Math.max(0, Math.min(CHAT_FILE_CHAR_CAP, CHAT_TOTAL_CHAR_CAP - used))
    if (!room) {
      lines.push(`${header} (this turn's attachment budget is full; contents not read)`)
      continue
    }
    const taken = text.slice(0, room)
    used += taken.length
    const note = text.length > taken.length ? ` (first ${room} characters)` : ''
    lines.push(`${header}${note}\n\`\`\`${fenceForAttachment(row.filename)}\n${taken}\n\`\`\``)
  }
  return { block: lines.join('\n\n'), images }
}
