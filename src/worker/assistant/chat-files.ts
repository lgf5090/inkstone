/**
 * Chat attachments: the reader's own files, under the chat's own prefix.
 *
 * The notebook has an attachment table and a storage backend of its own, and a chat attachment is
 * deliberately *not* one of those: a picture pasted into a question is not a file the reader keeps, it
 * is fuel for one turn. The prefix is therefore `chat/images/<user>/<id>.<ext>` and
 * `chat/files/<user>/<id>.<ext>`, which is what makes a chat upload findable — and deletable — without
 * touching anything the notebook can see.
 *
 * Two ceilings do the rest of the work. An image is capped at what a vision model can be sent in one
 * request body, a document at what fits the reader's context budget; anything above either is refused
 * with its own number in the message rather than truncated in silence.
 */
import { extensionFor } from '../lib/image'
import { newId } from '../lib/id'
import type { ChatAttachment } from '@shared/assistant'
import type { Env } from '../env'
import type { AssistantStore } from './store'

export const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const CHAT_FILE_MAX_BYTES = 4 * 1024 * 1024
/** How much of a text file the assistant is shown. The reader still sees the whole file in the viewer. */
export const CHAT_TEXT_INLINE_BYTES = 512 * 1024
/** Per-file and per-message character ceilings, so one upload cannot evict the conversation. */
export const CHAT_FILE_CHAR_CAP = 24_000
export const CHAT_TOTAL_CHAR_CAP = 64_000

export type ChatAttachmentKind = 'image' | 'file'

export function chatAttachmentKind(mime: string, filename: string): ChatAttachmentKind {
  return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i.test(filename) ? 'image' : 'file'
}

export function chatSizeLimit(kind: ChatAttachmentKind): number {
  return kind === 'image' ? CHAT_IMAGE_MAX_BYTES : CHAT_FILE_MAX_BYTES
}

/** `chat/images/<user>/<id>.png` — the id is the object's only identity, so a name can never collide. */
export function chatObjectKey(kind: ChatAttachmentKind, userId: string, id: string, mime: string, filename: string): string {
  return `chat/${kind === 'image' ? 'images' : 'files'}/${userId}/${id}.${extensionFor(mime, filename)}`
}

const TEXTUAL_MIME = /^text\/|\/(json|xml|yaml|x-yaml|toml|csv|x-csv|javascript|typescript|x-sh|markdown)$|\+(json|xml)$/i
const TEXTUAL_NAME = /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|h|cpp|hpp|sh|sql|css|html?|xml|ini|conf|log|env|gitignore|srt|vtt)$/i

/** Whether the bytes are worth decoding into the prompt, as opposed to just naming in it. */
export function isTextualAttachment(mime: string, filename: string): boolean {
  return TEXTUAL_MIME.test(mime) || TEXTUAL_NAME.test(filename)
}

/** A fenced block's language tag, taken from the extension the reader used. */
export function fenceForAttachment(filename: string): string {
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : ''
}

/** Base64 without building one enormous string: workerd's `btoa` still needs a binary string per chunk. */
export function base64FromBytes(bytes: Uint8Array): string {
  const chunk = 8192
  let output = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(output)
}

/**
 * The two object bindings, behind one pair of calls.
 *
 * A deployment may run its files on R2 or on the KV namespace, and the notebook already supports both;
 * a chat upload that only worked on one would strand the reader who chose the other.
 */
export async function putChatObject(env: Env, key: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (env.FILES) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime || 'application/octet-stream' } })
    return
  }
  if (env.FILES_KV) {
    await env.FILES_KV.put(key, bytes, { metadata: { mime } })
    return
  }
  throw new Error('This deployment has no file storage configured.')
}

export async function readChatObject(env: Env, key: string): Promise<Uint8Array | null> {
  if (env.FILES) {
    const object = await env.FILES.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }
  if (env.FILES_KV) {
    const value = await env.FILES_KV.get(key, 'arrayBuffer')
    return value ? new Uint8Array(value) : null
  }
  return null
}

export async function deleteChatObject(env: Env, key: string): Promise<void> {
  if (env.FILES) {
    await env.FILES.delete(key)
    return
  }
  await env.FILES_KV?.delete(key)
}

/**
 * Stores one upload and records its row.
 *
 * The ceiling is checked before the object is written, not after: a half-saved 30 MB file that the
 * reader cannot use is storage they pay for.
 */
export async function saveChatUpload(
  store: AssistantStore,
  env: Env,
  input: { bytes: Uint8Array, mime: string, filename: string },
): Promise<ChatAttachment> {
  const filename = (input.filename.trim() || 'file').replace(/[/\\]/g, '_').slice(0, 160)
  const mime = input.mime.slice(0, 120)
  const kind = chatAttachmentKind(mime, filename)
  const limit = chatSizeLimit(kind)
  if (!input.bytes.length) throw new ChatUploadError('empty', 'That file is empty.')
  if (input.bytes.length > limit) {
    throw new ChatUploadError('too-large', `${filename} is ${formatBytes(input.bytes.length)}; the limit for a ${kind} is ${formatBytes(limit)}.`)
  }
  const id = newId()
  const key = chatObjectKey(kind, store.userId, id, mime, filename)
  await putChatObject(env, key, input.bytes, mime)
  try {
    return await store.createChatAttachment({ id, kind, filename, mime, size: input.bytes.length, key })
  } catch (error) {
    // A row that did not land leaves an object nothing can name: take it back rather than leak it.
    await deleteChatObject(env, key).catch(() => undefined)
    throw error
  }
}

export class ChatUploadError extends Error {
  constructor(readonly kind: 'empty' | 'too-large', message: string) {
    super(message)
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
