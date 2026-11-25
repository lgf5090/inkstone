import { truncateText } from '@shared/text-utils'
import type { FileSource } from './document'

const PDF_BYTES_MAX = 8 * 1024 * 1024
const PDF_PAGES_MAX = 40
const PDF_TEXT_CHARS_MAX = 100_000
const PDF_FETCH_TIMEOUT_MS = 15_000
const PDF_OCR_TIMEOUT_MS = 90_000
const PDF_OCR_MIN_TEXT_CHARS = 32

export async function attachPdfText(source: FileSource, options: { ocr?: boolean } = {}): Promise<FileSource> {
  if (!isPdf(source) || source.size > PDF_BYTES_MAX) return source
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(source.id)}`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`PDF fetch failed with HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > PDF_BYTES_MAX) return source
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > PDF_BYTES_MAX) return source
    const { openPdfDocument, readPdfPageText } = await import('../reading/engine/pdf')
    const opened = await openPdfDocument(bytes)
    try {
      const pages = Math.min(opened.document.numPages, PDF_PAGES_MAX)
      const parts: string[] = []
      let length = 0
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        const page = await opened.document.getPage(pageNumber)
        const text = (await readPdfPageText(page)).text.trim()
        if (!text) continue
        const remaining = PDF_TEXT_CHARS_MAX - length
        if (remaining <= 0) break
        const part = text.slice(0, remaining)
        parts.push(part)
        length += part.length
      }
      let text = parts.join('\n')
      if (options.ocr && text.trim().length < PDF_OCR_MIN_TEXT_CHARS) {
        let timer = 0
        try {
          const { ocrPdfDocument } = await import('./pdf-ocr')
          const recognized = await Promise.race([
            ocrPdfDocument(opened.document),
            new Promise<never>((_resolve, reject) => {
              timer = window.setTimeout(() => reject(new Error('PDF OCR timed out')), PDF_OCR_TIMEOUT_MS)
            }),
          ])
          window.clearTimeout(timer)
          if (recognized.trim()) text = `${text}\n${recognized}`.trim()
        }
        catch (error) {
          console.warn('[inkstone] PDF OCR skipped:', source.filename, error)
          const { terminatePdfOcr } = await import('./pdf-ocr')
          await terminatePdfOcr().catch((cause: unknown) => console.warn('[inkstone] PDF OCR worker shutdown failed:', cause))
        }
        finally {
          window.clearTimeout(timer)
        }
      }
      return { ...source, text: truncateText(text, PDF_TEXT_CHARS_MAX) }
    }
    finally {
      await opened.destroy()
    }
  }
  catch (error) {
    console.warn('[inkstone] PDF text indexing skipped:', source.filename, error)
    return source
  }
}

function isPdf(source: FileSource): boolean {
  return source.mime.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(source.filename)
}
