/** Reads what the browser can tell us about a file before it is uploaded or imported. */
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

/** A remote file is read in growing heads: tags live at the start, artwork may push the boundary. */
const REMOTE_HEAD_BYTES = [2 * 1024 * 1024, 8 * 1024 * 1024] as const
const REMOTE_DURATION_TIMEOUT_MS = 10_000
const REMOTE_HEAD_TIMEOUT_MS = 30_000

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

/** Tag writers sometimes label a PNG as JPEG; the bytes decide which type the server may accept. */
function sniffImageMime(data: Uint8Array, declared: string): string {
  const ascii = (start: number, end: number): string => {
    if (end > data.length) return ''
    return String.fromCharCode(...data.subarray(start, end))
  }
  if (data.length >= 8 && data[0] === 0x89 && ascii(1, 4) === 'PNG'
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const gif = ascii(0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 12 && ascii(4, 8) === 'ftyp') {
    for (let offset = 8; offset + 4 <= Math.min(data.length, 64); offset += 4) {
      const brand = ascii(offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return 'image/avif'
    }
  }
  return declared
}

function imageComplete(data: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') {
    return data.length > 4 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
  }
  if (mime === 'image/png') {
    const end = data.subarray(Math.max(0, data.length - 8))
    return end[0] === 0x49 && end[1] === 0x45 && end[2] === 0x4e && end[3] === 0x44
  }
  if (mime === 'image/gif') return data[data.length - 1] === 0x3b
  if (mime === 'image/webp') {
    if (data.length < 12) return false
    const declared = data[4]! | data[5]! << 8 | data[6]! << 16 | data[7]! << 24
    return data.length >= declared + 8
  }
  // AVIF and unknown formats: do not force a larger download on a guess.
  return true
}

function asciiOf(bytes: Uint8Array, start: number, end: number): string {
  if (end > bytes.length) return ''
  return String.fromCharCode(...bytes.subarray(start, end))
}

function uint32At(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function id3TagsTruncated(bytes: Uint8Array): boolean {
  if (bytes.length < 10 || asciiOf(bytes, 0, 3) !== 'ID3') return false
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f)
  const footer = (bytes[5]! & 0x10) === 0 ? 0 : 10
  return 10 + size + footer > bytes.length
}

function flacTagsTruncated(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || asciiOf(bytes, 0, 4) !== 'fLaC') return false
  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]!
    const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (offset + 4 + length > bytes.length) return true
    offset += 4 + length
    if ((header & 0x80) !== 0) return false
  }
  return true
}

function mp4TagsTruncated(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || asciiOf(bytes, 4, 8) !== 'ftyp') return false
  let offset = 0
  while (offset + 8 <= bytes.length) {
    const size = uint32At(bytes, offset)
    const type = asciiOf(bytes, offset + 4, offset + 8)
    if (size === 0) return true
    let header = 8
    let box = size
    if (size === 1) {
      if (offset + 16 > bytes.length) return true
      box = uint32At(bytes, offset + 8) * 0x1_0000_0000 + uint32At(bytes, offset + 12)
      header = 16
    }
    if (box < header || offset + box > bytes.length) return true
    if (type === 'moov') return false
    offset += box
  }
  return true
}

/** Whether the container's own tag block extends past this prefix. */
function tagsTruncated(bytes: Uint8Array): boolean {
  return id3TagsTruncated(bytes) || flacTagsTruncated(bytes) || mp4TagsTruncated(bytes)
}

function metadataOf(
  metadata: Awaited<ReturnType<typeof parseBlob>>,
  fallbackTitle: string,
  durationMs: number,
  extensionFormat: string,
): UploadMetadata {
  const picture = metadata.common.picture?.[0]
  const pictureBytes = picture ? new Uint8Array(picture.data) : null
  return {
    title: metadata.common.title?.trim() || fallbackTitle,
    artists: metadata.common.artists?.filter(Boolean) ?? [],
    album: metadata.common.album?.trim() ?? '',
    durationMs,
    format: extensionFormat || metadata.format.container?.toLowerCase() || '',
    bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
    cover: picture && pictureBytes
      ? new Blob([pictureBytes], { type: sniffImageMime(pictureBytes, picture.format || 'image/jpeg') })
      : null,
    lyrics: embeddedLyrics(metadata),
  }
}

