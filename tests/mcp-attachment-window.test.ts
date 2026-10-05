import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_READ_DEFAULT_BYTES,
  ATTACHMENT_READ_MAX_BYTES,
  ATTACHMENT_READ_MIN_BYTES,
  attachmentReadWindow,
} from '../src/worker/mcp/library'

const MEBIBYTE = 1024 * 1024

describe('attachmentReadWindow', () => {
  it('steps a 25 MB object through 256 KiB ranged reads', () => {
    const size = 25 * MEBIBYTE
    let cursor = 0
    let reads = 0
    while (cursor < size) {
      const window = attachmentReadWindow(size, cursor)
      expect(window.length).toBeGreaterThan(0)
      expect(window.length).toBeLessThanOrEqual(ATTACHMENT_READ_DEFAULT_BYTES)
      cursor = window.end
      reads++
    }
    expect(cursor).toBe(size)
    expect(reads).toBe(Math.ceil(size / ATTACHMENT_READ_DEFAULT_BYTES))
  })

  it('clamps the request into the supported band', () => {
    expect(attachmentReadWindow(10 * MEBIBYTE, 0, 10).length).toBe(ATTACHMENT_READ_MIN_BYTES)
    expect(attachmentReadWindow(10 * MEBIBYTE, 0, 100 * MEBIBYTE).length).toBe(ATTACHMENT_READ_MAX_BYTES)
    expect(attachmentReadWindow(10 * MEBIBYTE, 0, undefined).length).toBe(ATTACHMENT_READ_DEFAULT_BYTES)
  })

  it('reads nothing past the end of the object', () => {
    const window = attachmentReadWindow(1000, 1000, MEBIBYTE)
    expect(window).toEqual({ start: 1000, end: 1000, length: 0 })
    expect(attachmentReadWindow(0, 0)).toMatchObject({ start: 0, end: 0, length: 0 })
  })

  it('shortens the final chunk instead of over-reading', () => {
    const window = attachmentReadWindow(300_000, 262_144)
    expect(window.end).toBe(300_000)
    expect(window.length).toBe(300_000 - 262_144)
  })
})
