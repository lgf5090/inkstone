import {
  AVATAR_STORED_MAX_BYTES,
  generatedAvatarSeed,
  parseAvatarEmojiPreference,
  parseAvatarIconPreference,
  parseStoredAvatarUrl,
} from '@shared/avatar'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  deleteAttachmentObjects,
  putAttachmentObject,
  selectAttachmentStorage,
} from '../attachments/backend'
import { attachmentCleanupTarget, type AttachmentObjectStorage } from '../attachments/keys'

interface DecodedAvatar {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  extension: 'png' | 'jpg' | 'webp'
}

export interface StoredAvatarObject {
  preference: string
  storage: AttachmentObjectStorage
  key: string
  userId: string
}

export function normalizeAvatarPreference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '') return ''
  if (generatedAvatarSeed(value)) return value
  if (parseAvatarEmojiPreference(value) || parseAvatarIconPreference(value)) return value
  return decodeAvatarDataUrl(value) ? value : null
}

export async function persistUploadedAvatar(
  env: Env,
  userId: string,
  dataUrl: string,
): Promise<StoredAvatarObject> {
  const decoded = decodeAvatarDataUrl(dataUrl)
  if (!decoded) throw new ApiError(400, 'invalid_avatar', 'Upload a supported avatar image')
  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Avatar storage is not configured. Bind R2 or Workers KV before uploading an image.',
    )
  }

  const objectId = newId()
  const key = `avatars/${userId}/${objectId}.${decoded.extension}`
  const sha256 = await sha256Hex(decoded.bytes)
  await putAttachmentObject(env, storage, key, decoded.bytes, {
    userId,
    objectId,
    kind: 'avatar',
    filename: `avatar.${decoded.extension}`,
    mime: decoded.mime,
    sha256,
  })
  return {
    preference: `/api/avatars/${storage}/${userId}/${objectId}.${decoded.extension}`,
    storage,
    key,
    userId,
  }
}

export async function discardStoredAvatar(env: Env, avatar: StoredAvatarObject): Promise<void> {
  try {
    await deleteAttachmentObjects(env, avatar.storage, [avatar.key])
  } catch (error) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
       VALUES (?1, ?2, ?3)`,
    )
      .bind(attachmentCleanupTarget(avatar.storage, avatar.key), avatar.userId, Date.now())
      .run()
      .catch(() => {})
    console.warn('[inkstone] Avatar cleanup will retry later:', error)
  }
}

export function storedAvatarCleanup(value: string): {
  storage: AttachmentObjectStorage
  key: string
} | null {
  const location = parseStoredAvatarUrl(value)
  return location ? { storage: location.storage, key: location.key } : null
}

function decodeAvatarDataUrl(value: string): DecodedAvatar | null {
  if (value.length > Math.ceil(AVATAR_STORED_MAX_BYTES / 3) * 4 + 64) return null
  const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2]!.length % 4 !== 0) return null

  let binary: string
  try {
    binary = atob(match[2]!)
  } catch {
    return null
  }
  if (!binary.length || binary.length > AVATAR_STORED_MAX_BYTES) return null

  const code = (index: number) => binary.charCodeAt(index)
  const subtype = match[1] as 'png' | 'jpeg' | 'webp'
  const valid = subtype === 'png'
    ? binary.length >= 8 &&
      code(0) === 0x89 && code(1) === 0x50 && code(2) === 0x4e && code(3) === 0x47 &&
      code(4) === 0x0d && code(5) === 0x0a && code(6) === 0x1a && code(7) === 0x0a
    : subtype === 'jpeg'
      ? binary.length >= 3 && code(0) === 0xff && code(1) === 0xd8 && code(2) === 0xff
      : binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP'
  if (!valid) return null

  return {
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    mime: `image/${subtype}`,
    extension: subtype === 'jpeg' ? 'jpg' : subtype,
  }
}
