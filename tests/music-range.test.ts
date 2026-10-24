// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { contentDisposition, parseByteRange } from '../src/worker/lib/http-range'

describe('http range parsing', () => {
  it('reads open, bounded and suffix ranges', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('clamps an end beyond the object and refuses impossible ranges', () => {
    expect(parseByteRange('bytes=900-2000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseByteRange('bytes=9-2', 1000)).toBe('invalid')
    expect(parseByteRange('items=0-1', 1000)).toBeNull()
  })

  it('encodes a safe content disposition', () => {
    expect(contentDisposition('audio/mpeg', 'A B.mp3')).toContain('inline')
    expect(contentDisposition('audio/mpeg', 'A B.mp3')).toContain('filename*=UTF-8')
    expect(contentDisposition('application/pdf', 'A B.pdf')).toContain('attachment')
  })
})
