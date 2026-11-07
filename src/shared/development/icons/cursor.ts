import type { IconSort } from './types'
import { ICON_CURSOR_MAX_LENGTH, ICON_SORTS } from './limits'

export interface IconCursor {
  sort: IconSort
  key: string | number
  id: string
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(text: string): string | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export function encodeIconCursor(cursor: IconCursor): string {
  return encodeBase64Url(JSON.stringify(cursor))
}

export function decodeIconCursor(value: string | null | undefined): IconCursor | null {
  if (!value || value.length > ICON_CURSOR_MAX_LENGTH) return null
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = decodeBase64Url(value)
  if (!decoded) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (!ICON_SORTS.includes(record.sort as IconSort)) return null
  if (typeof record.key !== 'string' && typeof record.key !== 'number') return null
  if (typeof record.key === 'number' && !Number.isFinite(record.key)) return null
  if (typeof record.key === 'string' && record.key.length > 512) return null
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.id)) return null
  return { sort: record.sort as IconSort, key: record.key, id: record.id }
}
