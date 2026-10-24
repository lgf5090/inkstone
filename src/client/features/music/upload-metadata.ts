/** Reads what the browser can tell us about a file before it is uploaded. */
import { parseBlob } from 'music-metadata'
import { formatFromFilename } from '@shared/music/constants'

export interface UploadMetadata {
  title: string
  artists: string[]
  album: string
  durationMs: number
  format: string
  bitrate: number | null
  cover: Blob | null
  /** Embedded lyrics as LRC/text, already bounded; an empty string means none. */
  lyrics: string
}

export type UploadMetadataResult =
  | { ok: true; data: UploadMetadata }
  | { ok: false; error: string }

function lrcFromSync(lines: readonly { text: string, timestamp?: number }[]): string {
  return lines
    .filter((line) => line.text.trim() && typeof line.timestamp === 'number')
    .map((line) => {
      const total = Math.max(0, Math.round(line.timestamp!))
      const minutes = Math.floor(total / 60_000)
      const seconds = Math.floor((total % 60_000) / 1000)
      const centiseconds = Math.floor((total % 1000) / 10)
      return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]${line.text.trim()}`
    })
    .join('\n')
}

function embeddedLyrics(metadata: Awaited<ReturnType<typeof parseBlob>>): string {
  const tag = metadata.common.lyrics?.[0]
  if (!tag) return ''
  const text = typeof tag.text === 'string' ? tag.text.trim() : ''
  if (text) return text.slice(0, 20_000)
  return lrcFromSync(tag.syncText ?? []).slice(0, 20_000)
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').trim()
  return base || filename
}

export async function parseUploadMetadata(file: File): Promise<UploadMetadataResult> {
  const extensionFormat = formatFromFilename(file.name) ?? ''
  try {
    const metadata = await parseBlob(file, { duration: true, skipCovers: false })
    const picture = metadata.common.picture?.[0]
    const cover = picture
      ? new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' })
      : null
    return {
      ok: true,
      data: {
        title: metadata.common.title?.trim() || titleFromFilename(file.name),
        artists: metadata.common.artists?.filter(Boolean) ?? [],
        album: metadata.common.album?.trim() ?? '',
        durationMs: Math.max(0, Math.round((metadata.format.duration ?? 0) * 1000)),
        format: extensionFormat || metadata.format.container?.toLowerCase() || '',
        bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
        cover,
        lyrics: embeddedLyrics(metadata),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Metadata could not be read' }
  }
}
