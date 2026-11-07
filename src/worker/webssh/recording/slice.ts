// Byte-addressed cast slices, shared by the owner's replay API and the public share API. A slice
// never holds more than the caller's limit plus one byte, and only whole lines are returned, so a
// caller walking `nextOffset` can rebuild the whole file without repeating or dropping an event.

import type { WebsshCastEvent, WebsshCastHeader } from '@shared/webssh/types'
import { ApiError } from '../../lib/errors'
import {
  WEBSSH_RECORDING_SLICE_DEFAULT_BYTES,
  WEBSSH_RECORDING_SLICE_MAX_BYTES,
} from '../constants'
import { parseCastLine } from './cast'

export interface CastSlice {
  startOffset: number
  nextOffset: number
  totalSize: number
  complete: boolean
  header?: WebsshCastHeader
  frames: WebsshCastEvent[]
}

function integerQuery(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw ApiError.badRequest('The offset and limit must be non-negative integers')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw ApiError.badRequest('The offset and limit are out of range')
  return parsed
}

/** The offset/limit pair both replay surfaces accept, validated identically. */
export function parseSliceBounds(
  offsetValue: string | undefined,
  limitValue: string | undefined,
): { offset: number; limit: number } {
  const offset = integerQuery(offsetValue, 0)
  const limit = integerQuery(limitValue, WEBSSH_RECORDING_SLICE_DEFAULT_BYTES)
  if (limit < 1 || limit > WEBSSH_RECORDING_SLICE_MAX_BYTES) {
    throw ApiError.badRequest(`The limit must be between 1 and ${WEBSSH_RECORDING_SLICE_MAX_BYTES}`)
  }
  return { offset, limit }
}

/**
 * One slice of the cast at `r2Key`, or `null` when the object is missing. `offset` is a byte offset:
 * a partial line at the start is skipped, `startOffset` is where the first returned line begins, and
 * `nextOffset` is the byte after the last complete line.
 */
export async function readCastSlice(
  bucket: R2Bucket,
  r2Key: string,
  offset: number,
  limit: number,
): Promise<CastSlice | null> {
  const head = await bucket.head(r2Key)
  if (!head) return null
  const totalSize = head.size
  if (offset >= totalSize) {
    return { startOffset: offset, nextOffset: offset, totalSize, complete: true, frames: [] }
  }

  // One byte before the requested offset tells us whether it begins a line; the extra byte is then
  // skipped so it never enters the returned frames.
  const readOffset = offset > 0 ? offset - 1 : 0
  const readLength = Math.min(totalSize - readOffset, limit + (offset > 0 ? 1 : 0))
  const object = await bucket.get(r2Key, { range: { offset: readOffset, length: readLength } })
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  const decoder = new TextDecoder()

  let cursor = 0
  if (offset > 0) {
    if (bytes[0] === 0x0a) {
      cursor = 1
    } else {
      const newline = bytes.indexOf(0x0a)
      if (newline === -1) {
        throw new ApiError(500, 'internal', 'The replay slice starts inside an event larger than the limit')
      }
      cursor = newline + 1
    }
  }
  const startOffset = readOffset + cursor

  let lineStart = cursor
  let lastComplete = cursor
  let header: WebsshCastHeader | undefined
  const frames: WebsshCastEvent[] = []
  for (let index = cursor; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue
    const parsed = parseCastLine(decoder.decode(bytes.subarray(lineStart, index)))
    if (parsed.header) header = parsed.header
    else if (parsed.event) frames.push(parsed.event)
    lastComplete = index + 1
    lineStart = index + 1
  }

  const nextOffset = readOffset + lastComplete
  if (nextOffset === startOffset && nextOffset < totalSize) {
    // No complete line fit in the slice. Answering an unchanged offset would make a caller loop
    // forever, and widening the read would break the bounded-memory promise.
    throw ApiError.badRequest('The limit is too small to include a complete event')
  }
  return {
    startOffset,
    nextOffset,
    totalSize,
    complete: nextOffset >= totalSize,
    ...(header ? { header } : {}),
    frames,
  }
}
