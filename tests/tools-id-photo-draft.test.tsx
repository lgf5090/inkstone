// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoApp } from '../src/client/features/tools/id-photo/IdPhotoApp'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import { useToolsStore } from '../src/client/features/tools/store'
import {
  clearDraft,
  draftSource,
  loadDraft,
  readDraftMeta,
  saveDraft,
} from '../src/client/features/tools/id-photo/draft-store'

const DATA_SRC = 'data:image/jpeg;base64,/9j/AAEI'

class FakeRequest {
  result: unknown = undefined
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null

  succeed(result: unknown): void {
    this.result = result
    this.onsuccess?.()
  }
}

class FakeDb {
  stores = new Map<string, Map<string, Record<string, unknown>>>()
  closed = false

  get objectStoreNames() {
    return { contains: (name: string) => this.stores.has(name) }
  }

  createObjectStore(name: string): void {
    this.stores.set(name, new Map())
  }

  transaction(name: string) {
    const rows = this.stores.get(name) ?? new Map<string, Record<string, unknown>>()
    this.stores.set(name, rows)
    const objectStore = {
      put: (value: Record<string, unknown>) => {
        const request = new FakeRequest()
        queueMicrotask(() => {
          rows.set(String(value.id), value)
          request.succeed(undefined)
        })
        return request
      },
      get: (key: string) => {
        const request = new FakeRequest()
        queueMicrotask(() => request.succeed(rows.get(key)))
        return request
      },
      delete: (key: string) => {
        const request = new FakeRequest()
        queueMicrotask(() => {
          rows.delete(key)
          request.succeed(undefined)
        })
        return request
      },
    }
    return { objectStore: () => objectStore }
  }

  close(): void {
    this.closed = true
  }
}

