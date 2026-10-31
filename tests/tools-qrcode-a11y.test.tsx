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
import { GridAlignModal } from '../src/client/features/tools/qrcode/compare/GridAlignModal'
import { QrScannerView } from '../src/client/features/tools/qrcode/scanner/QrScannerView'
import { useQrCodeStore } from '../src/client/features/tools/qrcode/store'
import { useToolsStore } from '../src/client/features/tools/store'

const mounted: RenderedElement[] = []

function mount(node: ReactNode): RenderedElement {
  const view = renderElement(node)
  mounted.push(view)
  return view
}

function tabNamed(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button[role="tab"]')).find(
    (b) => b.textContent?.trim() === label
  )
}

describe('QR workbench keyboard and dialog behaviour', () => {
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
      beautifyAccordionOpen: true,
      contentAccordionOpen: true,
      activeBeautifyTab: 'template',
      defaultsApplied: true,
    })
  })

  afterEach(() => {
    for (const view of mounted.splice(0)) {
      act(() => {
        view.unmount()
      })
    }
    vi.restoreAllMocks()
  })

  it('moves both tab lists with the arrow keys and keeps one tab stop', () => {
    const view = mount(<QrCodeApp />)

    const beautify = tabNamed(view.container, t('tools.qrcode.beautify.tab_shape'))
    const template = tabNamed(view.container, t('tools.qrcode.beautify.tab_template'))
    expect(beautify).toBeDefined()
    expect(template).toBeDefined()

    // The hand-rolled version had no key handling at all and left every tab in the tab order.
    expect(template?.tabIndex).toBe(0)
    expect(beautify?.tabIndex).toBe(-1)

    act(() => {
      template?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(useQrCodeStore.getState().activeBeautifyTab).toBe('shape')

    const urlTab = tabNamed(view.container, t('tools.qrcode.content.tab_url'))
    expect(urlTab).toBeDefined()
    act(() => {
      urlTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(useQrCodeStore.getState().contentType).toBe('text')

    const panel = view.container.querySelector('#qr-beautify-panel')
    expect(panel?.getAttribute('role')).toBe('tabpanel')
    expect(panel?.getAttribute('aria-labelledby')).toContain('-tab-shape')
  })

  it('gives the image drop target a real button and accepts a drop', () => {
    useToolsStore.setState({ activeQrCodeView: 'scanner' })
    const view = mount(<QrScannerView />)

    const choose = Array.from(view.container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === t('tools.qrcode.scanner.choose_image')
    )
    expect(choose).toBeDefined()
    // A div answering clicks is not reachable: the drop zone itself must not be the control.
    const zone = choose?.closest('div')
    expect(zone?.getAttribute('onclick')).toBeNull()
  })

  it('closes the grid alignment dialog with Escape through the shared modal', () => {
    const onClose = vi.fn()
    mount(
      <GridAlignModal
        open
        imageUrl=""
        initialGridSize={29}
        initialMarginSize={2}
        onClose={onClose}
        onApply={() => {}}
      />
    )

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
