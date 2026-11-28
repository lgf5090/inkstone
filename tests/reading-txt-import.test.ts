// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { decodeBookText, splitTextChapters, textFileToEpub } from '../src/client/features/reading/engine/txt-import'
import { importBook } from '../src/client/features/reading/engine/book-import'

describe('TXT import', () => {
  it('splits Chinese chapter headings and preserves the body', () => {
    const chapters = splitTextChapters('第一章 开始\n第一句\n第二章 继续\n第二句')
    expect(chapters.map((one) => one.title)).toEqual(['第一章 开始', '第二章 继续'])
    expect(chapters[1]?.body).toBe('第二句')
  })

  it('falls back to bounded chapters for prose without headings', () => {
    const chapters = splitTextChapters('x'.repeat(45_000))
    expect(chapters).toHaveLength(3)
    expect(chapters.map((one) => one.body.length)).toEqual([20_000, 20_000, 5_000])
  })

  it('decodes UTF-8 and GB18030', () => {
    expect(decodeBookText(new TextEncoder().encode('你好'))).toBe('你好')
    expect(decodeBookText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe('你好')
  })

  it('turns a text file into an EPUB the existing engine can open', async () => {
    const file = new File(['第一章 开始\n第一句\n第二章 继续\n第二句'], '测试.txt', { type: 'text/plain' })
    const imported = await importBook(file)
    expect(imported.record.format).toBe('epub')
    expect(imported.record.unitCount).toBe(2)
    expect(imported.record.title).toBe('测试')
    expect(imported.record.toc).toHaveLength(2)
  })
})
