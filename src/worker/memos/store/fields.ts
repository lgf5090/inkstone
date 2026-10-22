import { MEMO_CONTENT_MAX_BYTES } from '@shared/memos/constants'
import {
  MEMO_STATES,
  MEMO_VISIBILITIES,
  type MemoLocation,
  type MemoState,
  type MemoVisibility,
} from '@shared/memos/types'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'

export function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('content must be a string')
  if (utf8ByteLength(value) > MEMO_CONTENT_MAX_BYTES) {
    throw ApiError.tooLarge(`Memo content exceeds the ${MEMO_CONTENT_MAX_BYTES / 1_000_000} MB limit`)
  }
  return value
}

export function parseVisibility(value: unknown): MemoVisibility {
  if (typeof value !== 'string' || !(MEMO_VISIBILITIES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('visibility must be private, protected, or public')
  }
  return value as MemoVisibility
}

export function parseState(value: unknown): MemoState {
  if (typeof value !== 'string' || !(MEMO_STATES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('state must be normal or archived')
  }
  return value as MemoState
}

export function parseId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidId(value)) {
    throw ApiError.badRequest(`${field} must be a memo id`)
  }
  return value
}

export function parseNullableId(value: unknown, field: string): string | null {
  if (value === null) return null
  return parseId(value, field)
}

export function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of ids`)
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidId(entry)) {
      throw ApiError.badRequest(`${field} must contain memo ids`)
    }
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

export function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  }
  return value
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

export function parseRev(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  return value
}

export function parseLocation(value: unknown): MemoLocation | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('location must be an object or null')
  }
  const record = value as Record<string, unknown>
  if (typeof record.placeholder !== 'string') {
    throw ApiError.badRequest('location.placeholder must be a string')
  }
  if (
    typeof record.latitude !== 'number'
    || !Number.isFinite(record.latitude)
    || record.latitude < -90
    || record.latitude > 90
  ) {
    throw ApiError.badRequest('location.latitude must be between -90 and 90')
  }
  if (
    typeof record.longitude !== 'number'
    || !Number.isFinite(record.longitude)
    || record.longitude < -180
    || record.longitude > 180
  ) {
    throw ApiError.badRequest('location.longitude must be between -180 and 180')
  }
  return {
    placeholder: record.placeholder,
    latitude: record.latitude,
    longitude: record.longitude,
  }
}
