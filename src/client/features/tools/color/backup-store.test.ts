// @vitest-environment jsdom
/**
 * Restoring is not a delete in reverse.
 *
 * The same file may be handed back twice — a reader restoring onto a half-finished restore — so the rows
 * that are already there have to be counted as skipped rather than as an error, and the panel has to end up
 * showing what the server holds rather than what the file claimed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildColorBackup } from '@shared/tools/color/backup'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { initI18n, t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { colorApi } from './api'
import { triggerDownload } from './lib/export-engine'
import { useColorStudioStore } from './store'

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
      listFavorites: vi.fn().mockResolvedValue([]),
      listPalettes: vi.fn().mockResolvedValue([]),
      listHistory: vi.fn().mockResolvedValue([]),
      createFavorite: vi.fn().mockResolvedValue({ id: 'fav_a001', hex: '#22aa33' }),
      createPalette: vi.fn().mockResolvedValue({ id: 'pal_a001', title: 'Dusk', colors: [] }),
    },
  }
})
vi.mock('./lib/export-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/export-engine')>()
  return { ...actual, triggerDownload: vi.fn() }
})

const createFavorite = vi.mocked(colorApi.createFavorite)
const createPalette = vi.mocked(colorApi.createPalette)
const listFavorites = vi.mocked(colorApi.listFavorites)
const listPalettes = vi.mocked(colorApi.listPalettes)

const file = buildColorBackup({
  favorites: [
    { id: 'fav_a001', hex: '#22aa33', name: 'Fern', tags: ['primary'], note: 'buttons', sort: 0 },
    { id: 'fav_b002', hex: '#334455', name: 'Slate', tags: [], note: '', sort: 1 },
  ],
  palettes: [
    {
      id: 'pal_a001',
      title: 'Dusk',
      colors: [{ hex: '#0f172a' }],
      sourceType: 'custom',
      description: 'evening',
      tags: ['night'],
      isFavorite: false,
      sort: 0,
    },
  ],
})

const toastTitles = () => useUi.getState().toasts.map((item) => item.title)

beforeEach(async () => {
  vi.clearAllMocks()
  await initI18n()
  createFavorite.mockResolvedValue({ id: 'fav_a001', hex: '#22aa33' } as never)
  createPalette.mockResolvedValue({ id: 'pal_a001', title: 'Dusk', colors: [] } as never)
  listFavorites.mockResolvedValue([])
  listPalettes.mockResolvedValue([])
  useUi.setState({ toasts: [] })
  useColorStudioStore.setState({
    currentHex: '#627486',
    colorSpaceValues: getColorSpaceValues('#627486'),
    favorites: [],
    palettes: [],
  })
})

describe('import', () => {
  it('sends each row with the id it came with, so a second restore skips rather than duplicates', async () => {
    const result = await useColorStudioStore.getState().importBackup(file)

    expect(createFavorite.mock.calls.map((call) => call[0].id)).toEqual(['fav_a001', 'fav_b002'])
    expect(createFavorite.mock.calls[0]![0]).toEqual({
      id: 'fav_a001',
      hex: '#22aa33',
      name: 'Fern',
      tags: ['primary'],
      note: 'buttons',
    })
    expect(createPalette).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ favorites: 2, palettes: 1, skipped: 0 })
  })

  it('counts a refused row as skipped and carries on', async () => {
    createFavorite.mockRejectedValueOnce(new Error('That color id is already saved'))

    const result = await useColorStudioStore.getState().importBackup(file)

    expect(result).toEqual({ favorites: 1, palettes: 1, skipped: 1 })
    expect(createFavorite).toHaveBeenCalledTimes(2)
  })

  it('ends by reading the server back, not by trusting the file', async () => {
    await useColorStudioStore.getState().importBackup(file)

    expect(listFavorites).toHaveBeenCalled()
    expect(listPalettes).toHaveBeenCalled()
  })

  it('refuses a file that is not a backup before writing anything', async () => {
    await expect(useColorStudioStore.getState().importBackup('{"hello":"world"}')).rejects.toThrow(
      t('tools.color.backup.rejected'),
    )
    expect(createFavorite).not.toHaveBeenCalled()
    expect(createPalette).not.toHaveBeenCalled()
  })
})

describe('export', () => {
  it('writes the loaded collection to a dated file and reports what went into it', () => {
    useColorStudioStore.setState({
      favorites: [
        { id: 'fav_a001', hex: '#22aa33', name: 'Fern', rgb: { r: 34, g: 170, b: 51 }, tags: [], note: '', sort: 0, createdAt: 1, updatedAt: 1 },
      ],
      palettes: [
        {
          id: 'pal_a001',
          title: 'Dusk',
          colors: [{ hex: '#0f172a' }],
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
      ],
    })

    useColorStudioStore.getState().exportBackup()

    const [body, name, mime] = vi.mocked(triggerDownload).mock.calls[0]!
    expect(mime).toBe('application/json')
    expect(String(name)).toMatch(/^inkstone-colors-\d{4}-\d{2}-\d{2}\.json$/)
    const written = JSON.parse(String(body)) as { favorites: unknown[]; palettes: unknown[] }
    expect(written.favorites).toHaveLength(1)
    expect(written.palettes).toHaveLength(1)
    expect(toastTitles()).toContain(t('tools.color.backup.exported', { favorites: 1, palettes: 1 }))
  })
})
