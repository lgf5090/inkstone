// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { IdPhotoSettingsView } from '../src/client/features/tools/id-photo/settings/IdPhotoSettingsView'
import { useIdPhotoStore } from '../src/client/features/tools/id-photo/store'
import type { IdPhotoUserSettings } from '../src/shared/tools/id-photo/types'

const SETTINGS: IdPhotoUserSettings = {
  userId: 'u1',
  defaultSpecId: 'cn_two_inch',
  defaultBgColor: '#438EDB',
  defaultDpi: 300,
  defaultExportFormat: 'png',
  printPaperSize: 'a4',
  updatedAt: 1,
}

function settingsFetch() {
  return vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => Response.json({ ok: true, data: { ...SETTINGS, ...(readBody(init) as object) } }),
  )
}

function readBody(init?: RequestInit) {
  return init?.body ? JSON.parse(String(init.body)) : {}
}

describe('ID photo preferences', () => {
  const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    useIdPhotoStore.setState({
      imageSrc: null,
      selectedSpecId: 'cn_one_inch',
      customSpecs: [],
      adjustOptions: { ...useIdPhotoStore.getState().adjustOptions, specId: 'cn_one_inch', bgColor: '#ffffff' },
      exportFormat: 'jpg',
      printOptions: { ...useIdPhotoStore.getState().printOptions, paperSize: '6inch' },
    })
  })

  it('applies saved preferences to the studio', () => {
    useIdPhotoStore.getState().applyUserSettings(SETTINGS)
    const state = useIdPhotoStore.getState()
    expect(state.selectedSpecId).toBe('cn_two_inch')
    expect(state.adjustOptions.bgColor).toBe('#438EDB')
    expect(state.exportFormat).toBe('png')
    expect(state.printOptions.paperSize).toBe('a4')
  })

  it('keeps a loaded photo untouched by saved preferences', () => {
    useIdPhotoStore.setState({ imageSrc: 'data:image/png;base64,AA' })
    useIdPhotoStore.getState().applyUserSettings(SETTINGS)
    expect(useIdPhotoStore.getState().selectedSpecId).toBe('cn_one_inch')
    expect(useIdPhotoStore.getState().exportFormat).toBe('jpg')
  })

  it('rejects unknown spec ids, colours and formats instead of trusting them', () => {
    useIdPhotoStore.getState().applyUserSettings({
      ...SETTINGS,
      defaultSpecId: 'spec_deleted_long_ago',
      defaultBgColor: 'not-a-colour',
      defaultExportFormat: 'bmp',
      printPaperSize: 'tabloid',
    } as unknown as IdPhotoUserSettings)
    const state = useIdPhotoStore.getState()
    expect(state.selectedSpecId).toBe('cn_one_inch')
    expect(state.adjustOptions.bgColor).toBe('#ffffff')
    expect(state.exportFormat).toBe('jpg')
    expect(state.printOptions.paperSize).toBe('6inch')
  })

  it('saves only the preferences that actually drive the studio', async () => {
    const fetchMock = settingsFetch()
    vi.stubGlobal('fetch', fetchMock)

    const view = await renderElement(<IdPhotoSettingsView />)
    await flush()
    expect(view.container.textContent).toContain(t('tools.id_photo.specs.cn_two_inch_name'))

    expect(view.container.querySelector('[role="switch"]')).toBeNull()

    const saveButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes(t('tools.id_photo.settings.save_btn')),
    )
    expect(saveButton).toBeDefined()

    await act(async () => {
      saveButton?.click()
    })
    await flush()
    expect(fetchMock.mock.calls.filter((call) => String(call[1]?.method) === 'PUT').length).toBe(1)

    const putCall = fetchMock.mock.calls.find((call) => String(call[1]?.method) === 'PUT')
    expect(Object.keys(readBody(putCall?.[1])).sort()).toEqual([
      'defaultBgColor',
      'defaultExportFormat',
      'defaultSpecId',
      'printPaperSize',
    ])
    expect(useIdPhotoStore.getState().printOptions.paperSize).toBe('a4')

    vi.unstubAllGlobals()
    view.unmount()
  })

  it("uses the specification's own size limit as the export target", () => {
    useIdPhotoStore.getState().setSelectedSpecId('exam_postgraduate')
    const limited = useIdPhotoStore.getState().targetMaxKb
    expect(typeof limited).toBe('number')

    useIdPhotoStore.getState().setSelectedSpecId('cn_one_inch')
    expect(useIdPhotoStore.getState().targetMaxKb).toBe(limited)
  })
})