export async function parseUploadMetadata(file: File): Promise<UploadMetadataResult> {
  const extensionFormat = formatFromFilename(file.name) ?? ''
  try {
    const metadata = await parseBlob(file, { duration: true, skipCovers: false })
    return {
      ok: true,
      data: metadataOf(
        metadata,
        titleFromFilename(file.name),
        Math.max(0, Math.round((metadata.format.duration ?? 0) * 1000)),
        extensionFormat,
      ),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Metadata could not be read' }
  }
}

/** Read the first `limit` bytes of a same-origin stream and stop paying for the rest. */
async function readHead(url: string, limit: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REMOTE_HEAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${limit - 1}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`The audio stream answered ${response.status}`)
    const contentRange = response.headers.get('content-range')
    const rangedTotal = contentRange ? /\/(\d+)$/.exec(contentRange)?.[1] : undefined
    const contentLength = Number(response.headers.get('content-length') ?? '')
    const total = rangedTotal
      ? Number(rangedTotal)
      : response.status === 200 && Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : null
    const reader = response.body?.getReader()
    if (!reader) {
      const whole = new Uint8Array(await response.arrayBuffer())
      const bytes = whole.subarray(0, limit)
      return { bytes, complete: bytes.byteLength >= whole.byteLength }
    }
    const chunks: Uint8Array[] = []
    let read = 0
    try {
      while (read < limit) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        const take = value.byteLength > limit - read ? value.subarray(0, limit - read) : value
        chunks.push(take)
        read += take.byteLength
      }
    } finally {
      await reader.cancel().catch(() => {
        // The head was already read; a cancel after the stream closed is not a metadata failure.
      })
    }
    const bytes = new Uint8Array(read)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, complete: total === null ? read < limit : read >= total }
  } finally {
    window.clearTimeout(timeout)
  }
}

/**
 * Ask the audio element for a duration when the tags did not carry one (an MP3 without a Xing frame,
 * for instance). `preload='metadata'` fetches only what the demuxer needs and does not start playback.
 */
function readRemoteDuration(url: string): Promise<number> {
  if (typeof Audio === 'undefined') return Promise.resolve(0)
  return new Promise((resolve) => {
    const audio = new Audio()
    let settled = false
    const finish = (value: number): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', onReady)
      audio.removeEventListener('error', onError)
      audio.removeAttribute('src')
      audio.load()
      resolve(value)
    }
    const onReady = (): void => {
      finish(audio.duration > 0 && Number.isFinite(audio.duration)
        ? Math.round(audio.duration * 1000)
        : 0)
    }
    const onError = (): void => finish(0)
    const timer = window.setTimeout(() => finish(0), REMOTE_DURATION_TIMEOUT_MS)
    audio.preload = 'metadata'
    audio.addEventListener('loadedmetadata', onReady)
    audio.addEventListener('error', onError)
    audio.src = url
    audio.load()
  })
}

/**
 * Read tags from a cloud reference that was imported without moving its bytes.
 *
 * The reference's own stream route is used, so WebDAV and Alist credentials never reach this code.
 * A tag header normally fits the first head; artwork can push it further, so the same prefix is
 * fetched again at a larger bound only when parsing asked for more bytes. Files such as an M4A with
 * its `moov` atom at the end can still answer with the duration the element reports.
 */
export async function parseRemoteTrackMetadata(track: {
  id: string
  title: string
  format: string
  size: number | null
}): Promise<UploadMetadataResult> {
  const url = `/api/music/media/stream/${encodeURIComponent(track.id)}`
  let lastError: unknown = null
  for (const [index, step] of REMOTE_HEAD_BYTES.entries()) {
    const limit = track.size && track.size > 0 ? Math.min(step, track.size) : step
    try {
      const head = await readHead(url, limit)
      if (head.bytes.byteLength === 0) break
      try {
        const exact = new Uint8Array(head.bytes.byteLength)
        exact.set(head.bytes)
        if (!head.complete && tagsTruncated(exact) && index < REMOTE_HEAD_BYTES.length - 1) {
          lastError = new Error('The tags extend beyond this prefix')
          continue
        }
        const metadata = await parseBlob(new Blob([exact]), { duration: false, skipCovers: false })
        let durationMs = Math.max(0, Math.round((metadata.format.duration ?? 0) * 1000))
        if (durationMs === 0) durationMs = await readRemoteDuration(url)
        const picture = metadata.common.picture?.[0]
        const pictureBytes = picture ? new Uint8Array(picture.data) : null
        const coverIncomplete = Boolean(
          picture && pictureBytes && !head.complete
          && !imageComplete(pictureBytes, sniffImageMime(pictureBytes, picture.format || 'image/jpeg')),
        )
        if (coverIncomplete && index < REMOTE_HEAD_BYTES.length - 1) {
          lastError = new Error('The embedded cover is incomplete')
          continue
        }
        const data = metadataOf(metadata, track.title, durationMs, track.format)
        if (coverIncomplete) data.cover = null
        return { ok: true, data }
      } catch (error) {
        lastError = error
        // Only a prefix that already reached the end of the file cannot grow into a readable tag.
        if (head.complete) break
      }
    } catch (error) {
      lastError = error
      break
    }
  }

  const durationMs = await readRemoteDuration(url)
  if (durationMs > 0) {
    return {
      ok: true,
      data: {
        title: track.title,
        artists: [],
        album: '',
        durationMs,
        format: track.format,
        bitrate: null,
        cover: null,
        lyrics: '',
      },
    }
  }
  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : 'Metadata could not be read',
  }
}
