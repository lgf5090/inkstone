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
}

export type UploadMetadataResult =
  | { ok: true; data: UploadMetadata }
  | { ok: false; error: string }

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
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Metadata could not be read' }
  }
}
