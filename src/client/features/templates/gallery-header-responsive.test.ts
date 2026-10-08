import { act, createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { GalleryHeader } from './gallery-header'
import { galleryMoreItems } from './gallery-controller'

let root: Root
let container: HTMLDivElement
const realMatchMedia = window.matchMedia

/** `useMediaQuery` reads `window.matchMedia`, which the global stub does not replace here. */
function setRoom(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}

function props() {
  return {
    query: '',
    onQueryChange: () => {},
    searchRef: { current: null } as RefObject<HTMLInputElement | null>,
    onSearchFocusChange: () => {},
    selectMode: false,
    onToggleSelectMode: () => {},
    onOpenHelp: () => {},
    onNewTemplate: () => {},
    moreButtonRef: { current: null } as RefObject<HTMLButtonElement | null>,
    onOpenMore: () => {},
    onClose: () => {},
  }
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
}

async function render() {
  await act(async () => {
    root.render(createElement(GalleryHeader, props()))
    await Promise.resolve()
  })
}

const builderInput = {
  roomy: true,
  selectMode: false,
  onToggleSelectMode: () => {},
  onOpenHelp: () => {},
  onOpenImport: () => {},
  hasActiveNote: false,
  onSaveActiveNote: () => {},
}

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  window.matchMedia = realMatchMedia
})

describe('the template gallery header at each width', () => {
  it('keeps the title, the meta buttons and the button label when there is room', async () => {
    setRoom(true)
    await render()
    expect(container.textContent).toContain(t('templates.template_library'))
    expect(buttonNamed(t('templates.select_mode'))).toBeDefined()
    expect(buttonNamed(t('templates.keyboard_shortcuts'))).toBeDefined()
    expect(buttonNamed(t('templates.new_template'))?.textContent).toContain(t('templates.new_template'))
  })

  it('gives the search box the row back on a phone: icon-only new template, no meta buttons', async () => {
    setRoom(false)
    await render()
    const create = buttonNamed(t('templates.new_template'))
    expect(create, 'the button must stay reachable and named').toBeDefined()
    expect(create?.textContent?.trim(), 'text on this button is what squeezed the search box').toBe('')
    expect(buttonNamed(t('templates.select_mode'))).toBeUndefined()
    expect(buttonNamed(t('templates.keyboard_shortcuts'))).toBeUndefined()
    expect(container.querySelector('input'), 'the search box is never dropped').toBeDefined()
  })

  it('moves the two hidden controls into the overflow menu, and only there', () => {
    const compact = galleryMoreItems({ ...builderInput, roomy: false }).map((item) => item.id)
    expect(compact).toEqual(['select', 'help', 'export', 'copy-json', 'import', 'save-note'])
    const roomy = galleryMoreItems(builderInput).map((item) => item.id)
    expect(roomy).toEqual(['export', 'copy-json', 'import', 'save-note'])
  })

  it('carries the select-mode check state into the menu twin', () => {
    const items = galleryMoreItems({ ...builderInput, roomy: false, selectMode: true })
    expect(items.find((item) => item.id === 'select')?.checked).toBe(true)
  })
})
