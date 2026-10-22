import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeCaptureTime,
  normalizeExifMetadata,
  normalizeOrientation,
  orientationSwapsDimensions,
  prepareMemoAttachment,
  thumbnailDimensions,
} from './image-metadata'

const { exifrParse } = vi.hoisted(() => ({ exifrParse: vi.fn() }))

vi.mock('exifr', () => ({ default: { parse: exifrParse } }))

interface FakeContext {
  drawImage: ReturnType<typeof vi.fn>
}

class FakeCanvas {
  width: number
  height: number
  context: FakeContext = { drawImage: vi.fn() }
  lastOptions: { type?: string; quality?: number } | null = null

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    canvases.push(this)
  }

  getContext(kind: string): FakeContext | null {
    return kind === '2d' ? this.context : null
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    this.lastOptions = options ?? null
    return Promise.resolve(thumbnailBlob ?? new Blob(['thumb'], { type: options?.type ?? 'image/jpeg' }))
  }
}

type CreateImageBitmapMock = (
  source: ImageBitmapSource,
  options?: ImageBitmapOptions,
) => Promise<ImageBitmap>

let canvases: FakeCanvas[] = []
let thumbnailBlob: Blob | null = null
const createImageBitmapMock = vi.fn<CreateImageBitmapMock>()

function makeBitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() }
}

function imageFile(name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File(['image-bytes'], name, { type })
}

