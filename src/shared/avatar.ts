export const GENERATED_AVATAR_PREFIX = 'dicebear:'
export const GENERATED_AVATAR_SEED_LENGTH = 32
export const EMOJI_AVATAR_PREFIX = 'emoji:'
export const ICON_AVATAR_PREFIX = 'lucide:'
export const PROFILE_NAME_MAX_LENGTH = 64
export const AVATAR_SOURCE_FILE_MAX_BYTES = 8 * 1024 * 1024
export const AVATAR_STORED_MAX_BYTES = 128 * 1024
export const AVATAR_PROFILE_BODY_MAX_BYTES = 256 * 1024
const GENERATED_SEED_PATTERN = /^[a-zA-Z0-9_-]{16,64}$/

export const AVATAR_EMOJI_CHOICES = [
  '😀', '😎', '🤓', '🥳', '😺', '🐶', '🐼', '🦊',
  '🐸', '🐧', '🦉', '🐝', '🌻', '🌙', '⭐', '🔥',
  '🌈', '🍀', '☕', '🎧', '📚', '🚀', '💡', '🎨',
] as const

export const AVATAR_ICON_CHOICES = [
  'cat', 'dog', 'bird', 'fish', 'leaf', 'sun', 'moon', 'star',
  'coffee', 'music', 'book', 'code', 'plane', 'rocket', 'camera',
  'gamepad', 'heart', 'flower', 'mountain', 'waves', 'cloud',
  'zap', 'bot', 'ghost',
] as const

export type AvatarEmoji = typeof AVATAR_EMOJI_CHOICES[number]
export type AvatarIconName = typeof AVATAR_ICON_CHOICES[number]

export function generatedAvatarPreference(seed: string): string {
  return `${GENERATED_AVATAR_PREFIX}${seed}`
}

export function avatarEmojiPreference(emoji: AvatarEmoji): string {
  return `${EMOJI_AVATAR_PREFIX}${emoji}`
}

export function avatarIconPreference(name: AvatarIconName): string {
  return `${ICON_AVATAR_PREFIX}${name}`
}

export function parseAvatarEmojiPreference(value: string | null | undefined): AvatarEmoji | null {
  if (!value?.startsWith(EMOJI_AVATAR_PREFIX)) return null
  const emoji = value.slice(EMOJI_AVATAR_PREFIX.length)
  return (AVATAR_EMOJI_CHOICES as readonly string[]).includes(emoji) ? emoji as AvatarEmoji : null
}

export function parseAvatarIconPreference(value: string | null | undefined): AvatarIconName | null {
  if (!value?.startsWith(ICON_AVATAR_PREFIX)) return null
  const name = value.slice(ICON_AVATAR_PREFIX.length)
  return (AVATAR_ICON_CHOICES as readonly string[]).includes(name) ? name as AvatarIconName : null
}

export function generatedAvatarSeed(value: string | null | undefined): string | null {
  if (!value?.startsWith(GENERATED_AVATAR_PREFIX)) return null
  const seed = value.slice(GENERATED_AVATAR_PREFIX.length)
  return GENERATED_SEED_PATTERN.test(seed) ? seed : null
}

export function isBitmapAvatarDataUrl(value: string | null | undefined): boolean {
  return /^data:image\/(?:png|jpeg|webp);base64,/i.test(value ?? '')
}

export interface StoredAvatarLocation {
  storage: 'r2' | 'kv'
  userId: string
  objectId: string
  extension: 'png' | 'jpg' | 'webp'
  key: string
}

export function parseStoredAvatarUrl(value: string | null | undefined): StoredAvatarLocation | null {
  const match = /^\/api\/avatars\/(r2|kv)\/([0-9a-hjkmnp-tv-z]{26})\/([0-9a-hjkmnp-tv-z]{26})\.(png|jpg|webp)$/.exec(
    value ?? '',
  )
  if (!match) return null
  const storage = match[1] as 'r2' | 'kv'
  const userId = match[2]!
  const objectId = match[3]!
  const extension = match[4] as 'png' | 'jpg' | 'webp'
  return {
    storage,
    userId,
    objectId,
    extension,
    key: `avatars/${userId}/${objectId}.${extension}`,
  }
}