function installFakeIndexedDb(): FakeDb {
  const db = new FakeDb()
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: { result?: FakeDb; onupgradeneeded?: (() => void) | null; onsuccess?: (() => void) | null } = {}
      queueMicrotask(() => {
        request.result = db
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  })
  return db
}

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 900
  naturalHeight = 1200
  width = 900
  height = 1200

  set src(_value: string) {
    // A microtask keeps the decode independent of the draft debounce timer under fake clocks.
    queueMicrotask(() => this.onload?.())
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

describe('ID photo local draft', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    localStorage.clear()
    vi.stubGlobal('Image', FakeImage)
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({ activeSubmodule: 'id_photo', idPhotoModuleExpanded: true, activeIdPhotoView: 'studio' })
    useIdPhotoStore.setState({
      imageSrc: null,
      originalImageSrc: null,
      imageElement: null,
      workingSize: null,
      sourceSize: null,
      customSpecs: [],
      selectedSpecId: 'cn_one_inch',
      draftMeta: null,
      draftStatus: 'idle',
      adjustOptions: { ...useIdPhotoStore.getState().adjustOptions, brightness: 0, cropX: undefined, cropY: undefined, cropWidth: undefined, cropHeight: undefined },
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: [] })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('only treats an inline source as draft material', () => {
    expect(draftSource(DATA_SRC)).toBe(DATA_SRC)
    expect(draftSource('blob:object-url')).toBeNull()
    expect(draftSource('/api/tools/id-photo/records/1/file')).toBeNull()
    expect(draftSource(null)).toBeNull()
  })

  it('round-trips the photo, the specification and the adjustments', async () => {
    installFakeIndexedDb()
    const saved = await saveDraft({ src: DATA_SRC, specId: 'cn_two_inch', options: { brightness: 12 } as never })
    expect(saved.ok).toBe(true)

    const meta = readDraftMeta()
    expect(meta?.specId).toBe('cn_two_inch')
    expect(meta?.bytes).toBe(Math.round(DATA_SRC.length * 0.75))

    const draft = await loadDraft()
    expect(draft?.src).toBe(DATA_SRC)
    expect(draft?.specId).toBe('cn_two_inch')
    expect(draft?.options.brightness).toBe(12)

    await clearDraft()
    expect(readDraftMeta()).toBeNull()
    expect(await loadDraft()).toBeNull()
  })

  it('refuses a photo above the cap and keeps the previous draft readable', async () => {
    installFakeIndexedDb()
    await saveDraft({ src: DATA_SRC, specId: 'cn_one_inch', options: {} as never })
    const before = readDraftMeta()
    expect(before).not.toBeNull()

    const tooLarge = { src: 'data:image/jpeg;base64,' + 'A'.repeat(12_000_001), specId: 'cn_one_inch', options: {} as never }
    expect(await saveDraft(tooLarge)).toEqual({ ok: false, reason: 'too_large' })
    expect(readDraftMeta()).toEqual(before)
  })

  it('autosaves once the studio settles and reports the state', async () => {
    installFakeIndexedDb()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await act(async () => {
      await useIdPhotoStore.getState().setImageSrc(DATA_SRC)
    })
    expect(useIdPhotoStore.getState().draftStatus).toBe('pending')

    act(() => {
      useIdPhotoStore.getState().setAdjustOptions({ brightness: 20 })
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(useIdPhotoStore.getState().draftStatus).toBe('saved')
    expect(readDraftMeta()).not.toBeNull()
    const draft = await loadDraft()
    expect(draft?.options.brightness).toBe(20)
  })

  it('does not queue another write once the photo is gone', async () => {
    installFakeIndexedDb()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      await useIdPhotoStore.getState().setImageSrc(DATA_SRC)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(useIdPhotoStore.getState().draftStatus).toBe('saved')

    await act(async () => {
      await useIdPhotoStore.getState().setImageSrc(null)
    })
    expect(useIdPhotoStore.getState().draftStatus).toBe('idle')
    const writesBefore = localStorage.length
    await act(async () => {
      vi.advanceTimersByTime(4000)
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(localStorage.length).toBe(writesBefore)
    expect(readDraftMeta()).not.toBeNull()
  })

  it('restores the draft with its specification and framing', async () => {
    installFakeIndexedDb()
    await saveDraft({ src: DATA_SRC, specId: 'cn_two_inch', options: { brightness: 15, cropX: 10, cropY: 20, cropWidth: 300, cropHeight: 450 } as never })

    let restored = false
    await act(async () => {
      restored = await useIdPhotoStore.getState().restoreDraft()
    })
    expect(restored).toBe(true)
    const state = useIdPhotoStore.getState()
    expect(state.imageSrc).toBe(DATA_SRC)
    expect(state.selectedSpecId).toBe('cn_two_inch')
    expect(state.adjustOptions.brightness).toBe(15)
    expect(state.adjustOptions.cropX).toBe(10)
  })

  it('keeps the current specification when the drafted one was deleted', async () => {
    installFakeIndexedDb()
    await saveDraft({ src: DATA_SRC, specId: 'spec_deleted', options: { brightness: 8 } as never })

    await act(async () => {
      expect(await useIdPhotoStore.getState().restoreDraft()).toBe(true)
    })
    expect(useIdPhotoStore.getState().selectedSpecId).toBe('cn_one_inch')
    expect(useIdPhotoStore.getState().adjustOptions.brightness).toBe(8)
  })

  it('keeps one account\'s draft away from the next one on the same browser', async () => {
    installFakeIndexedDb()
    await saveDraft({ src: DATA_SRC, specId: 'cn_two_inch', options: { brightness: 30 } as never, scope: 'user-a' })

    expect(readDraftMeta('user-a')).not.toBeNull()
    expect(readDraftMeta('user-b')).toBeNull()
    expect(await loadDraft('user-b')).toBeNull()
    expect((await loadDraft('user-a'))?.options.brightness).toBe(30)

    // Clearing the second account\'s draft must leave the first one intact.
    await clearDraft('user-b')
    expect(await loadDraft('user-a')).not.toBeNull()
    await clearDraft('user-a')
    expect(await loadDraft('user-a')).toBeNull()
  })

  it('says the draft is device-only and offers restore before a photo is loaded', async () => {
    installFakeIndexedDb()
    await saveDraft({ src: DATA_SRC, specId: 'cn_two_inch', options: {} as never })

    const view = await renderElement(<IdPhotoApp />)
    await settle()

    const notice = view.container.querySelector('[data-draft-notice]')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain(t('tools.id_photo.draft.restorable'))
    expect(notice?.textContent).toContain(t('tools.id_photo.draft.local_only'))
    const buttons = [...(notice?.querySelectorAll('button') ?? [])].map((button) => button.textContent)
    expect(buttons).toContain(t('tools.id_photo.draft.restore'))
    expect(buttons).toContain(t('tools.id_photo.draft.clear'))
    view.unmount()
  })

  it('disappears when there is neither a photo nor a draft', async () => {
    installFakeIndexedDb()
    const view = await renderElement(<IdPhotoApp />)
    await settle()
    expect(view.container.querySelector('[data-draft-notice]')).toBeNull()
    view.unmount()
  })

  it('names the reason when local storage refuses the write', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: { error: Error; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void; result: never } = {
          error: new Error('denied'),
          result: undefined as never,
        }
        queueMicrotask(() => request.onerror?.())
        return request
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      await useIdPhotoStore.getState().setImageSrc(DATA_SRC)
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(useIdPhotoStore.getState().draftStatus).toBe('failed')
    expect(readDraftMeta()).toBeNull()
  })

  it('drops both halves of the draft when the user clears it', async () => {
    installFakeIndexedDb()
    const db = await loadDraft()
    expect(db).toBeNull()
    await saveDraft({ src: DATA_SRC, specId: 'cn_two_inch', options: {} as never })
    expect(readDraftMeta()).not.toBeNull()

    await act(async () => {
      await useIdPhotoStore.getState().clearDraft()
    })
    expect(readDraftMeta()).toBeNull()
    expect(await loadDraft()).toBeFalsy()
    expect(useIdPhotoStore.getState().draftStatus).toBe('idle')
    expect(useIdPhotoStore.getState().draftMeta).toBeNull()
  })
})
