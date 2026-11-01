// @vitest-environment jsdom
/**
 * A saved colour is not write-once.
 *
 * The name, tags, note and order columns were in the table from the first migration, the update endpoints
 * were written, and nothing in the interface could reach any of them — so a colour saved from a swatch was
 * stuck with the label that button happened to send, in creation order, forever.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserColorFavorite, UserColorPalette } from '@shared/tools/color/types'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { ConfirmHost } from '../../../components/overlay'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { colorApi } from './api'
import { FavoritesView } from './views/FavoritesView'
import { useUi } from '../../../store/ui'

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
      updateFavorite: vi.fn().mockResolvedValue(null),
      updatePalette: vi.fn(),
      reorderFavorites: vi.fn().mockResolvedValue([]),
      reorderPalettes: vi.fn().mockResolvedValue([]),
      deleteFavorite: vi.fn().mockResolvedValue({ ok: true }),
      deletePalette: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
})

let rendered: RenderedElement | null = null

/** What the API doubles answer for the lists, so the update doubles can return a plausible row. */
let favoritesSeed: UserColorFavorite[] = []
let palettesSeed: UserColorPalette[] = []

const listFavorites = vi.mocked(colorApi.listFavorites)
const listPalettes = vi.mocked(colorApi.listPalettes)
const updateFavorite = vi.mocked(colorApi.updateFavorite)
const reorderFavorites = vi.mocked(colorApi.reorderFavorites)
const reorderPalettes = vi.mocked(colorApi.reorderPalettes)

// Read inside the test: at module scope the locale is not loaded yet, and every one of these would be a key.
const EDIT = () => t('tools.color.edit.action')
const UP = () => t('tools.color.edit.move_up')
const DOWN = () => t('tools.color.edit.move_down')
const SAVE = () => t('tools.color.edit.save')

function favorite(id: string, hex: string, name: string, tags: string[] = [], note = ''): UserColorFavorite {
  return {
    id,
    name,
    hex,
    rgb: { r: 10, g: 20, b: 30 },
    tags,
    note,
    sort: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function palette(id: string, title: string, tags: string[] = [], description = ''): UserColorPalette {
  return {
    id,
    title,
    colors: [{ hex: '#112233' }],
    sourceType: 'custom',
    description,
    tags,
    likesCount: 0,
    previewSvg: '',
    isFavorite: false,
    sort: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Every control carrying that accessible name, in document order. */
function byLabel(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === label)
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  )
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  return Array.from(document.querySelectorAll('input')).find(
    (node) => node.getAttribute('placeholder') === placeholder,
  )!
}

function typeValue(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = node instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  setter?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush(times = 4): Promise<void> {
  for (let attempt = 0; attempt < times; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
  }
}

async function mount(): Promise<void> {
  rendered = renderElement(createElement('div', null, createElement(ConfirmHost), createElement(FavoritesView)))
  await flush()
}

const toastTitles = () => useUi.getState().toasts.map((item) => item.title)

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  await initI18n()
  favoritesSeed = [
    favorite('fav_a001', '#22aa33', 'First', ['primary']),
    favorite('fav_b002', '#334455', 'Second'),
    favorite('fav_c003', '#445566', 'Third'),
  ]
  listFavorites.mockImplementation(async () => favoritesSeed)
  palettesSeed = [palette('pal_a001', 'Dusk', ['night'], 'evening work'), palette('pal_b002', 'Dawn')]
  listPalettes.mockImplementation(async () => palettesSeed)
  updateFavorite.mockImplementation(async (id, patch) => ({
    ...favoritesSeed.find((f) => f.id === id)!,
    ...patch,
  }))
  reorderFavorites.mockImplementation(async (ids) =>
    ids.map((id, index) => ({ ...favorite(id, '#000000', id), sort: index })),
  )
  vi.mocked(colorApi.updatePalette).mockImplementation(async (id, patch) => ({
    ...palettesSeed.find((pal) => pal.id === id)!,
    ...patch,
  }))
  reorderPalettes.mockImplementation(async (ids) =>
    ids.map((id, index) => ({ ...palette(id, id), sort: index })),
  )
  act(() => {
    useUi.setState({ toasts: [] })
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
      editingFavoriteId: null,
      editingPaletteId: null,
    })
  })
})

