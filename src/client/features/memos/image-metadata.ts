import type {
  MemoMediaCaptureTime,
  MemoMediaLocation,
  MemoMediaMetadata,
  MemoPhotoMetadata,
} from '@shared/memos/types'
import { optimizeImageFile } from '../../lib/image'

export const MEMO_THUMBNAIL_MAX_DIMENSION = 600
export const MEMO_THUMBNAIL_QUALITY = 0.82
export const MEMO_THUMBNAIL_MIME = 'image/jpeg'

const METADATA_STRING_MAX_CHARS = 256
const MAX_ORIENTATION = 8
const MAX_OFFSET_MINUTES = 14 * 60
const THUMBNAIL_FILENAME = 'thumbnail.jpg'

const EXIF_FIELDS: string[] = [
  'DateTimeOriginal',
  'OffsetTimeOriginal',
  'OffsetTime',
  'OffsetTimeDigitized',
  'Make',
  'Model',
  'LensModel',
  'FNumber',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'Orientation',
  'PixelXDimension',
  'PixelYDimension',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight',
  'latitude',
  'longitude',
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  'GPSAltitude',
  'GPSAltitudeRef',
]

export interface PrepareMemoAttachmentOptions {
  saveMediaMetadata: boolean
}

export interface PreparedMemoAttachment {
  file: File
  thumbnail: File | null
  metadata: MemoMediaMetadata | null
}

interface SourceDimensions {
  width: number
  height: number
}

interface PreparedThumbnail {
  file: File
  sourceWidth: number
  sourceHeight: number
}

let exifrModule: Promise<typeof import('exifr')> | null = null

function loadExifr(): Promise<typeof import('exifr')> {
  if (!exifrModule) {
    exifrModule = import('exifr').catch((error: unknown) => {
      exifrModule = null
      throw error
    })
  }
  return exifrModule
}

export async function prepareMemoAttachment(
  file: File,
  options: PrepareMemoAttachmentOptions,
): Promise<PreparedMemoAttachment> {
  if (!isRasterImage(file)) return { file, thumbnail: null, metadata: null }
  const optimized = await optimizeImageFile(file)
  const [rawExif, thumbnail] = await Promise.all([
    options.saveMediaMetadata ? readExif(file) : Promise.resolve(null),
    createThumbnail(optimized),
  ])
  const metadata = options.saveMediaMetadata
    ? normalizeExifMetadata(
        rawExif,
        thumbnail ? { width: thumbnail.sourceWidth, height: thumbnail.sourceHeight } : null,
      )
    : null
  return {
    file: optimized,
    thumbnail: thumbnail?.file ?? null,
    metadata,
  }
}

async function readExif(file: File): Promise<Record<string, unknown> | null> {
  try {
    const { default: exifr } = await loadExifr()
    const parsed: unknown = await exifr.parse(file, {
      pick: EXIF_FIELDS,
      translateKeys: true,
      translateValues: false,
      reviveValues: true,
      mergeOutput: true,
      sanitize: true,
    })
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    console.warn('[inkstone] Memo photo metadata could not be parsed', error)
    return null
  }
}

