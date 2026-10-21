import type { MemoAttachment } from '@shared/memos/types'
import { t } from '../../lib/i18n'

export function isMediaAttachment(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('image/') || attachment.mime.startsWith('video/')
}

export function isImageAttachment(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('image/') && !attachment.mime.startsWith('image/svg')
}

export function isVideoAttachment(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('video/')
}

export function isAudioAttachment(attachment: MemoAttachment): boolean {
  return attachment.mime.startsWith('audio/')
}

export function isDocumentAttachment(attachment: MemoAttachment): boolean {
  return !isMediaAttachment(attachment) && !isAudioAttachment(attachment)
}

export function motionVideoUrl(attachment: MemoAttachment): string | null {
  if (attachment.motion?.role !== 'still') return null
  return `${attachment.url}${attachment.url.includes('?') ? '&' : '?'}motion=1`
}

export function attachmentDimensions(attachment: MemoAttachment): { width?: number; height?: number } {
  const width = positiveNumber(attachment.width) ?? positiveNumber(attachment.mediaMetadata?.photo?.width)
  const height = positiveNumber(attachment.height) ?? positiveNumber(attachment.mediaMetadata?.photo?.height)
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  }
}

export function mediaMetadataLines(attachment: MemoAttachment): string[] {
  const lines: string[] = []
  const photo = attachment.mediaMetadata?.photo
  if (photo) {
    const captured = photo.captureTime?.local.trim()
    if (captured) lines.push(t('memos.media.captured_at', { time: captured.replace('T', ' ') }))
    const camera = [photo.cameraMake?.trim(), photo.cameraModel?.trim()].filter(Boolean).join(' ')
    if (camera) lines.push(camera)
    const lens = photo.lensModel?.trim()
    if (lens) lines.push(lens)
    const settings = [
      photo.focalLengthMm === undefined ? '' : `${formatDecimal(photo.focalLengthMm)} mm`,
      photo.fNumber === undefined ? '' : `f/${formatDecimal(photo.fNumber)}`,
      photo.exposureTimeSeconds === undefined ? '' : formatExposure(photo.exposureTimeSeconds),
      photo.iso === undefined ? '' : `ISO ${Math.round(photo.iso)}`,
    ].filter(Boolean)
    if (settings.length > 0) lines.push(settings.join(' · '))
  }
  const duration = attachment.mediaMetadata?.video?.durationSeconds
  if (duration !== undefined) {
    const text = formatMediaDuration(duration)
    if (text) lines.push(t('memos.media.video_duration', { duration: text }))
  }
  return lines
}

export function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(remainder)}`
  return `${minutes}:${pad(remainder)}`
}

function formatExposure(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds >= 1) return `${formatDecimal(seconds)} s`
  return `1/${Math.round(1 / seconds)} s`
}

function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) return ''
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
