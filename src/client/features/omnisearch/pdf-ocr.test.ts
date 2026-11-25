import { describe, expect, it, vi } from 'vitest'
import { ocrPdfDocument, terminatePdfOcr } from './pdf-ocr'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  renderPdfPage: vi.fn(),
}))

vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }))
vi.mock('../reading/engine/pdf', () => ({ renderPdfPage: mocks.renderPdfPage }))

describe('PDF OCR worker lifecycle', () => {
  it('uses stable local assets and does not wait forever for a pending initialization', async () => {
    let resolveWorker!: (worker: unknown) => void
    const worker = {
      recognize: vi.fn(async () => ({ data: { text: '' } })),
      terminate: vi.fn(async () => {}),
    }
    mocks.createWorker.mockReturnValue(new Promise((resolve) => { resolveWorker = resolve }))
    mocks.renderPdfPage.mockReturnValue({ task: { promise: Promise.resolve() }, viewport: { width: 10, height: 10 } })
    const document = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 10, height: 10 }),
        render: () => ({ promise: Promise.resolve() }),
      })),
    }

    const recognition = ocrPdfDocument(document as never)
    await expect(terminatePdfOcr()).resolves.toBeUndefined()
    expect(mocks.createWorker).toHaveBeenCalledWith('eng', 1, expect.objectContaining({
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js',
      langPath: '/vendor/tesseract/',
    }))

    resolveWorker(worker)
    await recognition
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce())
  })
})
