/** Ceilings and route-level constants for the music app, shared by both sides. */

export const MUSIC_LIMITS = {
  /** One uploaded file. Parts are 8 MiB, so no single request approaches the Worker body ceiling. */
  uploadMaxBytes: 300 * 1024 * 1024,
  uploadPartBytes: 8 * 1024 * 1024,
  /** A file this small is uploaded as one part: local R2 multipart has lost sessions across parts. */
  uploadSinglePartBytes: 64 * 1024 * 1024,
  coverMaxBytes: 5 * 1024 * 1024,
  /** Per-account R2 usage across every format and quality. */
  quotaBytes: 20 * 1024 * 1024 * 1024,
  historyEntries: 5_000,
  recentEntries: 500,
  lyricMaxBytes: 256 * 1024,
  settingsMaxBytes: 64 * 1024,
  pageSize: 30,
  libraryPageSize: 50,
  searchHistory: 50,
  playlistItems: 5_000,
  resolverResponseBytes: 1024 * 1024,
  resolverTimeoutMs: 10_000,
} as const

export const MUSIC_AUDIO_FORMATS = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'] as const
export type MusicAudioFormat = (typeof MUSIC_AUDIO_FORMATS)[number]
export const MUSIC_VIDEO_FORMATS = ['mp4'] as const
export const MUSIC_ALL_FORMATS = [...MUSIC_AUDIO_FORMATS, ...MUSIC_VIDEO_FORMATS] as const
export type MusicFormat = (typeof MUSIC_ALL_FORMATS)[number]

export const MUSIC_FORMAT_EXTENSIONS: Record<MusicFormat, readonly string[]> = {
  mp3: ['mp3'],
  flac: ['flac'],
  m4a: ['m4a'],
  aac: ['aac'],
  ogg: ['ogg', 'oga'],
  opus: ['opus'],
  wav: ['wav'],
  mp4: ['mp4', 'm4v'],
}

export const MUSIC_MIME_BY_FORMAT: Record<MusicFormat, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
}

export function isMusicFormat(value: string): value is MusicFormat {
  return (MUSIC_ALL_FORMATS as readonly string[]).includes(value)
}

export function formatFromFilename(filename: string): MusicFormat | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  for (const format of MUSIC_ALL_FORMATS) {
    if (MUSIC_FORMAT_EXTENSIONS[format].includes(extension)) return format
  }
  return null
}

/** `music/{format}/{user}/{track}-{quality}.{ext}`, the layout the deployment backs up by prefix. */
export function musicObjectKey(input: {
  format: MusicFormat
  userId: string
  trackId: string
  quality: string
  extension?: string
}): string {
  const extension = input.extension ?? (input.format === 'm4a' ? 'm4a' : input.format)
  return `music/${input.format}/${input.userId}/${input.trackId}-${input.quality}.${extension}`
}

export function musicCoverKey(input: { userId: string; trackId: string; extension: string }): string {
  const extension = input.extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
  return `music/covers/${input.userId}/${input.trackId}.${extension}`
}

export const MUSIC_APP_PATH = '/music'
