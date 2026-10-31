// @vitest-environment jsdom
/**
 * The three states the collection panels owe the reader.
 *
 * `FavoritesView` rendered its empty state from `list.length === 0` alone, so a request that failed and a
 * reader who has never saved a colour produced the same screen — a "nothing saved yet" line over a network
 * error reads as "my colours are gone", and the obvious next move is to save the same hex a second time.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { ConfirmHost } from '../../../components/overlay'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { FavoritesView } from './views/FavoritesView'
import { colorApi } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    colorApi: {
      ...actual.colorApi,
      getSettings: vi.fn().mockResolvedValue({
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'tailwind',
        autoSaveHistory: false,
        updatedAt: 1,
      }),
      listHistory: vi.fn().mockResolvedValue([]),
      listFavorites: vi.fn().mockResolvedValue([]),
      listPalettes: vi.fn().mockResolvedValue([]),
      deleteFavorite: vi.fn().mockResolvedValue({ ok: true }),
      deletePalette: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
})

let rendered: RenderedElement | null = null

const listFavorites = vi.mocked(colorApi.listFavorites)
const listPalettes = vi.mocked(colorApi.listPalettes)
const deleteFavorite = vi.mocked(colorApi.deleteFavorite)

function mountView(): RenderedElement {
  return renderElement(createElement('div', null, createElement(ConfirmHost), createElement(FavoritesView)))
}

function textInPanel(): string {
  return document.body.textContent ?? ''
}

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  listFavorites.mockResolvedValue([])
  listPalettes.mockResolvedValue([])
  await initI18n()
  useColorStudioStore.setState({
    currentHex: '#627486',
    colorSpaceValues: getColorSpaceValues('#627486'),
    favorites: [],
    palettes: [],
    history: [],
    isLoadingFavorites: false,
    isLoadingPalettes: false,
    favoritesLoadFailed: false,
    palettesLoadFailed: false,
    isCreatePaletteModalOpen: false,
  })
})

describe('collection loading', () => {
  it('shows a loading line instead of an empty collection while the request is in flight', async () => {
    // A promise that never settles is the in-flight state: the panel must not fall through to "nothing yet".
    listFavorites.mockReturnValue(new Promise(() => {}))
    rendered = mountView()
    await act(async () => {
      await Promise.resolve()
    })

    expect(textInPanel()).toContain(t('tools.color.favorites.loading'))
    expect(textInPanel()).not.toContain(t('tools.color.favorites.empty'))
  })

  it('names the failure and offers the same fetch again when the list cannot be read', async () => {
    listFavorites.mockRejectedValueOnce(new Error('offline'))
    rendered = mountView()
    await act(async () => {
      await Promise.resolve()
    })

    expect(textInPanel()).toContain(t('tools.color.favorites.load_failed'))
    expect(textInPanel()).not.toContain(t('tools.color.favorites.empty'))

    listFavorites.mockResolvedValue([
      { id: 'f1', hex: '#22aa33', rgb: { r: 34, g: 170, b: 51 }, name: '', tags: [], note: '', sort: 0, createdAt: 1, updatedAt: 1 },
    ])
    const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(t('common.retry')))!
    await act(async () => {
      retry.click()
    })

    expect(listFavorites).toHaveBeenCalledTimes(2)
    expect(textInPanel()).toContain('#22aa33')
    expect(textInPanel()).not.toContain(t('tools.color.favorites.load_failed'))
  })

  it('keeps a failed palette list apart from an empty one', async () => {
    listPalettes.mockRejectedValueOnce(new Error('offline'))
    rendered = mountView()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await Promise.resolve()
    })

    expect(textInPanel()).toContain(t('tools.color.favorites.load_failed'))
    expect(textInPanel()).not.toContain(t('tools.color.favorites.empty_palettes'))
  })

  it('offers the create action where the empty palette list said nothing', async () => {
    rendered = mountView()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await Promise.resolve()
    })

    expect(emptyLines()).toContain(t('tools.color.favorites.empty_palettes'))
    // The shared "no favorites yet" line must not stand in for the palette tab any more.
    expect(emptyLines()).not.toContain(t('tools.color.favorites.empty'))

    const create = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(t('tools.color.create_palette.title')),
    )!
    await act(async () => {
      create.click()
    })
    expect(useColorStudioStore.getState().isCreatePaletteModalOpen).toBe(true)
  })
})

describe('destructive actions', () => {
  it('asks before deleting the only copy of a saved colour', async () => {
    listFavorites.mockResolvedValue([
      { id: 'f1', hex: '#22aa33', rgb: { r: 34, g: 170, b: 51 }, name: '', tags: [], note: '', sort: 0, createdAt: 1, updatedAt: 1 },
      { id: 'f2', hex: '#334455', rgb: { r: 51, g: 68, b: 85 }, name: '', tags: [], note: '', sort: 0, createdAt: 1, updatedAt: 1 },
    ])
    rendered = mountView()
    await act(async () => {
      await Promise.resolve()
    })

    const remove = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === t('tools.color.common.delete'),
    )!
    await act(async () => {
      remove.click()
    })
    // Single click must only open the question.
    expect(deleteFavorite).not.toHaveBeenCalled()
    expect(textInPanel()).toContain(t('tools.color.favorites.confirm_delete_favorite_title'))

    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === t('tools.color.common.delete'),
    )!
    await act(async () => {
      confirm.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(deleteFavorite).toHaveBeenCalledWith('f1')
  })

  it('leaves the palette untouched when the reader cancels', async () => {
    listPalettes.mockResolvedValue([
      {
        id: 'p1',
        title: 'Dusk',
        colors: [{ hex: '#101010', ratio: 1 }],
        sourceType: 'custom',
        description: '',
        tags: [],
        likesCount: 0,
        previewSvg: '',
        isFavorite: false,
        sort: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    rendered = mountView()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await Promise.resolve()
    })

    const remove = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === t('tools.color.favorites.delete_palette'),
    )!
    await act(async () => {
      remove.click()
    })
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === t('common.cancel'),
    )!
    await act(async () => {
      cancel.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(vi.mocked(colorApi.deletePalette)).not.toHaveBeenCalled()
    expect(useColorStudioStore.getState().palettes).toHaveLength(1)
  })
})

describe('palette preview strip', () => {
  it('gives a gradient palette its stop widths back', async () => {
    listPalettes.mockResolvedValue([
      {
        id: 'p1',
        title: 'Dusk',
        colors: [
          { hex: '#101010', ratio: 3 },
          { hex: '#202020', ratio: 1 },
        ],
        sourceType: 'custom',
        description: '',
        tags: [],
        likesCount: 0,
        previewSvg: '',
        isFavorite: false,
        sort: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    rendered = mountView()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await Promise.resolve()
    })

    const strip = Array.from(document.querySelectorAll<HTMLButtonElement>('button[title^="#"]'))
    expect(strip).toHaveLength(2)
    expect(strip[0]!.style.flexGrow).toBe('3')
    expect(strip[1]!.style.flexGrow).toBe('1')
  })
})

/** The short lines a panel offers when it has nothing to show — not the whole body text. */
function emptyLines(): string[] {
  return Array.from(document.querySelectorAll('p')).map((node) => node.textContent?.trim() ?? '')
}

function switchSubTab(labelFragment: string): void {
  const tab = Array.from(document.querySelectorAll('button, [role="radio"]')).find((node) =>
    (node.textContent ?? '').includes(labelFragment.replace(/\s*\(\d+\)$/, '')),
  )
  tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
