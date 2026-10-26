// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { QrCodeApp } from '../src/client/features/tools/qrcode/QrCodeApp'
import { useQrCodeStore } from '../src/client/features/tools/qrcode/store'
import { useToolsStore } from '../src/client/features/tools/store'

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
      activeView: 'generator',
      contentType: 'url',
      urlContent: 'https://example.com',
      textContent: '',
      wifiContent: { ssid: '', encryption: 'WPA' },
      vcardContent: { firstName: '', lastName: '' },
      emailContent: { to: '', subject: '', body: '' },
      phoneContent: { number: '' },
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
    expect(useQrCodeStore.getState().getEncodedPayload()).toBe('Hello World QR')

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
