import { describe, expect, it, vi } from 'vitest'
import { registerPdfOcrTerminator, terminatePdfOcrIfLoaded } from './pdf-ocr-state'

describe('PDF OCR shutdown', () => {
  it('keeps the loaded module registered for later worker sessions', async () => {
    const terminate = vi.fn(async () => {})
    registerPdfOcrTerminator(terminate)

    await terminatePdfOcrIfLoaded()
    await terminatePdfOcrIfLoaded()

    expect(terminate).toHaveBeenCalledTimes(2)
  })
})
