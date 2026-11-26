import { act, createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSubscription } from '@shared/project/model'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import * as api from './api'
import { resetProjectSubscriptionCache, useProjectWatch } from './use-watch'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectSubscriptions: vi.fn(),
  watchProjectBlock: vi.fn(),
  unwatchProjectBlock: vi.fn(),
}))

const subscription = (blockId: string): ProjectSubscription => ({
  blockType: 'board', blockId, subscriberId: 'u1', notifiedAt: 0, createAt: 1,
})
let view: RenderedElement

function Probe({ blockId = 'b1' }: { blockId?: string }): ReactElement {
  const { watching, status, toggle, retry } = useProjectWatch('board', blockId)
  return createElement('div', null,
    createElement('button', { 'data-watching': String(watching), 'data-status': status, onClick: retry }, 'watch'),
    createElement('button', { 'data-toggle': true, onClick: () => void toggle() }, 'toggle'),
  )
}

beforeEach(() => {
  resetProjectSubscriptionCache()
  vi.clearAllMocks()
  vi.mocked(api.fetchProjectSubscriptions).mockReset().mockResolvedValue([])
  useSession.setState({ user: { id: 'u1' } as never })
})

afterEach(() => {
  view?.unmount()
  useSession.setState({ user: null })
})

describe('useProjectWatch account cache', () => {
  it('keeps a failed watch read unknown until retry succeeds', async () => {
    vi.mocked(api.fetchProjectSubscriptions).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce([subscription('b1')])
    await act(async () => { view = renderElement(createElement(Probe)) })
    expect(view.container.querySelector('button')?.getAttribute('data-status')).toBe('error')
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('false')
    await act(async () => { view.container.querySelector('button')!.click() })
    expect(view.container.querySelector('button')?.getAttribute('data-status')).toBe('ready')
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('true')
  })

  it('does not roll back a new board watch when an older board toggle fails', async () => {
    let rejectOld!: (reason: unknown) => void
    const oldWrite = new Promise<void>((_resolve, reject) => { rejectOld = reject })
    vi.mocked(api.watchProjectBlock).mockReturnValueOnce(oldWrite)
    vi.mocked(api.fetchProjectSubscriptions).mockResolvedValueOnce([subscription('b2')])
    await act(async () => { view = renderElement(createElement(Probe, { blockId: 'b2' })) })
    await act(async () => { view.rerender(createElement(Probe, { blockId: 'b1' })) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('false')
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[data-toggle]')!.click() })
    await act(async () => { view.rerender(createElement(Probe, { blockId: 'b2' })) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('true')
    await act(async () => { rejectOld(new TypeError('Failed to fetch')); await oldWrite.catch(() => undefined) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('true')
  })

  it('never reuses one account watch roster for another account', async () => {
    vi.mocked(api.fetchProjectSubscriptions).mockResolvedValueOnce([subscription('b1')])
    await act(async () => { view = renderElement(createElement(Probe)) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('true')

    vi.mocked(api.fetchProjectSubscriptions).mockResolvedValueOnce([])
    await act(async () => { useSession.setState({ user: { id: 'u2' } as never }) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('false')
    expect(api.fetchProjectSubscriptions).toHaveBeenCalledTimes(2)

    await act(async () => { useSession.setState({ user: { id: 'u1' } as never }) })
    expect(view.container.querySelector('button')?.getAttribute('data-watching')).toBe('true')
    expect(api.fetchProjectSubscriptions).toHaveBeenCalledTimes(2)
  })
})
