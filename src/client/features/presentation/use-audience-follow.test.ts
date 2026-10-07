import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { useAudienceFollow } from './use-audience-follow'

// The audience half of N-34, seen from the presenter's seat: one press hands out a link, every turn
// moves it, and nothing is left running after the show — a forgotten show that still answers for two
// hours is a leak, not a convenience.
const api = vi.hoisted(() => ({
  presence: { start: vi.fn(), publish: vi.fn(), stop: vi.fn(), status: vi.fn() },
}))

vi.mock('../../lib/api', () => ({ api }))

const toast = vi.hoisted(() => vi.fn())
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }))

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async () => undefined) }))

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
  Object.assign(navigator, { clipboard })
})

beforeEach(() => {
  api.presence.start.mockReset().mockResolvedValue({ token: 'a'.repeat(64), slug: 'quarterly', expiresAt: 9e14, slide: 0, page: 0, step: 0 })
  api.presence.publish.mockReset().mockResolvedValue({ updatedAt: 1 })
  api.presence.stop.mockReset().mockResolvedValue({ stopped: true })
  clipboard.writeText.mockClear()
  toast.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

interface HookResult {
  on: boolean
  link: string | null
  toggle: () => void
}

function Host({ noteId, position, held }: {
  noteId: string | null
  position: { slide: number, page: number, step: number }
  held: { current: HookResult | null }
}) {
  held.current = useAudienceFollow({ open: true, noteId, position })
  return null
}

async function mount(position = { slide: 0, page: 0, step: 0 }) {
  const held: { current: HookResult | null } = { current: null }
  const view = renderElement(createElement(Host, { noteId: 'note-1', position, held }))
  await act(async () => { await Promise.resolve() })
  return {
    get result() {
      if (!held.current) throw new Error('the audience hook never mounted')
      return held.current
    },
    rerender: async (next: { slide: number, page: number, step: number }) => {
      await act(async () => { view.rerender(createElement(Host, { noteId: 'note-1', position: next, held })) })
    },
    unmount: view.unmount,
  }
}

const press = async (result: HookResult) => {
  await act(async () => { result.toggle() })
  await act(async () => { await Promise.resolve() })
}

function toasts() {
  return toast.mock.calls.map(([call]) => call?.title ?? '')
}

describe('useAudienceFollow — one press hands out a link', () => {
  it('starts the show once and puts the audience URL where the presenter can send it', async () => {
    const show = await mount()
    expect(show.result.on).toBe(false)
    expect(show.result.link, 'nothing is announced before the presenter asks').toBeNull()

    await press(show.result)
    expect(api.presence.start).toHaveBeenCalledWith('note-1')
    expect(show.result.on).toBe(true)
    expect(show.result.link).toBe(`${window.location.origin}/s/quarterly?present=${'a'.repeat(64)}`)
    expect(clipboard.writeText).toHaveBeenCalledWith(show.result.link)
  })

  it('says the same thing whether it copied the link or showed it', async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error('no permission'))
    const show = await mount()
    await press(show.result)
    expect(toasts()).toEqual([t('workspace.presentation_audience_link', { value0: show.result.link ?? '' })])
    expect(show.result.on, 'a clipboard that says no does not end the show').toBe(true)
  })

  it('answers a failed start with the failure, and stays off', async () => {
    api.presence.start.mockRejectedValueOnce(new Error('410'))
    const show = await mount()
    await press(show.result)
    expect(show.result.on).toBe(false)
    expect(toasts()).toEqual([t('workspace.presentation_audience_failed')])
    expect(api.presence.publish).not.toHaveBeenCalled()
  })
})

describe('useAudienceFollow — the show moves, the audience moves with it', () => {
  it('publishes each position once, and only while the audience is in', async () => {
    const show = await mount()
    await show.rerender({ slide: 1, page: 0, step: 2 })
    expect(api.presence.publish, 'a show nobody joined is not reported to the server').not.toHaveBeenCalled()

    await press(show.result)
    await show.rerender({ slide: 1, page: 0, step: 2 })
    expect(api.presence.publish).toHaveBeenCalledWith('note-1', { slide: 1, page: 0, step: 2 })

    await show.rerender({ slide: 1, page: 0, step: 2 })
    expect(api.presence.publish).toHaveBeenCalledTimes(1)
    await show.rerender({ slide: 2, page: 1, step: 0 })
    expect(api.presence.publish).toHaveBeenLastCalledWith('note-1', { slide: 2, page: 1, step: 0 })
  })

  it('ends the audience show when the presenter leaves the room', async () => {
    const held = { current: null as HookResult | null }
    let open = true
    function Closing() {
      held.current = useAudienceFollow({ open, noteId: 'note-1', position: { slide: 0, page: 0, step: 0 } })
      return null
    }
    const view = renderElement(createElement(Closing))
    await act(async () => { await Promise.resolve() })
    await press(held.current!)

    open = false
    await act(async () => { view.rerender(createElement(Closing)) })
    await act(async () => { await Promise.resolve() })
    expect(api.presence.stop).toHaveBeenCalledWith('note-1')
    expect(held.current!.on).toBe(false)
    view.unmount()
  })

  it('a second press stops it, and a lost position stops it too', async () => {
    const show = await mount()
    await press(show.result)
    await act(async () => { show.result.toggle() })
    expect(api.presence.stop).toHaveBeenCalledWith('note-1')
    expect(show.result.on).toBe(false)

    await press(show.result)
    api.presence.publish.mockRejectedValueOnce(new Error('404'))
    await show.rerender({ slide: 3, page: 0, step: 0 })
    expect(toasts(), 'a position that cannot be delivered is said, not swallowed').toContain(t('workspace.presentation_audience_lost'))
    expect(show.result.on).toBe(false)
    show.unmount()
  })
})
