// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shareOrDownload } from './share'

const mocks = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
vi.mock('../export-note', () => ({ downloadBlob: mocks.downloadBlob }))

function installShare(share?: (data: ShareData) => Promise<void>, canShare?: (data?: ShareData) => boolean): void {
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })
}

afterEach(() => {
  mocks.downloadBlob.mockReset()
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'canShare')
})

describe('shareOrDownload', () => {
  it('downloads when the platform has no share sheet', async () => {
    const blob = new Blob(['x'], { type: 'application/pdf' })
    await expect(shareOrDownload(blob, 'note.pdf')).resolves.toBe('downloaded')
    expect(mocks.downloadBlob).toHaveBeenCalledWith('note.pdf', blob)
  })

  it('downloads when files cannot be shared', async () => {
    installShare(vi.fn(), () => false)
    await expect(shareOrDownload(new Blob(['x']), 'note.pdf')).resolves.toBe('downloaded')
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1)
  })

  it('shares a File and reports success without downloading', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    installShare(share, () => true)
    const blob = new Blob(['x'], { type: 'application/pdf' })
    await expect(shareOrDownload(blob, 'note.pdf')).resolves.toBe('shared')
    expect(mocks.downloadBlob).not.toHaveBeenCalled()
    const data = share.mock.calls[0]![0] as ShareData
    expect(data.files).toHaveLength(1)
    expect(data.files![0]!.name).toBe('note.pdf')
    expect(data.files![0]!.type).toBe('application/pdf')
  })

  it('treats a cancelled share as shared and never downloads', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    installShare(vi.fn().mockRejectedValue(abort), () => true)
    await expect(shareOrDownload(new Blob(['x']), 'note.pdf')).resolves.toBe('shared')
    expect(mocks.downloadBlob).not.toHaveBeenCalled()
  })

  it('falls back to download when sharing fails for another reason', async () => {
    installShare(vi.fn().mockRejectedValue(new Error('denied')), () => true)
    await expect(shareOrDownload(new Blob(['x']), 'note.pdf')).resolves.toBe('downloaded')
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1)
  })

  it('falls back when canShare itself throws', async () => {
    installShare(vi.fn(), () => { throw new Error('unsupported') })
    await expect(shareOrDownload(new Blob(['x']), 'note.pdf')).resolves.toBe('downloaded')
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1)
  })

  it('downloads when share exists but canShare is missing', async () => {
    installShare(vi.fn(), undefined)
    await expect(shareOrDownload(new Blob(['x']), 'note.pdf')).resolves.toBe('downloaded')
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1)
  })
})
