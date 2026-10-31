// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import {
  installTestGlobals,
  renderElement,
  type RenderedElement,
} from '../src/client/lib/test-render'
import { QrCodeApp } from '../src/client/features/tools/qrcode/QrCodeApp'
import { useQrCodeStore, encodeQrData } from '../src/client/features/tools/qrcode/store'
import { useToolsStore } from '../src/client/features/tools/store'
import { QrEngine, DEFAULT_QR_OPTIONS } from '../src/client/features/tools/qrcode/engine/qr-engine'

// A view that fails partway never reaches its unmount call, and a mounted workbench keeps a live
// subscription on the shared store, so its renders would land inside whichever test runs next.
const openViews: RenderedElement[] = []

afterEach(async () => {
  for (const view of openViews.splice(0)) {
    await act(async () => {
      view.unmount()
    })
  }
})

describe('QR Code Studio UI Integration Tests', () => {
  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800

    useToolsStore.setState({
      activeSubmodule: 'qrcode',
      qrcodeModuleExpanded: true,
      activeQrCodeView: 'generator',
    })

    useQrCodeStore.setState({
      contentType: 'url',
      urlContent: 'https://example.com',
      textContent: '',
      wifiContent: { ssid: '', encryption: 'WPA' },
      vcardContent: { firstName: '', lastName: '' },
      emailContent: { to: '', subject: '', body: '' },
      phoneContent: { phone: '' },
      options: { ...DEFAULT_QR_OPTIONS },
      contentAccordionOpen: true,
      beautifyAccordionOpen: true,
      activeBeautifyTab: 'template',
      exportSize: 1000,
    })
  })

  it('renders QrCodeApp workbench in generator view with all main panels', async () => {
    const view = await renderElement(<QrCodeApp />)

    const root = view.container.querySelector('[data-testid="qrcode-app-root"]')
    expect(root).not.toBeNull()

    expect(view.container.textContent).toContain(t('tools.qrcode.content.accordion_title'))
    expect(view.container.textContent).toContain(t('tools.qrcode.beautify.accordion_title'))
    expect(view.container.textContent).toContain(t('tools.qrcode.export.section_title'))

    view.unmount()
  })

  it('switches content protocol forms (URL to Text, WiFi, Email, Phone)', async () => {
    const view = await renderElement(<QrCodeApp />)

    const textTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.content.tab_text')
    )
    expect(textTabBtn).toBeDefined()

    act(() => {
      textTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useQrCodeStore.getState().contentType).toBe('text')

    const textarea = view.container.querySelector('textarea')
    expect(textarea).not.toBeNull()

    act(() => {
      useQrCodeStore.getState().setTextContent('Hello World QR')
    })
    expect(useQrCodeStore.getState().textContent).toBe('Hello World QR')
    const state = useQrCodeStore.getState()
    expect(encodeQrData(state.contentType, state)).toBe('Hello World QR')

    const wifiTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.content.tab_wifi')
    )
    act(() => {
      wifiTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().contentType).toBe('wifi')

    const emailTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.content.tab_email')
    )
    act(() => {
      emailTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().contentType).toBe('email')

    const phoneTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.content.tab_phone')
    )
    act(() => {
      phoneTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().contentType).toBe('phone')

    view.unmount()
  })

  it('switches beautify tabs (Templates, Shape, Logo, Text, Color)', async () => {
    const view = await renderElement(<QrCodeApp />)

    const shapeTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.beautify.tab_shape')
    )
    expect(shapeTabBtn).toBeDefined()

    act(() => {
      shapeTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('shape')
    expect(view.container.textContent).toContain(t('tools.qrcode.shape.error_correction'))

    const logoTabBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.beautify.tab_logo')
    )
    act(() => {
      logoTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('logo')
    expect(view.container.textContent).toContain(t('tools.qrcode.logo.online_logos'))

    const beautifySection = view.container.querySelector(
      `section[aria-label="${t('tools.qrcode.beautify.accordion_title')}"]`
    )
    expect(beautifySection).not.toBeNull()

    const textTabBtn = Array.from(beautifySection!.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.beautify.tab_text')
    )
    expect(textTabBtn).toBeDefined()

    act(() => {
      textTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('text')
    expect(view.container.textContent).toContain(t('tools.qrcode.text.add_text'))

    const colorTabBtn = Array.from(beautifySection!.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === t('tools.qrcode.beautify.tab_color')
    )
    act(() => {
      colorTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('color')
    expect(view.container.textContent).toContain(t('tools.qrcode.color.solid_palette'))

    view.unmount()
  })

  it('offers every frame style the engine can draw and writes the caption back', async () => {
    const view = await renderElement(<QrCodeApp />)
    openViews.push(view)

    const beautifySection = view.container.querySelector(
      `section[aria-label="${t('tools.qrcode.beautify.accordion_title')}"]`
    )
    expect(beautifySection).not.toBeNull()

    const frameTabBtn = Array.from(beautifySection!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === t('tools.qrcode.beautify.tab_frame')
    )
    expect(frameTabBtn, 'the beautify panel has no frame tab').toBeDefined()

    act(() => {
      frameTabBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('frame')

    const typeSelect = beautifySection!.querySelector('select')
    expect(typeSelect).not.toBeNull()
    // 'none' plus the eight styles frame-decorator's switch can render
    expect(typeSelect!.querySelectorAll('option')).toHaveLength(9)

    const selectValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value'
    )?.set
    const inputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set

    // Without a frame there is nothing to caption, so the field must not pretend to be usable.
    act(() => {
      selectValueSetter?.call(typeSelect, 'none')
      typeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().options.frameOptions?.type).toBe('none')
    expect(beautifySection!.querySelector('input')).toBeNull()

    act(() => {
      selectValueSetter?.call(typeSelect, 'dark-green')
      typeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().options.frameOptions?.type).toBe('dark-green')

    const caption = beautifySection!.querySelector('input')
    expect(caption, 'choosing a frame style did not reveal the caption field').not.toBeNull()
    act(() => {
      inputValueSetter?.call(caption, 'Scan for details')
      caption!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useQrCodeStore.getState().options.frameOptions?.label).toBe('Scan for details')

    view.unmount()
  })

  it('opens and closes QR technical details modal from preview panel', async () => {
    const view = await renderElement(<QrCodeApp />)

    const infoBtn = view.container.querySelector('button[aria-label="' + t('tools.qrcode.preview.info') + '"]')
    expect(infoBtn).not.toBeNull()

    act(() => {
      infoBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(t('tools.qrcode.info.modal_title'))
    expect(document.body.textContent).toContain(t('tools.qrcode.info.content_type'))

    const closeBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(t('tools.qrcode.info.close'))
    )
    act(() => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    view.unmount()
  })

  it('opens and closes fullscreen scan modal from preview panel', async () => {
    const view = await renderElement(<QrCodeApp />)

    const fullscreenBtn = view.container.querySelector('button[aria-label="' + t('tools.qrcode.preview.fullscreen') + '"]')
    expect(fullscreenBtn).not.toBeNull()

    act(() => {
      fullscreenBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(t('tools.qrcode.fullscreen.modal_title'))
    expect(document.body.textContent).toContain(t('tools.qrcode.fullscreen.scan_hint'))

    view.unmount()
  })

  it('navigates to History, Templates, and Settings views via activeQrCodeView', async () => {
    // The module store's own view field was a second nav source that nothing read, so the scanner's
    // jump buttons wrote into it and the workbench never moved; only toolsStore drives the views.
    expect(Object.keys(useQrCodeStore.getState())).not.toContain('activeView')

    useToolsStore.setState({ activeQrCodeView: 'history' })
    const historyView = await renderElement(<QrCodeApp />)
    expect(historyView.container.textContent).toContain(t('tools.qrcode.history.title'))
    historyView.unmount()

    useToolsStore.setState({ activeQrCodeView: 'templates' })
    const templatesView = await renderElement(<QrCodeApp />)
    expect(templatesView.container.textContent).toContain(t('tools.qrcode.templates.library_title'))
    templatesView.unmount()

    useToolsStore.setState({ activeQrCodeView: 'settings' })
    const settingsView = await renderElement(<QrCodeApp />)
    expect(settingsView.container.textContent).toContain(t('tools.qrcode.settings.title'))
    settingsView.unmount()
  })

  it('allows applying built-in templates from template library', async () => {
    useToolsStore.setState({ activeQrCodeView: 'templates' })
    const view = await renderElement(<QrCodeApp />)

    const applyBtns = Array.from(view.container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes(t('tools.qrcode.templates.apply'))
    )
    expect(applyBtns.length).toBeGreaterThan(0)

    act(() => {
      applyBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useToolsStore.getState().activeQrCodeView).toBe('generator')
    view.unmount()
  })
})
describe('QR generator preview encodes what is typed, not what was there first', () => {
  const mounted: RenderedElement[] = []

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800

    useToolsStore.setState({
      activeSubmodule: 'qrcode',
      qrcodeModuleExpanded: true,
      activeQrCodeView: 'generator',
    })

    useQrCodeStore.setState({
      contentType: 'url',
      urlContent: 'https://first.example/base',
      textContent: '',
      options: { ...DEFAULT_QR_OPTIONS },
      contentAccordionOpen: true,
      beautifyAccordionOpen: true,
      activeBeautifyTab: 'template',
    })
  })

  afterEach(async () => {
    // An unmounted view keeps its subscription on the shared store, so its effects would run inside
    // the next test and make every observation here a function of test order.
    for (const view of mounted.splice(0)) {
      await act(async () => {
        view.unmount()
      })
    }
    vi.restoreAllMocks()
  })

  function mount(node: ReactNode): RenderedElement {
    const view = renderElement(node)
    mounted.push(view)
    return view
  }

  function taggedCanvas(payload: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.dataset.renderedPayload = payload
    return canvas
  }

  function recordRenders(): string[] {
    const rendered: string[] = []
    vi.spyOn(QrEngine.prototype, 'renderCanvas').mockImplementation(function (
      this: QrEngine,
      width?: number
    ) {
      rendered.push(this.getData())
      const canvas = taggedCanvas(this.getData())
      canvas.width = width ?? 0
      return Promise.resolve(canvas)
    })
    return rendered
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const previewOf = (root: HTMLElement) =>
    root.querySelectorAll('[data-testid="qrcode-preview-canvas-container"]')

  it('mounts a single preview surface per layout mode', async () => {
    recordRenders()

    const wide = mount(<QrCodeApp />)
    await settle()
    expect(previewOf(wide.container)).toHaveLength(1)
    wide.unmount()

    window.innerWidth = 640
    const narrow = mount(<QrCodeApp />)
    await settle()
    expect(previewOf(narrow.container)).toHaveLength(1)
    narrow.unmount()
    window.innerWidth = 1280
  })

  it('redraws the preview when only the content changes', async () => {
    const rendered = recordRenders()
    const view = mount(<QrCodeApp />)
    await settle()
    expect(rendered[rendered.length - 1]).toBe('https://first.example/base')

    act(() => {
      useQrCodeStore.getState().setUrlContent('https://second.example/next')
    })
    await settle()

    expect(rendered[rendered.length - 1]).toBe('https://second.example/next')
    expect(
      previewOf(view.container)[0].querySelector('canvas')?.dataset.renderedPayload
    ).toBe('https://second.example/next')
  })

  it('exports the content in the field rather than the one present at mount', async () => {
    const rendered = recordRenders()
    const view = mount(<QrCodeApp />)
    await settle()

    act(() => {
      useQrCodeStore.getState().setUrlContent('https://to-export.example/file')
    })
    await settle()

    const pngButton = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'PNG'
    )
    expect(pngButton).toBeDefined()
    await act(async () => {
      pngButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(rendered[rendered.length - 1]).toBe('https://to-export.example/file')
  })

  it('returns the preview to its empty state when the content is cleared', async () => {
    recordRenders()
    const view = mount(<QrCodeApp />)
    await settle()
    expect(previewOf(view.container)[0].querySelector('canvas')).not.toBeNull()

    act(() => {
      useQrCodeStore.getState().setUrlContent('')
    })
    await settle()

    expect(previewOf(view.container)).toHaveLength(0)
    expect(view.container.textContent).toContain(t('tools.qrcode.preview.empty_placeholder'))
  })

  it('shows a retry path when the render fails, and draws again once it is used', async () => {
    vi.spyOn(QrEngine.prototype, 'renderCanvas')
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(function (this: QrEngine) {
        return Promise.resolve(taggedCanvas(this.getData()))
      })

    const view = mount(<QrCodeApp />)
    await settle()

    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('tools.qrcode.preview.render_error'))

    const retry = Array.from(alert?.parentElement?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === t('tools.qrcode.preview.retry')
    )
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(
      previewOf(view.container)[0].querySelector('canvas')?.dataset.renderedPayload
    ).toBe('https://first.example/base')
  })

  it('refuses to let a superseded render paint over the newer one', async () => {
    const pending: Array<{ payload: string; resolve: (canvas: HTMLCanvasElement) => void }> = []
    vi.spyOn(QrEngine.prototype, 'renderCanvas').mockImplementation(function (this: QrEngine) {
      const payload = this.getData()
      return new Promise<HTMLCanvasElement>((resolve) => {
        pending.push({ payload, resolve })
      })
    })

    const view = mount(<QrCodeApp />)
    act(() => {
      useQrCodeStore.getState().setUrlContent('https://newer.example/new')
    })

    const older = pending.find((p) => p.payload === 'https://first.example/base')
    const newer = pending.find((p) => p.payload === 'https://newer.example/new')
    expect(older).toBeDefined()
    expect(newer).toBeDefined()

    await act(async () => {
      newer?.resolve(taggedCanvas(newer.payload))
      await Promise.resolve()
    })
    await act(async () => {
      older?.resolve(taggedCanvas(older.payload))
      await Promise.resolve()
    })

    expect(
      previewOf(view.container)[0].querySelector('canvas')?.dataset.renderedPayload
    ).toBe('https://newer.example/new')
  })
})