beforeEach(() => {
  canvases = []
  thumbnailBlob = null
  exifrParse.mockReset()
  createImageBitmapMock.mockReset()
  createImageBitmapMock.mockImplementation(async () => makeBitmap(1200, 800))
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  vi.stubGlobal('createImageBitmap', createImageBitmapMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('EXIF normalization', () => {
  it('normalizes a full EXIF record into memo media metadata', () => {
    const metadata = normalizeExifMetadata({
      DateTimeOriginal: new Date(2024, 4, 1, 10, 20, 30),
      OffsetTimeOriginal: '+08:00',
      Make: '  Apple  ',
      Model: 'iPhone 15 Pro',
      LensModel: 'Main Camera',
      FNumber: 1.8,
      ExposureTime: 1 / 120,
      ISO: 100,
      FocalLength: 24,
      Orientation: 6,
      ExifImageWidth: 4032,
      ExifImageHeight: 3024,
      latitude: 31.2304,
      longitude: 121.4737,
      GPSAltitude: 12.5,
      GPSAltitudeRef: 0,
    })
    expect(metadata).toEqual({
      photo: {
        width: 3024,
        height: 4032,
        captureTime: { local: '2024-05-01T10:20:30', offsetMinutes: 480 },
        location: { latitude: 31.2304, longitude: 121.4737, altitude: 12.5 },
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15 Pro',
        lensModel: 'Main Camera',
        fNumber: 1.8,
        exposureTimeSeconds: 1 / 120,
        iso: 100,
        focalLengthMm: 24,
        orientation: 6,
      },
    })
  })

  it('prefers the decoded display size over the EXIF pixel size', () => {
    const metadata = normalizeExifMetadata(
      { Orientation: 6, PixelXDimension: 4032, PixelYDimension: 3024 },
      { width: 3024, height: 4032 },
    )
    expect(metadata?.photo).toMatchObject({ width: 3024, height: 4032 })
  })

  it('keeps a partial record and omits missing or nonsensical fields', () => {
    expect(normalizeExifMetadata(null)).toBeNull()
    expect(normalizeExifMetadata({})).toBeNull()
    expect(normalizeExifMetadata({
      Make: '   ',
      FNumber: 0,
      ExposureTime: Number.NaN,
      ISO: -1,
      FocalLength: '24',
      Orientation: 9,
    })).toBeNull()
    expect(normalizeExifMetadata({ Model: 'X-T5' })).toEqual({
      photo: { width: null, height: null, cameraModel: 'X-T5' },
    })
  })

  it('caps and flattens metadata strings', () => {
    const photo = normalizeExifMetadata({ Make: `${'x'.repeat(300)}\n\t` })?.photo
    expect(photo?.cameraMake).toHaveLength(256)
    expect(photo?.cameraMake).not.toContain('\n')
  })
})

describe('capture time', () => {
  it('keeps the wall clock and applies the EXIF offset', () => {
    expect(normalizeCaptureTime(new Date(2024, 4, 1, 10, 20, 30), '+08:00')).toEqual({
      local: '2024-05-01T10:20:30',
      offsetMinutes: 480,
    })
    expect(normalizeCaptureTime('2024:05:01 10:20:30', '-05:30')).toEqual({
      local: '2024-05-01T10:20:30',
      offsetMinutes: -330,
    })
    expect(normalizeCaptureTime('2024-05-01T10:20:30', '+0000')).toEqual({
      local: '2024-05-01T10:20:30',
      offsetMinutes: 0,
    })
    expect(normalizeCaptureTime('2024-05-01T10:20:30', 'Z')).toEqual({
      local: '2024-05-01T10:20:30',
      offsetMinutes: 0,
    })
  })

  it('falls back to UTC when the offset is missing or invalid', () => {
    expect(normalizeCaptureTime('2024-05-01T10:20:30', undefined)?.offsetMinutes).toBe(0)
    expect(normalizeCaptureTime('2024-05-01T10:20:30', '+99:99')?.offsetMinutes).toBe(0)
  })

  it('rejects impossible dates and times', () => {
    expect(normalizeCaptureTime('2024-02-30 10:00:00', '+08:00')).toBeUndefined()
    expect(normalizeCaptureTime('not a date', '+08:00')).toBeUndefined()
    expect(normalizeCaptureTime(new Date(Number.NaN), '+08:00')).toBeUndefined()
  })
})

describe('GPS validation', () => {
  it('accepts decimal coordinates and drops out-of-range values', () => {
    expect(normalizeExifMetadata({
      latitude: 31.2304,
      longitude: 121.4737,
    })?.photo?.location).toEqual({ latitude: 31.2304, longitude: 121.4737 })
    expect(normalizeExifMetadata({ latitude: 91, longitude: 0 })?.photo?.location).toBeUndefined()
    expect(normalizeExifMetadata({ latitude: 0, longitude: -181 })?.photo?.location).toBeUndefined()
    expect(normalizeExifMetadata({ latitude: Number.NaN, longitude: 0 })?.photo?.location).toBeUndefined()
  })

  it('converts DMS coordinates with their hemisphere references', () => {
    const location = normalizeExifMetadata({
      GPSLatitude: [33, 51, 54],
      GPSLatitudeRef: 'S',
      GPSLongitude: [151, 12, 36],
      GPSLongitudeRef: 'E',
    })?.photo?.location
    expect(location?.latitude).toBeCloseTo(-(33 + 51 / 60 + 54 / 3600), 6)
    expect(location?.longitude).toBeCloseTo(151 + 12 / 60 + 36 / 3600, 6)
    expect(location?.altitude).toBeUndefined()
  })

  it('applies the below-sea-level altitude reference', () => {
    expect(normalizeExifMetadata({
      latitude: 1,
      longitude: 2,
      GPSAltitude: 20,
      GPSAltitudeRef: 1,
    })?.photo?.location?.altitude).toBe(-20)
    expect(normalizeExifMetadata({
      latitude: 1,
      longitude: 2,
      GPSAltitude: 20,
      GPSAltitudeRef: 0,
    })?.photo?.location?.altitude).toBe(20)
  })

  it('rejects malformed DMS values', () => {
    expect(normalizeExifMetadata({
      GPSLatitude: [33, 61, 0],
      GPSLatitudeRef: 'N',
      GPSLongitude: [151, 0, 0],
      GPSLongitudeRef: 'E',
    })?.photo?.location).toBeUndefined()
    expect(normalizeExifMetadata({
      GPSLatitude: [Number.NaN, 0, 0],
      GPSLongitude: [151, 0, 0],
    })?.photo?.location).toBeUndefined()
  })
})

describe('orientation and thumbnail size math', () => {
  it('scales the longest edge down to 600px without upscaling', () => {
    expect(thumbnailDimensions(4032, 3024)).toEqual({ width: 600, height: 450 })
    expect(thumbnailDimensions(3024, 4032)).toEqual({ width: 450, height: 600 })
    expect(thumbnailDimensions(1000, 333)).toEqual({ width: 600, height: 200 })
    expect(thumbnailDimensions(600, 600)).toEqual({ width: 600, height: 600 })
    expect(thumbnailDimensions(300, 200)).toEqual({ width: 300, height: 200 })
  })

  it('refuses unusable dimensions and bounds', () => {
    expect(thumbnailDimensions(0, 200)).toBeNull()
    expect(thumbnailDimensions(200, Number.NaN)).toBeNull()
    expect(thumbnailDimensions(200, 100, 0)).toBeNull()
  })

  it('keeps only EXIF orientations 1 through 8', () => {
    expect(normalizeOrientation(1)).toBe(1)
    expect(normalizeOrientation(8)).toBe(8)
    expect(normalizeOrientation(0)).toBeUndefined()
    expect(normalizeOrientation(9)).toBeUndefined()
    expect(normalizeOrientation(6.5)).toBeUndefined()
    expect(normalizeOrientation('6')).toBeUndefined()
  })

  it('knows which orientations transpose width and height', () => {
    expect([1, 2, 3, 4].map((value) => orientationSwapsDimensions(value)))
      .toEqual([false, false, false, false])
    expect([5, 6, 7, 8].map((value) => orientationSwapsDimensions(value)))
      .toEqual([true, true, true, true])
    expect(orientationSwapsDimensions(undefined)).toBe(false)
  })

  it('swaps EXIF pixel dimensions for transposed orientations', () => {
    expect(normalizeExifMetadata({
      Orientation: 6,
      PixelXDimension: 4032,
      PixelYDimension: 3024,
    })?.photo).toMatchObject({ width: 3024, height: 4032 })
    expect(normalizeExifMetadata({
      Orientation: 1,
      PixelXDimension: 4032,
      PixelYDimension: 3024,
    })?.photo).toMatchObject({ width: 4032, height: 3024 })
  })
})

describe('prepareMemoAttachment', () => {
  it('returns the optimized original, a 600px JPEG thumbnail and normalized metadata', async () => {
    exifrParse.mockResolvedValue({ Make: 'Apple' })
    const file = imageFile()
    const result = await prepareMemoAttachment(file, { saveMediaMetadata: true })

    expect(result.file).toBe(file)
    expect(result.thumbnail).toBeInstanceOf(File)
    expect(result.thumbnail?.name).toBe('thumbnail.jpg')
    expect(result.thumbnail?.type).toBe('image/jpeg')
    expect(result.metadata).toEqual({
      photo: { width: 1200, height: 800, cameraMake: 'Apple' },
    })
    expect(canvases).toHaveLength(1)
    expect(canvases[0]?.width).toBe(600)
    expect(canvases[0]?.height).toBe(400)
    expect(canvases[0]?.lastOptions).toEqual({ type: 'image/jpeg', quality: 0.82 })
    expect(canvases[0]?.context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 600, 400)
    expect(createImageBitmapMock).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' })
    expect(exifrParse).toHaveBeenCalledWith(file, expect.objectContaining({
      translateValues: false,
      reviveValues: true,
      pick: expect.arrayContaining(['DateTimeOriginal', 'Orientation', 'GPSLatitude']),
    }))
  })

  it('omits metadata entirely when the preference is off', async () => {
    const result = await prepareMemoAttachment(imageFile(), { saveMediaMetadata: false })
    expect(result.metadata).toBeNull()
    expect(result.thumbnail).toBeInstanceOf(File)
    expect(exifrParse).not.toHaveBeenCalled()
  })

  it('falls back to the original file without a thumbnail when HEIC cannot be decoded', async () => {
    createImageBitmapMock.mockRejectedValue(new Error('HEIC is not decodable here'))
    exifrParse.mockResolvedValue({
      DateTimeOriginal: new Date(2024, 4, 1, 10, 20, 30),
      OffsetTimeOriginal: '+08:00',
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const file = imageFile('IMG_0001.HEIC', 'image/heic')
    const result = await prepareMemoAttachment(file, { saveMediaMetadata: true })

    expect(result.file).toBe(file)
    expect(result.thumbnail).toBeNull()
    expect(result.metadata).toEqual({
      photo: {
        width: null,
        height: null,
        captureTime: { local: '2024-05-01T10:20:30', offsetMinutes: 480 },
      },
    })
    expect(info).toHaveBeenCalledWith(
      '[inkstone] Memo thumbnail could not be generated',
      expect.any(Error),
    )
  })

  it('never rejects when both EXIF parsing and thumbnail decoding fail', async () => {
    exifrParse.mockRejectedValue(new Error('unreadable EXIF'))
    createImageBitmapMock.mockRejectedValue(new Error('unsupported image'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const file = imageFile()
    const result = await prepareMemoAttachment(file, { saveMediaMetadata: true })

    expect(result).toEqual({ file, thumbnail: null, metadata: null })
    expect(warn).toHaveBeenCalledWith(
      '[inkstone] Memo photo metadata could not be parsed',
      expect.any(Error),
    )
  })

  it('treats an empty encoded thumbnail as no thumbnail', async () => {
    thumbnailBlob = new Blob([])
    const result = await prepareMemoAttachment(imageFile(), { saveMediaMetadata: true })
    expect(result.thumbnail).toBeNull()
  })

  it('leaves non-raster files untouched', async () => {
    const documentFile = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const vectorFile = new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })

    expect(await prepareMemoAttachment(documentFile, { saveMediaMetadata: true })).toEqual({
      file: documentFile,
      thumbnail: null,
      metadata: null,
    })
    expect(await prepareMemoAttachment(vectorFile, { saveMediaMetadata: true })).toEqual({
      file: vectorFile,
      thumbnail: null,
      metadata: null,
    })
    expect(createImageBitmapMock).not.toHaveBeenCalled()
    expect(exifrParse).not.toHaveBeenCalled()
  })
})
