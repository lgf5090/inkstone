// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildPdf, type PdfPageImage } from './pdf-writer'

/** A real 1x1 RGB JPEG, so the DCT stream is well formed even though tests never rasterize it. */
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q=='
const JPEG = Uint8Array.from(Buffer.from(JPEG_BASE64, 'base64'))

function page(overrides: Partial<PdfPageImage> = {}): PdfPageImage {
  return { width: 200, height: 100, jpeg: JPEG, ...overrides }
}

async function open(blob: Blob): Promise<{ pdf: PDFDocumentProxy; destroy: () => Promise<void> }> {
  const data = new Uint8Array(await blob.arrayBuffer())
  const task = getDocument({ data, useWorkerFetch: false })
  return { pdf: await task.promise, destroy: () => task.destroy() }
}

describe('buildPdf', () => {
  it('writes a two-page PDF with the requested MediaBox proportions', async () => {
    const blob = buildPdf([
      page({ pdfWidth: 600, pdfHeight: 300 }),
      page({ width: 50, height: 200, pdfWidth: undefined, pdfHeight: undefined }),
    ])
    expect(blob.type).toBe('application/pdf')
    expect(new TextDecoder().decode(await blob.slice(0, 8).arrayBuffer())).toBe('%PDF-1.4')

    const { pdf, destroy } = await open(blob)
    expect(pdf.numPages).toBe(2)
    const first = await pdf.getPage(1)
    const second = await pdf.getPage(2)
    const firstViewport = first.getViewport({ scale: 1 })
    const secondViewport = second.getViewport({ scale: 1 })
    expect(firstViewport.width).toBeCloseTo(600)
    expect(firstViewport.height).toBeCloseTo(300)
    expect(firstViewport.width / firstViewport.height).toBeCloseTo(2)
    expect(secondViewport.width).toBeCloseTo(50)
    expect(secondViewport.height).toBeCloseTo(200)
    await destroy()
  })

  it('accepts document-wide MediaBox defaults', async () => {
    const { pdf, destroy } = await open(buildPdf([page()], { pdfWidth: 306, pdfHeight: 396 }))
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 })
    expect(viewport.width).toBeCloseTo(306)
    expect(viewport.height).toBeCloseTo(396)
    await destroy()
  })

  it('writes a valid zero-page PDF', async () => {
    const { pdf, destroy } = await open(buildPdf([]))
    expect(pdf.numPages).toBe(0)
    await destroy()
  })

  it('rejects malformed page input with a specific error', () => {
    expect(() => buildPdf([page({ jpeg: new Uint8Array() })])).toThrow(/non-empty JPEG/)
    expect(() => buildPdf([page({ width: 0 })])).toThrow(/width/)
    expect(() => buildPdf([page({ height: Number.NaN })])).toThrow(/height/)
    expect(() => buildPdf([page({ pdfWidth: -1 })])).toThrow(/pdfWidth/)
    expect(() => buildPdf([], { pdfHeight: Number.POSITIVE_INFINITY })).toThrow(/pdfHeight/)
  })
})
