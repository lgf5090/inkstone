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
import { DEFAULT_SETTINGS } from '@shared/constants'
import { renderElement, type RenderedElement } from './lib/test-render'

vi.mock('./store/session', () => {
  // `status: 'loading'` is the one state that renders the shell's layers without rendering a notebook:
  // the card is mounted beside `Toaster`, so proving it is on screen does not need a vault behind it.
  const state = {
    status: 'loading',
    load: vi.fn(),
    user: null,
    site: null,
    logout: vi.fn(),
    // The two Templater bridges App mounts read their rows off the settings, so a stub without them is a
    // shell that cannot render — and the defaults are the real ones rather than a hand-made shape, so this
    // cannot drift from what the store actually resolves.
    settings: { templater: DEFAULT_SETTINGS.templater },
  }
  return {
    useSession: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    watchSystemTheme: () => () => undefined,
    // Reached by the boot-ceiling case below, which has to press the retry and see the store asked.
    sessionState: state,
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

/** The same slot's other answer: the update that never arrived. */
function stuckCard(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'))
    .find((node) => node.textContent?.includes(t('pwa.update_stuck')))
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

  it('confesses a jammed install, and offers the only way out a page has', async () => {
    usePwa.setState({ updateStuck: true })

    const node = stuckCard(await renderApp())

    expect(node, 'the update never arrived and the page says nothing about it').toBeTruthy()
    expect(node!.textContent).toContain(t('pwa.update_stuck_description'))
    const button = node!.querySelector('button')
    expect(button, 'the card names the jam but leaves the reader in it').toBeTruthy()
    expect(button!.tagName).toBe('BUTTON')
    expect(button!.textContent).toContain(t('pwa.clear_and_reload'))
  })

  it('presses the store action that clears the jam', async () => {
    const clearStuckUpdate = vi.fn(async () => undefined)
    usePwa.setState({ updateStuck: true, clearStuckUpdate })

    const node = stuckCard(await renderApp())
    await act(async () => {
      node!.querySelector('button')!.click()
    })

    expect(clearStuckUpdate).toHaveBeenCalled()
  })

  it('prefers the build that did arrive when both answers are on the table', async () => {
    usePwa.setState({ updateAvailable: true, updateStuck: true })

    const container = await renderApp()

    expect(card(container), 'a waiting build is answered with a complaint about the jam').toBeTruthy()
    expect(stuckCard(container)).toBeUndefined()
  })
})

/**
 * The eight-second ceiling on the boot screen.
 *
 * The screen is removed at the ceiling whether or not the session answered, so the question this case asks
 * is what the reader is left holding when it never did. The answer used to be a blank page: no words, no
 * reason, nothing to press — and `status === 'loading'` renders an invisible div, so every structural
 * assertion in the rest of the file sails straight past it.
 */
describe('the boot ceiling', () => {
  const alert = () => document.body.querySelector<HTMLElement>('[role="alert"]')

  it('says the server did not answer, and gives the one thing that can end the wait', async () => {
    const { App } = await import('./App')
    const session = (await import('./store/session')) as unknown as { sessionState: { load: ReturnType<typeof vi.fn> } }
    session.sessionState.load.mockClear()

    // Fake the clock before the effect registers its timer, but after the module graph is loaded: dynamic
    // import is promise work, and it should not be made to wait on a clock this test controls.
    vi.useFakeTimers()
    try {
      await act(async () => {
        rendered = renderElement(createElement(App))
      })
      expect(alert(), 'the page confesses something before the ceiling').toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(8_000)
      })
      const node = alert()
      expect(node, 'the boot screen came down and left a blank page behind').toBeTruthy()
      expect(node!.textContent).toContain(t('auth.server_did_not_answer'))

      const button = node!.querySelector('button')
      expect(button, 'the page says nothing answered and offers no way to ask again').toBeTruthy()
      expect(button!.textContent).toContain(t('common.retry'))
      // The panel takes focus on its own: it appears under a reader who was looking at nothing.
      expect(document.activeElement).toBe(button)

      await act(async () => {
        button!.click()
      })
      expect(session.sessionState.load).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