export function normalizeExifMetadata(
  raw: unknown,
  sourceDimensions: SourceDimensions | null = null,
): MemoMediaMetadata | null {
  if (!isRecord(raw)) return null
  const orientation = normalizeOrientation(raw.Orientation)
  const dimensions = resolvePhotoDimensions(raw, sourceDimensions, orientation)
  const photo: MemoPhotoMetadata = {
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  }
  const captureTime = normalizeCaptureTime(
    raw.DateTimeOriginal,
    raw.OffsetTimeOriginal ?? raw.OffsetTime ?? raw.OffsetTimeDigitized,
  )
  if (captureTime) photo.captureTime = captureTime
  const location = normalizeGpsLocation(raw)
  if (location) photo.location = location
  const cameraMake = normalizeMetadataString(raw.Make)
  if (cameraMake) photo.cameraMake = cameraMake
  const cameraModel = normalizeMetadataString(raw.Model)
  if (cameraModel) photo.cameraModel = cameraModel
  const lensModel = normalizeMetadataString(raw.LensModel)
  if (lensModel) photo.lensModel = lensModel
  const fNumber = positiveNumber(raw.FNumber)
  if (fNumber !== undefined) photo.fNumber = fNumber
  const exposureTimeSeconds = positiveNumber(raw.ExposureTime)
  if (exposureTimeSeconds !== undefined) photo.exposureTimeSeconds = exposureTimeSeconds
  const iso = positiveNumber(raw.ISO)
  if (iso !== undefined) photo.iso = iso
  const focalLengthMm = positiveNumber(raw.FocalLength)
  if (focalLengthMm !== undefined) photo.focalLengthMm = focalLengthMm
  if (orientation !== undefined) photo.orientation = orientation
  const hasMetadata = photo.width !== null
    || photo.height !== null
    || photo.captureTime !== undefined
    || photo.location !== undefined
    || photo.cameraMake !== undefined
    || photo.cameraModel !== undefined
    || photo.lensModel !== undefined
    || photo.fNumber !== undefined
    || photo.exposureTimeSeconds !== undefined
    || photo.iso !== undefined
    || photo.focalLengthMm !== undefined
    || photo.orientation !== undefined
  return hasMetadata ? { photo } : null
}

export function normalizeOrientation(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 1 && value <= MAX_ORIENTATION ? value : undefined
}

export function orientationSwapsDimensions(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= MAX_ORIENTATION
}

export function normalizeCaptureTime(
  value: unknown,
  offset: unknown,
): MemoMediaCaptureTime | undefined {
  const local = formatCaptureTime(value)
  if (!local) return undefined
  return { local, offsetMinutes: parseOffsetMinutes(offset) ?? 0 }
}

export function thumbnailDimensions(
  width: number,
  height: number,
  maxDimension: number = MEMO_THUMBNAIL_MAX_DIMENSION,
): SourceDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return null
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function createThumbnail(file: File): Promise<PreparedThumbnail | null> {
  let bitmap: ImageBitmap | null = null
  try {
    if (typeof createImageBitmap !== 'function') return null
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const size = thumbnailDimensions(bitmap.width, bitmap.height)
    if (!size) return null
    const canvas = drawToCanvas(bitmap, size.width, size.height)
    if (!canvas) return null
    const blob = await canvasToJpegBlob(canvas)
    if (!blob || blob.size === 0) return null
    return {
      file: new File([blob], THUMBNAIL_FILENAME, { type: MEMO_THUMBNAIL_MIME }),
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
    }
  } catch (error) {
    console.info('[inkstone] Memo thumbnail could not be generated', error)
    return null
  } finally {
    try {
      bitmap?.close()
    } catch (error) {
      console.info('[inkstone] Memo thumbnail bitmap could not be released', error)
    }
  }
}

function drawToCanvas(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas | null {
  let canvas: HTMLCanvasElement | OffscreenCanvas
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height)
  } else {
    if (typeof document === 'undefined') return null
    const element = document.createElement('canvas')
    element.width = width
    element.height = height
    canvas = element
  }
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

function canvasToJpegBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
  if (isOffscreenCanvas(canvas)) {
    return canvas.convertToBlob({ type: MEMO_THUMBNAIL_MIME, quality: MEMO_THUMBNAIL_QUALITY })
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), MEMO_THUMBNAIL_MIME, MEMO_THUMBNAIL_QUALITY)
  })
}

function isOffscreenCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas === 'function' && canvas instanceof OffscreenCanvas
}

