import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, stubWideShow } from '../../lib/test-render'
import { usePresentation } from '../../store/presentation'
import { PresentationOverlay } from './presentation-overlay'

// PR-L3, seen from the presenter's seat rather than from a component in isolation: the show is asked to
// end by the same key that ends every other layer, and a room that is following has to be told the talk
// is over rather than left reading a live link. Only the wiring through the real session can show that
// the question appears, that Escape answers it as staying, and that the answer which says otherwise
// actually ends the show.
const presence = vi.hoisted(() => ({ start: vi.fn(), publish: vi.fn(), stop: vi.fn(), status: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { ...actual.api, presence } }
})

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async () => undefined) }))

beforeAll(async () => {
  await initI18n()
  Object.assign(navigator, { clipboard })
})

beforeEach(() => {
  presence.start.mockReset().mockResolvedValue({ token: 'a'.repeat(64), slug: 'quarterly', expiresAt: 9e14, slide: 0, page: 0, step: 0 })
  presence.publish.mockReset().mockResolvedValue({ updatedAt: 1 })
  presence.stop.mockReset().mockResolvedValue({ stopped: true })
  usePresentation.setState({
    open: true,
    noteId: 'note-exit-ask',
    title: 'Exit Ask',
    snapshot: '# Opening\n\nBody\n\n---\n\n# Closing',
    following: false,
    initialSlideIndex: 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  act(() => {
    usePresentation.setState({ open: false, noteId: null, snapshot: '' })
  })
  document.body.innerHTML = ''
  // The idle pass that measures the pages ahead of the talk keeps working for a beat after the test is
  // over, and `unstubAllGlobals` took the observer away with it: putting the shims back costs nothing and
  // keeps that late effect from throwing outside the case that scheduled it.
  installTestGlobals()
})

beforeEach(stubWideShow)

const pressKey = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const confirmDialog = () => document.querySelector<HTMLElement>('[data-presentation-exit-confirm]')

const answer = (label: string) =>
  [...(confirmDialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === label)

async function handOutTheLink() {
  const button = document.querySelector<HTMLElement>('[data-audience-toggle]')
  if (!button) throw new Error('the show has no audience control to press')
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
}

describe('the exit question a show with an audience asks', () => {
  it('asks instead of ending, and the key that asked puts the question away', async () => {
    const view = renderElement(createElement(PresentationOverlay))
    await handOutTheLink()

    pressKey('Escape')
    expect(confirmDialog()).toBeTruthy()
    expect(usePresentation.getState().open).toBe(true)

    pressKey('Escape')
    expect(confirmDialog()).toBeNull()
    expect(usePresentation.getState().open, 'Escape on the question must not end the talk')
      .toBe(true)
    view.unmount()
  })

  it('ends on the answer that says so, and takes the audience show down with it', async () => {
    const view = renderElement(createElement(PresentationOverlay))
    await handOutTheLink()

    pressKey('Escape')
    const stays = answer(t('common.cancel'))
    const leaves = answer(t('workspace.presentation_exit'))
    expect(stays && leaves).toBeTruthy()

    act(() => { leaves?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(usePresentation.getState().open).toBe(false)
    expect(confirmDialog()).toBeNull()
    expect(presence.stop, 'the link out there still says "following this show"').toHaveBeenCalledWith('note-exit-ask')
    view.unmount()
  })

  it('ends a show nobody is watching on the first press', () => {
    const view = renderElement(createElement(PresentationOverlay))

    pressKey('Escape')
    expect(confirmDialog()).toBeNull()
    expect(usePresentation.getState().open).toBe(false)
    view.unmount()
  })

  it('keeps asking while the room is still there, so the question is never one press deep', async () => {
    const view = renderElement(createElement(PresentationOverlay))
    await handOutTheLink()

    pressKey('Escape')
    act(() => { answer(t('common.cancel'))?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(confirmDialog()).toBeNull()

    pressKey('Escape')
    expect(confirmDialog()).toBeTruthy()
    expect(usePresentation.getState().open).toBe(true)
    view.unmount()
  })
})
