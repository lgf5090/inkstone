import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createWorker, type Worker } from 'tesseract.js'
import { renderPdfPage } from '../reading/engine/pdf'
import { registerPdfOcrTerminator } from './pdf-ocr-state'

const OCR_VENDOR_BASE = '/vendor/tesseract/'
const OCR_PAGES_MAX = 3
const OCR_SCALE = 1.5
const OCR_TEXT_CHARS_MAX = 30_000

let workerPromise: Promise<Worker> | null = null
let activeWorker: Worker | null = null

function ocrWorker(): Promise<Worker> {
  if (!workerPromise) {
    const pending: Promise<Worker> = createWorker('eng', 1, {
      workerPath: `${OCR_VENDOR_BASE}worker.min.js`,
      corePath: `${OCR_VENDOR_BASE}tesseract-core-relaxedsimd-lstm.wasm.js`,
      langPath: OCR_VENDOR_BASE,
      gzip: true,
      errorHandler: (error) => console.warn('[inkstone] PDF OCR worker error:', error),
    }).then((worker) => {
      if (workerPromise === pending) activeWorker = worker
      return worker
    }).catch((error: unknown) => {
      if (workerPromise === pending) workerPromise = null
      throw error
    })
    workerPromise = pending
  }
  return workerPromise
}

export async function ocrPdfDocument(document: PDFDocumentProxy): Promise<string> {
  const worker = await ocrWorker()
  const parts: string[] = []
  let length = 0
  const pages = Math.min(document.numPages, OCR_PAGES_MAX)
  for (let pageNumber = 1; pageNumber <= pages && length < OCR_TEXT_CHARS_MAX; pageNumber++) {
    const page = await document.getPage(pageNumber)
    const canvas = window.document.createElement('canvas')
    const rendered = renderPdfPage(page, canvas, OCR_SCALE)
    try {
      await rendered.task.promise
      const result = await worker.recognize(canvas)
      const text = result.data.text.trim()
      if (!text) continue
      const part = text.slice(0, OCR_TEXT_CHARS_MAX - length)
      parts.push(part)
      length += part.length
    }
    finally {
      canvas.width = 0
      canvas.height = 0
    }
  }
  return parts.join('\n')
}

export async function terminatePdfOcr(): Promise<void> {
  const pending = workerPromise
  const worker = activeWorker
  workerPromise = null
  activeWorker = null
  if (worker) {
    await worker.terminate()
    return
  }
  if (!pending) return
  void pending.then((created) => created.terminate()).catch((error: unknown) => {
    console.warn('[inkstone] PDF OCR worker shutdown failed:', error)
  })
}

registerPdfOcrTerminator(terminatePdfOcr)
