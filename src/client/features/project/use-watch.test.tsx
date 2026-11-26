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

function Probe(): ReactElement {
  const { watching } = useProjectWatch('board', 'b1')
  return createElement('button', { 'data-watching': String(watching) }, 'watch')
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
