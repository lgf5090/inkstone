// @vitest-environment jsdom
/**
 * The update card where a reader actually looks at it.
 *
 * `pwa.test.ts` proves the store raises `updateAvailable` when a build finishes installing. A flag is not
 * an entry: the failure this file guards is exactly the one the intercepted install banner would have
 * been — a state that exists with nothing on screen to spend it. So the card is rendered from `App`, the
 * real host, and pressed through the real button, because the two halves that have to stay true are the
 * mount and the wiring, not the styling.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from './lib/test-render'

vi.mock('./store/session', () => {
  // `status: 'loading'` is the one state that renders the shell's layers without rendering a notebook:
  // the card is mounted beside `Toaster`, so proving it is on screen does not need a vault behind it.
  const state = { status: 'loading', load: vi.fn(), user: null, site: null, logout: vi.fn() }
  return {
    useSession: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    watchSystemTheme: () => () => undefined,
  }
})

/**
 * The message table of the run, read after the modules were reset.
 *
 * A static import here would be the copy of i18n that existed before `vi.resetModules()`, which answers
 * every key with the key itself — and then the test would be looking for the string `pwa.update_ready`
 * in a page that correctly says "An app update is ready".
 */
let t: typeof import('./lib/i18n').t
let usePwa: typeof import('./store/pwa').usePwa
let rendered: RenderedElement | null = null

/** Renders the app itself, so the assertion is about the real mount rather than about a copy of it. */
async function renderApp(): Promise<HTMLElement> {
  const { App } = await import('./App')
  await act(async () => {
    rendered = renderElement(createElement(App))
  })
  return rendered!.container
}

/** The card, found the way a reader finds it: by what it says. */
function card(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'))
    .find((node) => node.textContent?.includes(t('pwa.update_ready')))
}

beforeEach(async () => {
  vi.resetModules()
  const i18n = await import('./lib/i18n')
  await i18n.initI18n()
  t = i18n.t
  usePwa = (await import('./store/pwa')).usePwa
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

describe('the update card in the app', () => {
  it('shows the waiting build, in words, with something to press', async () => {
    usePwa.setState({ updateAvailable: true })

    const container = await renderApp()
    const node = card(container)

    expect(node, 'updateAvailable is raised and the page shows nothing a reader can act on').toBeTruthy()
    expect(node!.textContent).toContain(t('pwa.update_ready_description'))
    const button = node!.querySelector('button')
    expect(button, 'the card names an update but offers no way to take it up').toBeTruthy()
    expect(button!.tagName).toBe('BUTTON')
    expect(button!.textContent).toContain(t('pwa.refresh_now'))
  })

  it('presses the store action that does the handover', async () => {
    const applyUpdate = vi.fn(async () => undefined)
    usePwa.setState({ updateAvailable: true, applyUpdate })

    const node = card(await renderApp())

    await act(async () => {
      node!.querySelector('button')!.click()
    })
    expect(applyUpdate).toHaveBeenCalled()
  })

  it('is not on the screen when no build is waiting', async () => {
    usePwa.setState({ updateAvailable: false })

    expect(card(await renderApp())).toBeUndefined()
  })
})
