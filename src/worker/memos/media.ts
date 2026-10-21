import type {
  MemoMediaMetadata,
  MemoPhotoMetadata,
  MemoVideoMetadata,
} from '@shared/memos/types'
import { isInlineSafe, safeAttachmentMime } from '../lib/image'

const ISO_BMFF_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'audio/mp4',
  'audio/x-m4a',
])

const EBML_MIMES = new Set(['video/webm', 'video/x-matroska', 'audio/webm'])
const OGG_MIMES = new Set(['audio/ogg', 'audio/opus'])
const WAVE_MIMES = new Set(['audio/wav', 'audio/x-wav'])

export function safeMemoMime(bytes: Uint8Array, reportedMime: string): string {
  const normalized = reportedMime.trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream'
  if (ISO_BMFF_MIMES.has(normalized)) return isIsoBmff(bytes) ? normalized : 'application/octet-stream'
  if (EBML_MIMES.has(normalized)) return isEbml(bytes) ? normalized : 'application/octet-stream'
  if (OGG_MIMES.has(normalized)) return isOgg(bytes) ? normalized : 'application/octet-stream'
  if (WAVE_MIMES.has(normalized)) return isWave(bytes) ? normalized : 'application/octet-stream'
  if (normalized === 'audio/mpeg') return isMpegAudio(bytes) ? normalized : 'application/octet-stream'
  if (normalized === 'audio/flac') return isFlac(bytes) ? normalized : 'application/octet-stream'
  if (normalized === 'audio/aac') return isAdts(bytes) ? normalized : 'application/octet-stream'
  return safeAttachmentMime(bytes, normalized)
}

export function isMemoInlineSafe(mime: string): boolean {
  return isInlineSafe(mime) || mime.startsWith('audio/') || mime.startsWith('video/')
}

export function parseMemoMediaMetadata(raw: string): MemoMediaMetadata | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const photo = parsePhotoMetadata(value.photo)
  const video = parseVideoMetadata(value.video)
  return {
    ...(photo ? { photo } : {}),
    ...(video ? { video } : {}),
  }
}

function parsePhotoMetadata(value: unknown): MemoPhotoMetadata | null {
  if (!isRecord(value)) return null
  const photo: MemoPhotoMetadata = {
    width: numericOrNull(value.width),
    height: numericOrNull(value.height),
  }
  const captureTime = isRecord(value.captureTime)
    && typeof value.captureTime.local === 'string'
    && finiteNumber(value.captureTime.offsetMinutes)
    ? {
        local: value.captureTime.local.slice(0, 64),
        offsetMinutes: value.captureTime.offsetMinutes,
      }
    : null
  if (captureTime) photo.captureTime = captureTime

  if (isRecord(value.location) && finiteNumber(value.location.latitude) && finiteNumber(value.location.longitude)) {
    const location: NonNullable<MemoPhotoMetadata['location']> = {
      latitude: value.location.latitude,
      longitude: value.location.longitude,
    }
    if (finiteNumber(value.location.altitude)) location.altitude = value.location.altitude
    photo.location = location
  }

  const cameraMake = stringOrUndefined(value.cameraMake)
  if (cameraMake) photo.cameraMake = cameraMake
  const cameraModel = stringOrUndefined(value.cameraModel)
  if (cameraModel) photo.cameraModel = cameraModel
  const lensModel = stringOrUndefined(value.lensModel)
  if (lensModel) photo.lensModel = lensModel
  if (finiteNumber(value.fNumber)) photo.fNumber = value.fNumber
  if (finiteNumber(value.exposureTimeSeconds)) photo.exposureTimeSeconds = value.exposureTimeSeconds
  if (finiteNumber(value.iso)) photo.iso = value.iso
  if (finiteNumber(value.focalLengthMm)) photo.focalLengthMm = value.focalLengthMm
  if (finiteNumber(value.orientation)) photo.orientation = Math.trunc(value.orientation)
  const empty = photo.width === null
    && photo.height === null
    && !photo.captureTime
    && !photo.location
    && !photo.cameraMake
    && !photo.cameraModel
    && !photo.lensModel
    && photo.fNumber === undefined
    && photo.exposureTimeSeconds === undefined
    && photo.iso === undefined
    && photo.focalLengthMm === undefined
    && photo.orientation === undefined
  return empty ? null : photo
}

function parseVideoMetadata(value: unknown): MemoVideoMetadata | null {
  if (!isRecord(value)) return null
  if (!finiteNumber(value.durationSeconds) || value.durationSeconds < 0) return null
  return { durationSeconds: value.durationSeconds }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numericOrNull(value: unknown): number | null {
  return finiteNumber(value) ? value : null
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, 256) : undefined
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function isIsoBmff(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp'
}

function isEbml(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3
}

function isOgg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS'
}

function isWave(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE'
}

function isMpegAudio(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return true
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
}

function isFlac(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ascii(bytes, 0, 4) === 'fLaC'
}

function isAdts(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0
}