describe('editing a saved colour', () => {
  it('opens on the row that was asked for, with its own text', async () => {
    await mount()


    const editors = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === EDIT())
    expect(editors).toHaveLength(3)
    await act(async () => {
      editors[1]!.click()
    })
    await flush()

    expect(inputByPlaceholder(t('tools.color.edit.name_placeholder')).value).toBe('Second')
    expect(document.body.textContent).toContain('#334455')

    // Closing and opening another row is the case that used to keep the first row's text in the boxes.
    await act(async () => {
      buttonByLabel(t('tools.color.common.cancel'))!.click()
      await flush(2)
    })
    const again = byLabel(EDIT())
    await act(async () => {
      again[2]!.click()
      await flush(2)
    })
    expect(inputByPlaceholder(t('tools.color.edit.name_placeholder')).value).toBe('Third')
    expect(inputByPlaceholder(t('tools.color.edit.tags_placeholder')).value).toBe('')
  })

  it('sends the edited name, tags and note and keeps the answer', async () => {
    await mount()
    const editors = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === EDIT())
    await act(async () => {
      editors[0]!.click()
    })
    await flush()

    typeValue(inputByPlaceholder(t('tools.color.edit.name_placeholder')), '  Renamed  ')
    typeValue(inputByPlaceholder(t('tools.color.edit.tags_placeholder')), 'hero, accent ,')
    const note = document.querySelector('textarea')!
    typeValue(note, 'used on the call-to-action')

    const save = buttonByLabel(SAVE())!
    await act(async () => {
      save.click()
      await flush(2)
    })

    expect(updateFavorite).toHaveBeenCalledWith('fav_a001', {
      name: 'Renamed',
      note: 'used on the call-to-action',
      tags: ['hero', 'accent'],
    })
    expect(useColorStudioStore.getState().favorites[0]!.name).toBe('Renamed')
    expect(useColorStudioStore.getState().editingFavoriteId).toBeNull()
    expect(toastTitles()).toContain(t('tools.color.toast.favorite_updated'))
  })

  it('keeps the dialog and the text when the server refuses', async () => {
    updateFavorite.mockRejectedValueOnce(new Error('nope'))
    await mount()
    const editors = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === EDIT())
    await act(async () => {
      editors[0]!.click()
    })
    await flush()

    const nameInput = inputByPlaceholder(t('tools.color.edit.name_placeholder'))
    typeValue(nameInput, 'Half written')
    await act(async () => {
      buttonByLabel(SAVE())!.click()
      await flush(2)
    })

    // The reader must be able to fix the row, not retype it: closing on failure would lose the draft.
    expect(useColorStudioStore.getState().editingFavoriteId).toBe('fav_a001')
    expect(inputByPlaceholder(t('tools.color.edit.name_placeholder')).value).toBe('Half written')
    expect(toastTitles()).toContain('nope')
  })
})

