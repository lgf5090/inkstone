/** Presentation helpers shared by the library, the player bar and the export flow. */
import type { MusicQuality, MusicTrack } from './model'

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatPlayCount(count: number | null | undefined, locale?: string): string {
  if (!count || count < 0) return '0'
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count)
}

export function musicQualityLabelKey(quality: MusicQuality): string {
  return `music.quality.${quality}`
}

const QUALITY_ORDER: MusicQuality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
]

export function musicQualityRank(quality: MusicQuality): number {
  const index = QUALITY_ORDER.indexOf(quality)
  return index < 0 ? 0 : index + 1
}

export function isDownloadableQuality(value: string): value is Exclude<MusicQuality, 'original'> {
  return QUALITY_ORDER.includes(value as MusicQuality)
}

const ILLEGAL_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g

export function sanitizeMusicFilename(value: string, max = 180): string {
  const cleaned = value
    .replace(ILLEGAL_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return (cleaned || 'untitled').slice(0, max)
}

export function buildExportFilename(template: string, track: MusicTrack, extension: string): string {
  const artist = track.artists.map((entry) => entry.name).join(', ')
  const replaced = (template || '{title} - {artist}')
    .replaceAll('{title}', track.title)
    .replaceAll('{artist}', artist)
    .replaceAll('{album}', track.album)
    .replaceAll('{quality}', track.sourceQuality)
    .replaceAll('{ext}', extension)
  return `${sanitizeMusicFilename(replaced)}.${extension}`
}

export function musicArtistNames(track: Pick<MusicTrack, 'artists'>): string {
  return track.artists.map((entry) => entry.name).join(' / ')
}
