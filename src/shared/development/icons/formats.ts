import type { IconFormat } from './types'

/**
 * The upload MIME whitelist.
 *
 * Anything else — including a ZIP — has no storage path in this module: v1 accepts one icon per
 * request, so there is no archive to unpack and no place for a ZIP bomb to enter.
 */
export const ICON_UPLOAD_MIME_TYPES: Readonly<Record<string, IconFormat>> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function iconFormatFromMime(mime: string): IconFormat | null {
  return ICON_UPLOAD_MIME_TYPES[mime.toLowerCase()] ?? null
}
