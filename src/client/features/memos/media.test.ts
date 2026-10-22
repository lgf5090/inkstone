import { beforeAll, describe, expect, it } from 'vitest'
import type { MemoAttachment } from '@shared/memos/types'
import { initI18n } from '../../lib/i18n'
import {
  attachmentDimensions,
  formatMediaDuration,
  isAudioAttachment,
  isDocumentAttachment,
  isImageAttachment,
  isMediaAttachment,
  isVideoAttachment,
  mediaMetadataLines,
  motionVideoUrl,
} from './media'

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  return {
    id: 'attachment-1',
    filename: 'photo.jpg',
    mime: 'image/jpeg',
    size: 1024,
    width: 1200,
    height: 800,
    url: '/api/memos/files/attachment-1',
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

beforeAll(async () => {
  await initI18n()
})

describe('attachment media classification', () => {
  it('separates displayable images from SVG and documents', () => {
    expect(isImageAttachment(attachment())).toBe(true)
    expect(isMediaAttachment(attachment())).toBe(true)
    expect(isImageAttachment(attachment({ mime: 'image/svg+xml' }))).toBe(false)
    expect(isMediaAttachment(attachment({ mime: 'image/svg+xml' }))).toBe(true)
    expect(isDocumentAttachment(attachment({ mime: 'image/svg+xml' }))).toBe(false)
    expect(isDocumentAttachment(attachment({ mime: 'application/pdf' }))).toBe(true)
    expect(isAudioAttachment(attachment({ mime: 'audio/mpeg' }))).toBe(true)
    expect(isVideoAttachment(attachment({ mime: 'video/mp4' }))).toBe(true)
    expect(isDocumentAttachment(attachment({ mime: 'audio/mpeg' }))).toBe(false)
  })

  it('derives image dimensions from the attachment and then its metadata', () => {
    expect(attachmentDimensions(attachment())).toEqual({ width: 1200, height: 800 })
    expect(attachmentDimensions(attachment({
      width: null,
      height: null,
      mediaMetadata: { photo: { width: 640, height: 480 } },
    }))).toEqual({ width: 640, height: 480 })
    expect(attachmentDimensions(attachment({ width: 0, height: 800 }))).toEqual({ height: 800 })
  })
})

describe('motion photos', () => {
  it('derives the motion video URL only for a still', () => {
    expect(motionVideoUrl(attachment())).toBeNull()
    expect(motionVideoUrl(attachment({ motion: { groupId: 'group-1', role: 'still' } })))
      .toBe('/api/memos/files/attachment-1?motion=1')
    expect(motionVideoUrl(attachment({ motion: { groupId: 'group-1', role: 'video' } }))).toBeNull()
    expect(motionVideoUrl(attachment({
      url: '/api/memos/files/attachment-1?share=token',
      motion: { groupId: 'group-1', role: 'still' },
    }))).toBe('/api/memos/files/attachment-1?share=token&motion=1')
  })
})

describe('media metadata lines', () => {
  it('prints capture time, camera, lens, exposure settings and video duration', () => {
    const lines = mediaMetadataLines(attachment({
      mediaMetadata: {
        photo: {
          width: 1200,
          height: 800,
          captureTime: { local: '2024-05-01 10:20:30', offsetMinutes: 480 },
          cameraMake: 'Apple',
          cameraModel: 'iPhone 15 Pro',
          lensModel: 'Main Camera 24mm',
          fNumber: 1.8,
          exposureTimeSeconds: 1 / 120,
          iso: 100,
          focalLengthMm: 24,
        },
        video: { durationSeconds: 65 },
      },
    }))
    expect(lines).toEqual([
      'Captured 2024-05-01 10:20:30',
      'Apple iPhone 15 Pro',
      'Main Camera 24mm',
      '24 mm · f/1.8 · 1/120 s · ISO 100',
      'Duration 1:05',
    ])
  })

  it('stays empty when no media metadata is present', () => {
    expect(mediaMetadataLines(attachment())).toEqual([])
  })

  it('formats whole and fractional shutter speeds', () => {
    const lines = mediaMetadataLines(attachment({
      mediaMetadata: {
        photo: { width: null, height: null, exposureTimeSeconds: 2 },
      },
    }))
    expect(lines).toEqual(['2 s'])
    const fractional = mediaMetadataLines(attachment({
      mediaMetadata: {
        photo: { width: null, height: null, exposureTimeSeconds: 0.5 },
      },
    }))
    expect(fractional).toEqual(['1/2 s'])
  })
})

describe('formatMediaDuration', () => {
  it('formats minutes and hours, and refuses nonsense', () => {
    expect(formatMediaDuration(0)).toBe('0:00')
    expect(formatMediaDuration(65)).toBe('1:05')
    expect(formatMediaDuration(3725)).toBe('1:02:05')
    expect(formatMediaDuration(-1)).toBe('')
    expect(formatMediaDuration(Number.NaN)).toBe('')
  })
})
