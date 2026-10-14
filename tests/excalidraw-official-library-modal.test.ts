import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/lib/api', () => ({
    api: {
        excalidrawLibrary: {
            getManifest: vi.fn(async () => ({ ok: false })),
            saveManifest: vi.fn(async () => ({ ok: true })),
            getOfficialCatalog: vi.fn(async () => ({ ok: true, libraries: [] })),
            downloadOfficialLibrary: vi.fn(async () => ({ ok: true, data: { libraryItems: [] }, filename: 'x.excalidrawlib' })),
            saveFile: vi.fn(async () => ({ ok: true })),
        },
    },
}))

import { api } from '../src/client/lib/api'
import { ExcalidrawLibraryTree } from '../src/client/features/excalidraw/library/ExcalidrawLibraryTree'
import { ExcalidrawOfficialLibraryModal, officialPreviewUrl } from '../src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal'
import { OFFICIAL_WINDOW } from '../src/client/features/excalidraw/library/official-library-window'
import { useExcalidrawLibraryStore } from '../src/client/features/excalidraw/library/library-store'
import type { OfficialLibraryEntry } from '../src/client/features/excalidraw/library/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

const CATALOG_SIZE = 232

function entry(i: number): OfficialLibraryEntry {
    return {
        name: `Library ${i}`,
        description: `Description ${i}`,
        authors: [{ name: `author-${i}` }],
        source: `author-${i}/lib-${i}.excalidrawlib`,
        preview: `author-${i}/lib-${i}.png`,
    }
}

function seedCatalog(count = CATALOG_SIZE, ageMs = 0): void {
    useExcalidrawLibraryStore.setState({
        folders: [],
        items: [],
        officialCatalog: Array.from({ length: count }, (_, i) => entry(i)),
        officialCatalogAt: Date.now() - ageMs,
        officialCatalogLoading: false,
    })
}

let root: Root
let container: HTMLDivElement

function cards(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-official-library-card]')]
}

function tail(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-official-library-more]')
}

