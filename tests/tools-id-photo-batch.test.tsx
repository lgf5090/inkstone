// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoBatchView } from '../src/client/features/tools/id-photo/batch/IdPhotoBatchView'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'

const exportBlob = vi.hoisted(() => vi.fn())
const downloadZip = vi.hoisted(() => vi.fn())

vi.mock('../src/client/features/tools/id-photo/engine/id-photo-engine', () => ({
  IdPhotoEngine: class {
    exportBlob(...args: unknown[]) {
      exportBlob(...args)
      return Promise.resolve(new Blob(['photo'], { type: 'image/jpeg' }))
    }
  },
}))

vi.mock('client-zip', () => ({
  downloadZip,
}))

let createObjectURLSpy: ReturnType<typeof vi.fn>
let revokeObjectURLSpy: ReturnType<typeof vi.fn>

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

function filesOf(entries: Array<[string, string]>) {
  return entries.map(([name, type]) => new File(['data'], name, { type }))
}

async function addThroughInput(view: { container: HTMLElement }, files: File[]) {
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ID photo batch view', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    exportBlob.mockClear()
    downloadZip.mockImplementation(() => ({ blob: async () => new Blob(['zip']) }))
    useIdPhotoStore.setState({ targetMaxKb: 40, exportFormat: 'jpg' })
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', FakeImage)
    createObjectURLSpy = vi.fn(() => 'blob:mock')
    revokeObjectURLSpy = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURLSpy, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURLSpy, configurable: true, writable: true })
  })

  afterEach(() => {
    delete (URL as Partial<typeof URL>).createObjectURL
    delete (URL as Partial<typeof URL>).revokeObjectURL
    vi.unstubAllGlobals()
  })

  it('adds the images and reports the files it skipped', async () => {
    const view = await renderElement(<IdPhotoBatchView />)
    await addThroughInput(view, filesOf([['a.jpg', 'image/jpeg'], ['b.png', 'image/png'], ['notes.pdf', 'application/pdf']]))
    await flush()

    expect(view.container.querySelectorAll('img[alt]').length).toBe(2)
    expect(view.container.textContent).toContain(t('tools.id_photo.batch.items_count', { count: 2 }))

    view.unmount()
  })

  it('releases the object url when a photo is removed', async () => {
    const view = await renderElement(<IdPhotoBatchView />)
    await addThroughInput(view, filesOf([['a.jpg', 'image/jpeg']]))
    await flush()

    const remove = view.container.querySelector(
      `button[aria-label^="${t('tools.id_photo.common.delete')}"]`,
    ) as HTMLButtonElement | null
    expect(remove).not.toBeNull()
    await act(async () => {
      remove.click()
    })

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock')
    expect(view.container.querySelectorAll('img[alt]').length).toBe(0)

    view.unmount()
  })

  it('honours the shared target size while exporting a batch', async () => {
    const view = await renderElement(<IdPhotoBatchView />)
    await addThroughInput(view, filesOf([['a.jpg', 'image/jpeg'], ['a.png', 'image/png']]))
    await flush()

    const exportButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes(t('tools.id_photo.batch.export_zip')),
    ) as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    expect(exportBlob.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(exportBlob.mock.calls[0][2]).toBe(40)
    const entries = downloadZip.mock.calls[0][0] as Array<{ name: string }>
    expect(entries.map((entry) => entry.name)).toEqual([
      'a-cn_one_inch.jpg',
      'a-cn_one_inch-2.jpg',
    ])

    view.unmount()
  })
})