function resolvePhotoDimensions(
  raw: Record<string, unknown>,
  source: SourceDimensions | null,
  orientation: number | undefined,
): SourceDimensions | null {
  const sourceWidth = positiveInteger(source?.width)
  const sourceHeight = positiveInteger(source?.height)
  if (sourceWidth !== undefined && sourceHeight !== undefined) {
    return { width: sourceWidth, height: sourceHeight }
  }
  const rawWidth = positiveInteger(raw.PixelXDimension)
    ?? positiveInteger(raw.ExifImageWidth)
    ?? positiveInteger(raw.ImageWidth)
  const rawHeight = positiveInteger(raw.PixelYDimension)
    ?? positiveInteger(raw.ExifImageHeight)
    ?? positiveInteger(raw.ImageHeight)
  if (rawWidth === undefined || rawHeight === undefined) return null
  return orientationSwapsDimensions(orientation)
    ? { width: rawHeight, height: rawWidth }
    : { width: rawWidth, height: rawHeight }
}

function formatCaptureTime(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    return [
      String(value.getFullYear()).padStart(4, '0'),
      '-',
      pad2(value.getMonth() + 1),
      '-',
      pad2(value.getDate()),
      'T',
      pad2(value.getHours()),
      ':',
      pad2(value.getMinutes()),
      ':',
      pad2(value.getSeconds()),
    ].join('')
  }
  if (typeof value !== 'string') return null
  const match = /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hours = Number(match[4])
  const minutes = Number(match[5])
  const seconds = Number(match[6])
  const date = new Date(year, month - 1, day, hours, minutes, seconds)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
    || date.getSeconds() !== seconds
  ) {
    return null
  }
  return [
    String(year).padStart(4, '0'),
    '-',
    pad2(month),
    '-',
    pad2(day),
    'T',
    pad2(hours),
    ':',
    pad2(minutes),
    ':',
    pad2(seconds),
  ].join('')
}

function parseOffsetMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === 'Z' || text === 'z') return 0
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (minutes >= 60) return null
  const total = hours * 60 + minutes
  if (total > MAX_OFFSET_MINUTES) return null
  if (total === 0) return 0
  return match[1] === '-' ? -total : total
}

function normalizeGpsLocation(raw: Record<string, unknown>): MemoMediaLocation | undefined {
  const latitude = coordinate(raw.latitude, raw.GPSLatitude, raw.GPSLatitudeRef, 90)
  const longitude = coordinate(raw.longitude, raw.GPSLongitude, raw.GPSLongitudeRef, 180)
  if (latitude === undefined || longitude === undefined) return undefined
  const altitude = altitudeMeters(raw.GPSAltitude, raw.GPSAltitudeRef)
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude }),
  }
}

function coordinate(direct: unknown, dms: unknown, reference: unknown, limit: number): number | undefined {
  const directValue = finiteNumber(direct)
  if (directValue !== undefined && Math.abs(directValue) <= limit) return directValue
  const dmsValue = dmsCoordinate(dms, reference)
  if (dmsValue !== undefined && Math.abs(dmsValue) <= limit) return dmsValue
  return undefined
}

function dmsCoordinate(value: unknown, reference: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const degrees = finiteNumber(value[0])
  const minutes = finiteNumber(value[1])
  const seconds = value.length > 2 ? finiteNumber(value[2]) : 0
  if (degrees === undefined || minutes === undefined || seconds === undefined) return undefined
  if (degrees < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return undefined
  const decimal = degrees + minutes / 60 + seconds / 3600
  const direction = typeof reference === 'string' ? reference.trim().toUpperCase() : ''
  return direction === 'S' || direction === 'W' ? -decimal : decimal
}

function altitudeMeters(value: unknown, reference: unknown): number | undefined {
  const altitude = finiteNumber(value)
  if (altitude === undefined) return undefined
  const referenceValue = Array.isArray(reference) ? finiteNumber(reference[0]) : finiteNumber(reference)
  return referenceValue === 1 && altitude > 0 ? -altitude : altitude
}

function normalizeMetadataString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.slice(0, METADATA_STRING_MAX_CHARS)
}

function isRasterImage(file: File): boolean {
  const type = file.type.toLowerCase()
  return type.startsWith('image/') && type !== 'image/svg+xml'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? number : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
