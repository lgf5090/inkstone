import { describe, expect, it } from 'vitest'
import { decodeBytes, detectEncoding, looksBinary } from '../src/shared/tools/compare/encoding'

describe('detectEncoding', () => {
  it('reads a UTF-8 byte-order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'utf-8', evidence: 'bom', confident: true })
  })

  it('reads a UTF-16 little-endian mark', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00])
    expect(detectEncoding(bytes).encoding).toBe('utf-16le')
  })

  it('recognises UTF-16 by its null-byte pattern when there is no mark', () => {
    const text = 'abcdefgh'
    const bytes = new Uint8Array(text.length * 2)
    for (let index = 0; index < text.length; index++) {
      bytes[index * 2] = text.charCodeAt(index)
      bytes[index * 2 + 1] = 0
    }
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'utf-16le', evidence: 'utf16' })
  })

  it('falls back to GBK for bytes a strict UTF-8 decoder rejects', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xd6, 0xd0, 0xce, 0xc4])
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'gbk', evidence: 'gbk' })
    expect(decodeBytes(bytes, 'gbk')).toContain('中文')
  })

  it('answers null rather than a guess when nothing decodes', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    expect(detectEncoding(bytes).encoding).toBe(null)
  })

  it('keeps plain ASCII as UTF-8', () => {
    expect(detectEncoding(new TextEncoder().encode('hello\nworld')).encoding).toBe('utf-8')
  })
})

describe('looksBinary', () => {
  it('calls a file full of nulls binary, including a UTF-16 one', () => {
    expect(looksBinary(new Uint8Array([0, 1, 2, 3]))).toBe(true)
    const utf16 = new Uint8Array([0x61, 0, 0x62, 0])
    expect(looksBinary(utf16)).toBe(true)
  })

  it('keeps tabs, newlines and carriage returns as text', () => {
    expect(looksBinary(new TextEncoder().encode('a\tb\r\nc'))).toBe(false)
  })
})
