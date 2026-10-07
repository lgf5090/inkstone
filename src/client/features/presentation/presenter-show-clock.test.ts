import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { usePresentation } from '../../store/presentation'
import { PresentationOverlay } from './presentation-overlay'

beforeEach(async () => {
  await initI18n()
})

// The show clock the presenter window reads has to be stamped by the show. The channel is the only
// place that number leaves the app, so the broadcaster is watched here rather than reconstructed.
const broadcasts = vi.hoisted(() => ({ startedAt: [] as number[] }))

vi.mock('./presenter-view/use-presenter-channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./presenter-view/use-presenter-channel')>()
  return {
    ...actual,
    usePresenterBroadcaster: vi.fn((options: { startedAt: number }) => {
      broadcasts.startedAt.push(options.startedAt)
    }),
  }
})

const SHOW = { noteId: 'note-clock', content: '# One\n\n---\n\n# Two', title: 'Clock' }

function latestStartedAt(): number {
  const last = broadcasts.startedAt.at(-1)
  if (typeof last !== 'number') throw new Error('the show never told the presenter a clock')
  return last
}

afterEach(() => {
  act(() => {
    usePresentation.getState().stop()
  })
  broadcasts.startedAt.length = 0
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the show clock across shows', () => {
  it('counts from the moment this show started rather than from the moment the app mounted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    // The shell hosts the overlay for the whole session, so this mount is the app opening, not a talk.
    const view = renderElement(createElement(PresentationOverlay))
    expect(broadcasts.startedAt.length, 'a closed overlay still hands the presenter a clock').toBeGreaterThan(0)
    vi.setSystemTime(61_000)
    act(() => {
      usePresentation.getState().start(SHOW)
    })
    expect(latestStartedAt()).toBe(61_000)
    view.unmount()
  })

  it('restamps the clock for the next show instead of carrying the previous one over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const view = renderElement(createElement(PresentationOverlay))
    act(() => {
      usePresentation.getState().start(SHOW)
    })
    const first = latestStartedAt()
    act(() => {
      usePresentation.getState().stop()
    })
    // The second talk of the evening: an hour after the app was opened, and after a finished show.
    vi.setSystemTime(3_700_000)
    act(() => {
      usePresentation.getState().start({ ...SHOW, noteId: 'note-clock-two', title: 'Second talk' })
    })
    const second = latestStartedAt()
    expect(second).toBe(3_700_000)
    expect(second).not.toBe(first)
    view.unmount()
  })
})

describe('the show clock inside one show', () => {
  it('keeps one clock while the same show follows, freezes and resumes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const view = renderElement(createElement(PresentationOverlay))
    act(() => {
      usePresentation.getState().start(SHOW)
    })
    const opened = latestStartedAt()
    act(() => {
      usePresentation.getState().setFollowing(false)
      usePresentation.getState().capture('# One revised\n\n---\n\n# Two')
      usePresentation.getState().setFollowing(true)
    })
    vi.setSystemTime(31_000)
    expect(latestStartedAt(), 'a freeze or a followed edit restamped the show clock').toBe(opened)
    view.unmount()
  })
})
