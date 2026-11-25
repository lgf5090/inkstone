import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachPdfText } from './pdf-text'
import type { FileSource } from './document'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  pageText: vi.fn(),
  destroy: vi.fn(async () => {}),
  ocr: vi.fn(async () => 'Recognized scan text'),
  terminateOcr: vi.fn(async () => {}),
}))

vi.mock('../reading/engine/pdf', () => ({
  openPdfDocument: mocks.open,
  readPdfPageText: mocks.pageText,
}))
vi.mock('./pdf-ocr', () => ({
  ocrPdfDocument: mocks.ocr,
  terminatePdfOcr: mocks.terminateOcr,
}))

const source: FileSource = {
  id: 'file-1',
  filename: 'manual.pdf',
  noteId: 'note-1',
  updatedAt: 1,
  size: 1024,
  mime: 'application/pdf',
}

beforeEach(() => {
  mocks.open.mockReset().mockResolvedValue({
    document: { numPages: 2, getPage: vi.fn(async (number: number) => ({ number })) },
    destroy: mocks.destroy,
  })
  mocks.pageText.mockReset().mockImplementation(async (page: { number: number }) => ({ text: `Page ${page.number} searchable text` }))
  mocks.ocr.mockClear()
  mocks.terminateOcr.mockClear()
  mocks.destroy.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'application/pdf', 'content-length': '3' },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PDF text indexing', () => {
  it('adds bounded page text and destroys the PDF document', async () => {
    const result = await attachPdfText(source)
    expect(result.text).toBe('Page 1 searchable text\nPage 2 searchable text')
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('leaves oversized and non-PDF attachments on the filename-only path', async () => {
    const oversized = { ...source, size: 9 * 1024 * 1024 }
    const image = { ...source, filename: 'image.png', mime: 'image/png' }
    expect(await attachPdfText(oversized)).toBe(oversized)
    expect(await attachPdfText(image)).toBe(image)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('runs local OCR only when explicitly enabled and the text layer is empty', async () => {
    mocks.pageText.mockResolvedValue({ text: '' })
    expect((await attachPdfText(source)).text).toBe('')
    expect(mocks.ocr).not.toHaveBeenCalled()

    const result = await attachPdfText(source, { ocr: true })
    expect(result.text).toBe('Recognized scan text')
    expect(mocks.ocr).toHaveBeenCalledOnce()
    expect(mocks.destroy).toHaveBeenCalledTimes(2)
  })

  it('keeps filename indexing when fetch or PDF parsing fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })))
    expect(await attachPdfText(source)).toBe(source)
    expect(warning).toHaveBeenCalled()
  })
})
