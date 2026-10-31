// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { QrCodeApp } from '../src/client/features/tools/qrcode/QrCodeApp'
import { QrSettingsView } from '../src/client/features/tools/qrcode/settings/QrSettingsView'
import { useQrCodeStore, EXPORT_SIZE_MAX } from '../src/client/features/tools/qrcode/store'
import { DEFAULT_QR_OPTIONS } from '../src/client/features/tools/qrcode/engine/qr-engine'
import { useToolsStore } from '../src/client/features/tools/store'
import { fetchQrSettings, updateQrSettings } from '../src/client/features/tools/qrcode/api'

vi.mock('../src/client/features/tools/qrcode/api', () => ({
  fetchQrSettings: vi.fn(),
  updateQrSettings: vi.fn(),
  fetchQrRecords: vi.fn(),
  saveQrRecord: vi.fn(),
  deleteQrRecord: vi.fn(),
  fetchQrTemplates: vi.fn(),
  saveQrTemplate: vi.fn(),
  deleteQrTemplate: vi.fn(),
  uploadQrLogo: vi.fn(),
}))

const SETTINGS = {
  defaultErrorCorrection: 'H' as const,
  defaultSize: 1600,
  defaultFormat: 'webp' as const,
  autoSaveHistory: true,
  updatedAt: 1_700_000_000_000,
}

async function settle(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('QR workbench honours the saved preferences', () => {
  beforeEach(() => {
    installTestGlobals()
    vi.clearAllMocks()
    useToolsStore.setState({ activeSubmodule: 'qrcode', activeQrCodeView: 'generator' })
    useQrCodeStore.setState({
      options: { ...DEFAULT_QR_OPTIONS },
      exportSize: 1000,
      exportFormat: 'png',
      defaultsApplied: false,
    })
  })

  it('applies saved defaults on entry, and only on entry', async () => {
    await initI18n()
    vi.mocked(fetchQrSettings).mockResolvedValue(SETTINGS)

    const first = renderElement(<QrCodeApp />)
    await settle()
    expect(fetchQrSettings).toHaveBeenCalledTimes(1)
    const afterFirst = useQrCodeStore.getState()
    expect(afterFirst.exportSize).toBe(1600)
    expect(afterFirst.exportFormat).toBe('webp')
    expect(afterFirst.options.errorCorrectionLevel).toBe('H')
    first.unmount()

    // A second visit means the reader came back to a workbench they may have retuned, so the saved
    // starting values must not stomp on it and the request itself is not repeated.
    useQrCodeStore.setState({ exportSize: 500, exportFormat: 'png' })
    const second = renderElement(<QrCodeApp />)
    await settle()
    expect(fetchQrSettings).toHaveBeenCalledTimes(1)
    expect(useQrCodeStore.getState().exportSize).toBe(500)
    second.unmount()
  })

  it('keeps the first starting values it is given and ignores any later set', () => {
    useQrCodeStore.getState().applyServerDefaults({ ...SETTINGS, defaultSize: 700, defaultFormat: 'jpeg' })
    expect(useQrCodeStore.getState().exportSize).toBe(700)
    expect(useQrCodeStore.getState().exportFormat).toBe('jpeg')

    useQrCodeStore.getState().applyServerDefaults({ ...SETTINGS, defaultSize: 900, defaultFormat: 'png' })
    expect(useQrCodeStore.getState().exportSize).toBe(700)
    expect(useQrCodeStore.getState().exportFormat).toBe('jpeg')
  })

  it('clamps a saved size that falls outside the slider', async () => {
    await initI18n()
    vi.mocked(fetchQrSettings).mockResolvedValue({ ...SETTINGS, defaultSize: 4000 })

    const view = renderElement(<QrCodeApp />)
    await settle()
    expect(useQrCodeStore.getState().exportSize).toBe(EXPORT_SIZE_MAX)
    view.unmount()
  })

  it('keeps its own correction level when the saved one is not a known value', async () => {
    await initI18n()
    vi.mocked(fetchQrSettings).mockResolvedValue({
      ...SETTINGS,
      defaultErrorCorrection: 'Z' as never,
    })

    const view = renderElement(<QrCodeApp />)
    await settle()
    expect(useQrCodeStore.getState().options.errorCorrectionLevel).toBe(
      DEFAULT_QR_OPTIONS.errorCorrectionLevel
    )
    expect(useQrCodeStore.getState().exportFormat).toBe('webp')
    view.unmount()
  })

  it('refuses to save over preferences it could not read', async () => {
    await initI18n()
    useToolsStore.setState({ activeQrCodeView: 'settings' })
    vi.mocked(fetchQrSettings).mockRejectedValue(new Error('offline'))

    const view = renderElement(<QrSettingsView />)
    await settle()

    expect(view.container.querySelector('[role="alert"]')).not.toBeNull()
    const save = Array.from(view.container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(t('tools.qrcode.settings.save_button'))
    )
    expect(save).toBeUndefined()
    expect(updateQrSettings).not.toHaveBeenCalled()

    vi.mocked(fetchQrSettings).mockResolvedValue(SETTINGS)
    const retry = Array.from(view.container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(t('tools.qrcode.settings.retry'))
    )
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(fetchQrSettings).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    view.unmount()
  })

  it('saves the three defaults without a switch nothing reads', async () => {
    await initI18n()
    useToolsStore.setState({ activeQrCodeView: 'settings' })
    vi.mocked(fetchQrSettings).mockResolvedValue(SETTINGS)
    vi.mocked(updateQrSettings).mockResolvedValue(SETTINGS)

    const view = renderElement(<QrSettingsView />)
    await settle()

    const save = Array.from(view.container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(t('tools.qrcode.settings.save_button'))
    )
    expect(save?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(updateQrSettings).toHaveBeenCalledTimes(1)
    expect(updateQrSettings).toHaveBeenCalledWith({
      defaultErrorCorrection: 'H',
      defaultFormat: 'webp',
      defaultSize: 1600,
    })
    view.unmount()
  })
})
