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

/** The shortest fence an attachment's text is wrapped in; a body with a longer run pushes it up. */
const FENCE_MIN_TICKS = 3

/**
 * The two fence lines around one attachment's text.
 *
 * The tag is drawn here rather than read off the filename: a marker the reader can spell into a name is a
 * marker they can put a closing line with, and attachment text that has escaped its block is attachment
 * text standing where the instructions stand. The run of backticks is then one longer than the longest run
 * the wrapped body carries, so no line of that body ends the block either, and a body that happened to
 * contain this draw gets another.
 */
function attachmentFence(body: string): { open: string, close: string } {
  let tag = crypto.randomUUID()
  while (body.includes(tag)) tag = crypto.randomUUID()
  const ticks = '`'.repeat(Math.max(FENCE_MIN_TICKS, longestRun(body, '`') + 1))
  return { open: `${ticks}${tag}`, close: ticks }
}

/** The longest unbroken run of `char` in `text`, which is the length a fence has to exceed. */
function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const symbol of text) {
    run = symbol === char ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/**
 * Reader-supplied text as it may be written in front of the model: one line, and carrying no fence of its
 * own.
 *
 * A file's name and its type are the reader's text, while this line is model-facing prose, so a newline and
 * three backticks in either would otherwise open or close a block this function did not write.
 */
function modelFacingLabel(text: string): string {
  return text.replace(/[`\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

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
  /**
   * Whether a picture's bytes travel with this call.
   *
   * False for a turn far enough back that re-sending its images would cost more than the answer: the
   * file is still named, so the model knows the reader attached one, and the transcript never claims a
   * picture was shown that was not.
   */
  includeImages = true,
): Promise<AttachmentPayload> {
  if (!ids.length) return { block: '', images: [] }
  const rows = await store.chatAttachments(ids)
  const found = new Map(rows.map((row) => [row.id, row]))
  const extracted = await store.chatAttachmentTexts(ids)
  const images: { mime: string, dataUrl: string }[] = []
  const lines: string[] = []
  let used = 0
  // One place spends the per-turn budget, so a text file and a document the browser read are held to the
  // same ceiling and the same "first N characters" honesty.
  const pushText = (header: string, text: string, source: string): void => {
    const room = Math.max(0, Math.min(CHAT_FILE_CHAR_CAP, CHAT_TOTAL_CHAR_CAP - used))
    if (!room) {
      lines.push(`${header} (this turn's attachment budget is full; contents not read)`)
      return
    }
    const taken = text.slice(0, room)
    used += taken.length
    const note = text.length > taken.length ? ` (first ${room} characters)` : ''
    const fence = attachmentFence(taken)
    lines.push(`${header}${note}${source}\n${fence.open}\n${taken}\n${fence.close}`)
  }
  for (const id of ids) {
    const row = found.get(id)
    if (!row) {
      lines.push(`${ATTACHMENT_MARKER}: a file that is no longer here]`)
      continue
    }
    const header = `${ATTACHMENT_MARKER}: ${modelFacingLabel(row.filename)}, ${modelFacingLabel(row.mime || 'unknown type')}, ${Math.round(row.size / 1024)} KB]`
    if (row.kind === 'image') {
      if (!vision) {
        lines.push(`${header} (the reader can see this picture; this model is not marked as able to)`)
        continue
      }
      if (!includeImages) {
        // Older than the image window. Saying so is the honest line: the file was attached, and the
        // model is told it is there without being handed megabytes of base64 for a turn already read.
        lines.push(`${header} (an earlier picture; not re-sent with this turn)`)
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
      // A PDF's words were read by the browser's own parser at upload time, because the worker cannot
      // pull them out of the bytes; a file that had none is named and nothing more is claimed.
      const text = extracted.get(row.id)
      if (text) pushText(header, text, ' (text read from the file)')
      else lines.push(`${header} (not text; contents not read)`)
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
    pushText(header, new TextDecoder().decode(bytes), '')
  }
  return { block: lines.join('\n\n'), images }
}