async function open(): Promise<void> {
    await act(async () => {
        root.render(createElement(Fragment, null,
            createElement(ExcalidrawOfficialLibraryModal, {
                isOpen: true,
                onClose: () => {},
                targetFolderId: null,
            })))
    })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

function filterInput(): HTMLInputElement {
    const found = container.querySelector<HTMLInputElement>('input[type="search"]')
    if (!found) throw new Error('no filter box in the modal')
    return found
}

beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()
    installTestGlobals()
    await initI18n()
    useExcalidrawLibraryStore.setState({
        officialCatalog: [],
        officialCatalogAt: 0,
        officialCatalogLoading: false,
    })
    container = document.createElement('div')
    // `appendChild`, not `append`: the workers HTMLRewriter `Element` shadows `ParentNode.append`
    // in the types this project compiles against, so only `appendChild` names the DOM call.
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(async () => {
    await act(async () => {
        root.unmount()
    })
    container.remove()
    document.body.innerHTML = ''
})

describe('the official library browser keeps its cost in the window, not in the catalog', () => {
    it('only ever asks the official host for a preview picture', async () => {
        expect(officialPreviewUrl(entry(0))).toBe('https://libraries.excalidraw.com/libraries/author-0/lib-0.png')
        expect(officialPreviewUrl({ ...entry(0), preview: '/author-0/lib-0.png' })).toBe('https://libraries.excalidraw.com/libraries/author-0/lib-0.png')
        expect(officialPreviewUrl({ ...entry(0), preview: 'https://libraries.excalidraw.com/libraries/a/b.png' }))
            .toBe('https://libraries.excalidraw.com/libraries/a/b.png')
        // A catalog entry is third-party data turned into an <img src>, so an absolute url to anywhere
        // else is refused rather than fetched by every reader of this app.
        expect(officialPreviewUrl({ ...entry(0), preview: 'https://tracker.test/a.png' })).toBeNull()
        expect(officialPreviewUrl({ ...entry(0), preview: 'http://libraries.excalidraw.com/a.png' })).toBeNull()
        expect(officialPreviewUrl({ ...entry(0), preview: 'https://libraries.excalidraw.com.evil.test/a.png' })).toBeNull()
        expect(officialPreviewUrl({ ...entry(0), preview: '../../etc/passwd' })).toBe(
            'https://libraries.excalidraw.com/etc/passwd',
        )
        expect(officialPreviewUrl({ ...entry(0), preview: 'javascript:alert(1)' })).toBeNull()
        expect(officialPreviewUrl({ ...entry(0), preview: '' })).toBeNull()
        expect(officialPreviewUrl({ ...entry(0), preview: undefined })).toBeNull()
    })

    it('mounts one screenful of cards, not all 232', async () => {
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: true, libraries: Array.from({ length: CATALOG_SIZE }, (_, i) => entry(i)) })
        seedCatalog(0)
        await open()

        expect(cards()).toHaveLength(OFFICIAL_WINDOW)
        expect(cards()[0].getAttribute('data-official-library-card')).toBe(entry(0).source)
        // The catalog itself is still complete in the store; only the grid is windowed.
        expect(useExcalidrawLibraryStore.getState().officialCatalog).toHaveLength(CATALOG_SIZE)
    })

    it('offers the rest of the catalog through a real button', async () => {
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: true, libraries: Array.from({ length: CATALOG_SIZE }, (_, i) => entry(i)) })
        seedCatalog(0)
        await open()

        const button = tail()
        expect(button).not.toBeNull()
        expect(button?.textContent).toBe(
            t('excalidraw.official_library_show_more', { count: CATALOG_SIZE - OFFICIAL_WINDOW }),
        )

        await act(async () => {
            button?.click()
        })
        expect(cards()).toHaveLength(OFFICIAL_WINDOW * 2)
        expect(tail()).not.toBeNull()

        for (let i = 0; i < 12; i += 1) {
            const next = tail()
            if (!next) break
            await act(async () => {
                next.click()
            })
        }
        expect(cards()).toHaveLength(CATALOG_SIZE)
        expect(tail()).toBeNull()
    })

    it('serves a second open from the cache without blanking the grid', async () => {
        seedCatalog(CATALOG_SIZE)
        await open()

        expect(api.excalidrawLibrary.getOfficialCatalog).not.toHaveBeenCalled()
        expect(cards()).toHaveLength(OFFICIAL_WINDOW)
        expect(container.textContent).not.toContain(t('preview.excalidraw_loading'))
    })

    it('refuses to fetch the catalog twice for one double open', async () => {
        let resolve: (v: { ok: boolean; libraries: OfficialLibraryEntry[] }) => void = () => {}
        ;(api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>).mockImplementation(
            () => new Promise((r) => { resolve = r }),
        )
        seedCatalog(0)

        const first = useExcalidrawLibraryStore.getState().loadOfficialCatalog()
        const second = useExcalidrawLibraryStore.getState().loadOfficialCatalog()
        expect(api.excalidrawLibrary.getOfficialCatalog).toHaveBeenCalledTimes(1)
        resolve({ ok: true, libraries: [entry(0)] })
        const [a, b] = await Promise.all([first, second])
        expect(a).toHaveLength(1)
        expect(b).toHaveLength(1)
    })

    it('keeps the window small when the reader filters, then filters inside it', async () => {
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: true, libraries: Array.from({ length: CATALOG_SIZE }, (_, i) => entry(i)) })
        seedCatalog(0)
        await open()

        await act(async () => {
            tail()?.click()
        })
        expect(cards()).toHaveLength(OFFICIAL_WINDOW * 2)

        await type(filterInput(), 'Library 1')
        // Typing must not leave the whole revealed grid mounted, or every further keystroke pays for
        // it again: the window closes back over the first screenful of whatever the query kept.
        expect(cards().length).toBeLessThanOrEqual(OFFICIAL_WINDOW)
        expect(cards().length).toBeGreaterThan(1)
        expect(cards().every((c) => c.getAttribute('data-official-library-card')?.includes('1'))).toBe(true)
    })

    it('keeps the catalog it already has when a refresh answers nothing', async () => {
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: false, error: 'upstream down', libraries: [] })
        // Two hours old, so the open does revalidate - and the failed revalidation must not eat the grid.
        seedCatalog(CATALOG_SIZE, 2 * 3600_000)
        await open()

        expect(api.excalidrawLibrary.getOfficialCatalog).toHaveBeenCalledTimes(1)
        expect(useExcalidrawLibraryStore.getState().officialCatalog).toHaveLength(CATALOG_SIZE)
        expect(cards()).toHaveLength(OFFICIAL_WINDOW)
        expect(container.textContent).not.toContain(t('preview.excalidraw_loading'))
    })

    it('asks for the catalog while the reader is still looking at the panel', async () => {
        // The whole point of prefetching: the click must not be the moment a cold upstream gets asked.
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: true, libraries: Array.from({ length: CATALOG_SIZE }, (_, i) => entry(i)) })
        seedCatalog(0)
        await act(async () => {
            root.render(createElement(Fragment, null,
                createElement(ExcalidrawLibraryTree, { api: null, lib: {} })))
        })

        expect(api.excalidrawLibrary.getOfficialCatalog).toHaveBeenCalledTimes(1)
        expect(useExcalidrawLibraryStore.getState().officialCatalog).toHaveLength(CATALOG_SIZE)
    })

    it('charges a broken preview one card, not the grid', async () => {
        (api.excalidrawLibrary.getOfficialCatalog as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ ok: true, libraries: Array.from({ length: CATALOG_SIZE }, (_, i) => entry(i)) })
        seedCatalog(0)
        await open()

        const mounted = cards()
        const broken = mounted[2]
        const image = broken.querySelector('img')
        if (!image) throw new Error('card has no preview image')
        expect(image.getAttribute('loading')).toBe('lazy')
        expect(image.getAttribute('src')).toBe('https://libraries.excalidraw.com/libraries/author-2/lib-2.png')

        await act(async () => {
            image.dispatchEvent(new Event('error'))
        })

        expect(broken.querySelector('img')).toBeNull()
        expect(mounted.filter((c) => c !== broken && c.querySelector('img'))).toHaveLength(OFFICIAL_WINDOW - 1)
        // The failure must not disturb the window either: no extra page, no lost tail.
        expect(cards()).toHaveLength(OFFICIAL_WINDOW)
        expect(tail()).not.toBeNull()
    })
})
