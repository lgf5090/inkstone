// @vitest-environment jsdom
/**
 * The colour tool, reachable without a mouse.
 *
 * Nine views plus the picker, the copy and the token scale were sidebar-only, which left a keyboard reader
 * and any automation that runs commands outside the module. These tests are the reach: every view has a
 * registered command, and running it lands where the sidebar button would have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COLOR_VIEW_COMMANDS, colorViewCommands, colorViewLabel, copySeedColor, openColorView, openSeedTokenScale, pickSeedFromScreen } from './color-commands'
import { appCommands } from '../command/registry'
import { initI18n, t } from '../../lib/i18n'
import { useToolsStore } from './store'
import { useColorStudioStore } from './color/store'
import { useUi } from '../../store/ui'

vi.mock('./color/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./color/api')>()
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
      addHistory: vi.fn().mockResolvedValue({}),
      listHistory: vi.fn().mockResolvedValue([]),
      listFavorites: vi.fn().mockResolvedValue([]),
      listPalettes: vi.fn().mockResolvedValue([]),
    },
  }
})

const writeText = vi.fn().mockResolvedValue(undefined)
const toastTitles = () => useUi.getState().toasts.map((item) => item.title)

beforeEach(async () => {
  vi.clearAllMocks()
  await initI18n()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  useToolsStore.setState({ activeSubmodule: 'qrcode', activeColorView: 'favorites' })
  useColorStudioStore.setState({
    currentHex: '#336699',
    settings: { stripHash: false, defaultFormat: 'hex', defaultUiTab: 'tailwind', autoSaveHistory: false, updatedAt: 1 },
    isTokenScaleModalOpen: false,
  })
  useUi.setState({ toasts: [] })
  window.history.pushState({}, '', '/notes')
})

describe('view commands', () => {
  it('covers every view of the tool, and no view twice', () => {
    const views = colorViewCommands().map((entry) => entry.view)
    expect(new Set(views).size).toBe(views.length)
    // The list is typed by ColorNavView, so a view that joins the sidebar without a command stops compiling;
    // this is the same check from the other side, for whoever reads the test.
    expect(views).toEqual(Object.keys(COLOR_VIEW_COMMANDS))
    expect(views).toHaveLength(10)
  })

  it.each(colorViewCommands())('registers and runs $id', ({ view, id }) => {
    const command = appCommands().find((entry) => entry.id === id)
    expect(command, `${id} should be in the palette`).toBeTruthy()
    expect(command!.label).toBe(colorViewLabel(view))
    expect(command!.group).toBe(t('tools.color.module_name'))

    command!.run()

    const tools = useToolsStore.getState()
    expect(tools.activeSubmodule).toBe('color')
    expect(tools.activeColorView).toBe(view)
    expect(window.location.pathname).toBe('/tools')
  })

  it('opens the view the function is called with, not the one already showing', () => {
    openColorView('traditional')
    expect(useToolsStore.getState().activeColorView).toBe('traditional')
    openColorView('gradient')
    expect(useToolsStore.getState().activeColorView).toBe('gradient')
  })
})

describe('colour actions', () => {
  it('registers the three actions the sidebar can only reach by clicking', () => {
    const commands = appCommands()
    for (const id of ['cmd-color-copy', 'cmd-color-token-scale', 'cmd-color-eyedropper']) {
      const command = commands.find((entry) => entry.id === id)
      expect(command, `${id} should be in the palette`).toBeTruthy()
      expect(command!.group).toBe(t('tools.color.module_name'))
    }
  })

  it('copies the seed in the format the reader configured', async () => {
    await copySeedColor()
    expect(writeText).toHaveBeenCalledWith('#336699')

    const command = appCommands().find((entry) => entry.id === 'cmd-color-copy')!
    writeText.mockClear()
    command.run()
    // The palette entry returns before the lazily imported store answers, so the run has to be given
    // its turns rather than awaited.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(writeText).toHaveBeenCalledWith('#336699')
  })

  it('opens the token scale of the seed from anywhere', async () => {
    await openSeedTokenScale()
    expect(useColorStudioStore.getState().isTokenScaleModalOpen).toBe(true)
    expect(useToolsStore.getState().activeColorView).toBe('studio')
  })

  it('says so when the browser has no screen picker, instead of doing nothing', async () => {
    Object.defineProperty(window, 'EyeDropper', { value: undefined, configurable: true, writable: true })
    await pickSeedFromScreen()

    expect(toastTitles()).toContain(t('tools.color.studio.eyedropper_unsupported'))
    expect(window.location.pathname).toBe('/notes')
    expect(useColorStudioStore.getState().currentHex).toBe('#336699')
  })

  it('makes the picked colour the studio seed and shows the studio', async () => {
    class FakeDropper {
      open() {
        return Promise.resolve({ sRGBHex: '#c0ffee' })
      }
    }
    Object.defineProperty(window, 'EyeDropper', { value: FakeDropper, configurable: true, writable: true })

    await pickSeedFromScreen()

    expect(useColorStudioStore.getState().currentHex).toBe('#c0ffee')
    expect(useToolsStore.getState().activeColorView).toBe('studio')
    expect(window.location.pathname).toBe('/tools')
  })
})