describe('ordering the collection', () => {
  it('paints the new order before the answer arrives', async () => {
    // A reorder that waits for the server before it repaints looks, at network speed, like the click was
    // ignored — so the move has to be visible while the request is still out.
    let release: (rows: UserColorFavorite[]) => void = () => {}
    reorderFavorites.mockImplementationOnce(
      () => new Promise<UserColorFavorite[]>((resolve) => { release = resolve }),
    )
    await mount()
    const before = useColorStudioStore.getState().favorites.map((f) => f.id)

    await act(async () => {
      byLabel(DOWN())[0]!.click()
    })
    expect(useColorStudioStore.getState().favorites.map((f) => f.id)).not.toEqual(before)
    expect(useColorStudioStore.getState().favorites.map((f) => f.id)).toEqual([
      'fav_b002',
      'fav_a001',
      'fav_c003',
    ])

    const held = useColorStudioStore.getState().favorites.map((f) => f.id)
    act(() => {
      release(
        (['fav_c003', 'fav_b002', 'fav_a001'] as string[]).map(
          (id, index) => ({ ...favorite(id, '#000000', id), sort: index }),
        ),
      )
    })
    await flush(2)
    // The server's order wins over the optimistic one, since it is the one that was written.
    expect(useColorStudioStore.getState().favorites.map((f) => f.id)).toEqual([
      'fav_c003',
      'fav_b002',
      'fav_a001',
    ])
    expect(held).not.toEqual(useColorStudioStore.getState().favorites.map((f) => f.id))
  })

  it('moves a colour down at once and saves the whole order once', async () => {
    await mount()

    const downs = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === DOWN())
    await act(async () => {
      downs[0]!.click()
      await flush(2)
    })

    expect(reorderFavorites).toHaveBeenCalledTimes(1)
    expect(reorderFavorites.mock.calls[0]![0]).toEqual(['fav_b002', 'fav_a001', 'fav_c003'])
    expect(useColorStudioStore.getState().favorites.map((f) => f.id)).toEqual([
      'fav_b002',
      'fav_a001',
      'fav_c003',
    ])
  })

  it('puts the list back and says so when the order cannot be saved', async () => {
    reorderFavorites.mockRejectedValueOnce(new Error('offline'))
    await mount()

    const before = useColorStudioStore.getState().favorites.map((f) => f.id)
    const downs = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === DOWN())
    await act(async () => {
      downs[0]!.click()
      await flush(2)
    })

    expect(useColorStudioStore.getState().favorites.map((f) => f.id)).toEqual(before)
    expect(toastTitles()).toContain(t('tools.color.toast.order_save_failed'))
  })

  it('refuses to move the first row up or the last row down', async () => {
    await mount()

    const ups = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === UP())
    const downs = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === DOWN())
    expect(ups[0]!.disabled).toBe(true)
    expect(downs[downs.length - 1]!.disabled).toBe(true)
    // The middle row can go either way, so the ends are the only inert controls.
    expect(ups[1]!.disabled).toBe(false)
    expect(downs[1]!.disabled).toBe(false)
  })

  it('orders palettes through the same one-request rule', async () => {
    await mount()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await flush(2)
    })

    const downs = Array.from(document.querySelectorAll('button')).filter((node) => node.getAttribute('aria-label') === DOWN())
    await act(async () => {
      downs[0]!.click()
      await flush(2)
    })

    expect(reorderPalettes).toHaveBeenCalledTimes(1)
    expect(reorderPalettes.mock.calls[0]![0]).toEqual(['pal_b002', 'pal_a001'])
  })
})

describe('editing a palette', () => {
  it('sends a renamed palette and refuses to save an empty title', async () => {
    await mount()
    await act(async () => {
      switchSubTab(t('tools.color.favorites.tab_palettes'))
      await flush(2)
    })

    const editors = byLabel(EDIT())
    expect(editors).toHaveLength(2)
    await act(async () => {
      editors[0]!.click()
      await flush(2)
    })

    const title = inputByPlaceholder(t('tools.color.create_palette.placeholder'))
    expect(title.value).toBe('Dusk')
    const save = buttonByLabel(SAVE())!
    expect(save.disabled).toBe(false)

    typeValue(title, '   ')
    await flush(1)
    // The server wants a title; a blank one is a disabled button rather than a 400 toast.
    expect(buttonByLabel(SAVE())!.disabled).toBe(true)

    typeValue(title, 'Dusk revised')
    await flush(1)
    const filled = buttonByLabel(SAVE())!
    await act(async () => {
      filled.click()
      await flush(2)
    })

    expect(colorApi.updatePalette).toHaveBeenCalledWith('pal_a001', {
      title: 'Dusk revised',
      description: 'evening work',
      tags: ['night'],
    })
    expect(useColorStudioStore.getState().editingPaletteId).toBeNull()
    expect(toastTitles()).toContain(t('tools.color.toast.palette_updated'))
  })
})

function switchSubTab(labelFragment: string): void {
  const tab = Array.from(document.querySelectorAll('button, [role="radio"]')).find((node) =>
    (node.textContent ?? '').includes(labelFragment),
  )
  tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
