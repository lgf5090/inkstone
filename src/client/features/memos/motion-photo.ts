import type { MemoMotionRole } from '@shared/memos/types'

export interface MemoMotionAssignment {
  groupId: string
  role: MemoMotionRole
}

export interface MemoMotionPairing {
  files: File[]
  assignments: Map<File, MemoMotionAssignment>
}

const MOTION_MARKER_RE = /(?:Camera:MotionPhoto|GCamera:MotionPhoto|MicroVideo)["'=:\s>]+1/i
const MICRO_VIDEO_OFFSET_RE = /(?:Camera:MicroVideoOffset|GCamera:MicroVideoOffset)["'=:\s>]+(\d+)/i
const MAX_METADATA_SCAN_BYTES = 256 * 1024
const SCAN_BLOCK_BYTES = 64 * 1024
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * Pairs picked files that belong together before any upload starts.
 *
 * A Live Photo arrives as two files with one stem, and an Android Motion Photo carries its video
 * inside the JPEG. Both become one still/video group so the gallery can play the motion instead of
 * showing a second, separate attachment. Anything that does not pair uploads exactly as before.
 */
export async function pairMemoMotionFiles(
  files: readonly File[],
): Promise<MemoMotionPairing> {
  const assignments = new Map<File, MemoMotionAssignment>()
  const outputs: File[] = []
  const claimed = new Set<File>()

  for (const file of files) {
    outputs.push(file)
    if (!isJpeg(file)) continue
    let video: File | null = null
    try {
      video = await extractEmbeddedMotionVideo(file)
    } catch (error) {
      console.warn('[inkstone] Memo motion photo could not be read; uploading the still alone', error)
      continue
    }
    if (!video) continue
    claimed.add(file)
    const groupId = newMemoMotionGroupId()
    assignments.set(file, { groupId, role: 'still' })
    assignments.set(video, { groupId, role: 'video' })
    outputs.push(video)
  }

  const byStem = new Map<string, File[]>()
  for (const file of files) {
    if (claimed.has(file)) continue
    const stem = filenameStem(file.name)
    const group = byStem.get(stem)
    if (group) group.push(file)
    else byStem.set(stem, [file])
  }
  for (const group of byStem.values()) {
    const images = group.filter((file) => file.type.toLowerCase().startsWith('image/'))
    const videos = group.filter((file) => file.type.toLowerCase().startsWith('video/'))
    if (images.length !== 1 || videos.length !== 1) continue
    const groupId = newMemoMotionGroupId()
    assignments.set(images[0]!, { groupId, role: 'still' })
    assignments.set(videos[0]!, { groupId, role: 'video' })
  }

  return { files: outputs, assignments }
}

export async function extractEmbeddedMotionVideo(file: File): Promise<File | null> {
  if (!isJpeg(file) || file.size < 16) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const header = latin1(bytes.subarray(0, Math.min(bytes.length, MAX_METADATA_SCAN_BYTES)))
  if (!MOTION_MARKER_RE.test(header)) return null

  const start = embeddedVideoStart(bytes, header)
  if (start === null) return null
  return new File(
    [bytes.slice(start)],
    `${filenameStem(file.name)}.mp4`,
    { type: 'video/mp4', lastModified: file.lastModified },
  )
}

function embeddedVideoStart(bytes: Uint8Array, header: string): number | null {
  const offsetMatch = MICRO_VIDEO_OFFSET_RE.exec(header)
  if (offsetMatch) {
    const offset = Number(offsetMatch[1])
    if (Number.isSafeInteger(offset) && offset >= 12 && offset < bytes.length) {
      const candidate = bytes.length - offset
      if (looksLikeMp4(bytes, candidate)) return candidate
    }
  }

  for (let end = bytes.length; end >= 12;) {
    const start = Math.max(0, end - SCAN_BLOCK_BYTES)
    const candidate = lastMp4StartIn(bytes, start, end)
    if (candidate !== null) return candidate
    if (start === 0) break
    end = start + 11
  }
  return null
}

function lastMp4StartIn(bytes: Uint8Array, start: number, end: number): number | null {
  let searchFrom = end
  while (searchFrom > start + 8) {
    const index = lastIndexOfFtyp(bytes, start, searchFrom)
    if (index < 0 || index < 4) return null
    const candidate = index - 4
    if (looksLikeMp4(bytes, candidate)) return candidate
    searchFrom = index
  }
  return null
}

function lastIndexOfFtyp(bytes: Uint8Array, start: number, end: number): number {
  for (let index = end - 4; index >= start; index -= 1) {
    if (
      bytes[index] === 0x66
      && bytes[index + 1] === 0x74
      && bytes[index + 2] === 0x79
      && bytes[index + 3] === 0x70
    ) {
      return index
    }
  }
  return -1
}

function looksLikeMp4(bytes: Uint8Array, start: number): boolean {
  if (start < 0 || start + 12 > bytes.length) return false
  if (
    bytes[start + 4] !== 0x66
    || bytes[start + 5] !== 0x74
    || bytes[start + 6] !== 0x79
    || bytes[start + 7] !== 0x70
  ) {
    return false
  }
  const size = new DataView(bytes.buffer, bytes.byteOffset + start, 4).getUint32(0)
  return size === 1 || size >= 8
}

function isJpeg(file: File): boolean {
  const type = file.type.toLowerCase()
  return type === 'image/jpeg' || type === 'image/jpg' || type === 'image/pjpeg'
}

function filenameStem(filename: string): string {
  const parts = filename.split('.')
  if (parts.length <= 1) return filename.toLowerCase()
  return parts.slice(0, -1).join('.').toLowerCase()
}

function newMemoMotionGroupId(): string {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const byte of bytes) id += ID_ALPHABET[byte & 31]
  return id
}

function latin1(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return text
}
