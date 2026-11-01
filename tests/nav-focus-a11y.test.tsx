// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NAV_SETTINGS, type NavBootstrap, type NavCategory, type NavLink } from '../src/shared/nav/model'
import { NavLinkEditor } from '../src/client/features/nav/NavLinkEditor'
import { IconPicker } from '../src/client/features/nav/NavCategories'
import { NavSettingsModal } from '../src/client/features/nav/NavSettings'
import { ConfirmHost } from '../src/client/components/overlay'
import { useNavStore } from '../src/client/features/nav/nav-store'
import { useSession } from '../src/client/store/session'
import { useUi } from '../src/client/store/ui'
import { navApi } from '../src/client/features/nav/api'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const CATEGORY: NavCategory = {
  id: 'cat-a', name: 'Tools', icon: 'folder', parentId: null,
  hasPassword: false, passwordMode: 'none', sortOrder: 0, createdAt: 1,
}
const LINK: NavLink = {
  id: 'link-a', title: 'Example', url: 'https://example.com/', icon: null, description: null,
  categoryId: CATEGORY.id, pinned: false, pinnedOrder: 0, sortOrder: 0, createdAt: 1, updatedAt: 1,
}

let rendered: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('No dialog is open')
  return node
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  useSession.setState({ user: { id: 'user-1' } as never })
  useUi.setState({ toasts: [] })
  vi.spyOn(navApi, 'aiModels').mockResolvedValue({ models: [], selected: '', available: false, reason: 'no_model' })
  useNavStore.setState({
    status: 'ready', error: null, categories: [CATEGORY], links: [LINK], visits: {},
    counts: { total: 1, byCategory: { [CATEGORY.id]: 1 } },
    settings: DEFAULT_NAV_SETTINGS, webdav: { url: '', username: '', hasPassword: false },
    sync: 'idle', unlocks: {}, selectedCategory: null, selectedSubcategory: null, query: '',
  } as never)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

describe('navigation focus and accessible names', () => {
  it('puts the caret in the title field when the link editor opens', async () => {
    rendered = renderElement(
      <>
        <NavLinkEditor open link={null} onClose={() => {}} />
        <ConfirmHost />
      </>,
    )
    await flush()
    await flush()

    const active = document.activeElement as HTMLElement | null
    expect(active?.tagName).toBe('INPUT')
    // The overlay picks the `[data-autofocus]` target; React's own `autoFocus` was being overwritten by it,
    // which left keyboard users starting on the dialog's close button.
    expect(active?.hasAttribute('data-autofocus')).toBe(true)
    expect(active?.getAttribute('aria-label')).not.toBe(t('nav.close'))
  })

  it('names the search-source enable box for what it does and ties its error to the field', async () => {
    rendered = renderElement(
      <>
        <NavSettingsModal open onClose={() => {}} />
        <ConfirmHost />
      </>,
    )
    await flush()
    await flush()

    const searchTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === t('nav.settings.search'),
    )
    expect(searchTab, 'the settings dialog should expose its search tab').toBeTruthy()
    click(searchTab!)
    await flush()

    const boxes = [...dialog().querySelectorAll<HTMLElement>('[role="checkbox"]')]
    const names = boxes.map((box) => box.getAttribute('aria-label') ?? '')
    // The enable box used to borrow the name of the text field beside it, so a reader heard "Source name"
    // twice in a row — once for a box, once for a box that is not a box.
    expect(names).toContain(t('nav.settings.source_enabled'))
    expect(names).not.toContain(t('nav.settings.source_name'))

    const urlFields = [...dialog().querySelectorAll<HTMLInputElement>('input')].filter((input) => input.value.includes('{query}'))
    expect(urlFields.length).toBeGreaterThan(0)
    const broken = urlFields[0]!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(broken, 'not a url')
      broken.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(broken.getAttribute('aria-invalid')).toBe('true')
    const describedBy = broken.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const error = dialog().querySelector(`#${CSS.escape(describedBy!)}`)
    expect(error?.textContent).toBe(t('nav.settings.source_url_error'))
  })

  it('keeps the icon grid to one tab stop and walks it with arrows', async () => {
    let picked = ''
    rendered = renderElement(<IconPicker value="" onChange={(next) => { picked = next }} />)
    await flush()

    const grid = document.querySelector<HTMLElement>('[role="group"][aria-label]')
    expect(grid).not.toBeNull()
    const buttons = [...grid!.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.length).toBeGreaterThan(20)
    expect(buttons.filter((button) => button.tabIndex >= 0)).toHaveLength(1)

    buttons[0]!.focus()
    act(() => {
      grid!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(buttons[1])
    act(() => {
      grid!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(buttons.at(-1))
    expect(picked).toBe('')
  })
})
