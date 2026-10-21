import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import {
  MEMO_DOMAINS,
  bump,
  isMemoDomain,
  revisionOf,
  subscribeRevision,
  useRevision,
  type MemoDomain,
} from './events'

function Probe({ domain }: { domain: MemoDomain }) {
  return createElement('span', { 'data-revision': useRevision(domain) })
}

describe('memo revision bus', () => {
  it('counts a bump on every domain', () => {
    for (const domain of MEMO_DOMAINS) {
      const before = revisionOf(domain)
      bump(domain)
      expect(revisionOf(domain)).toBe(before + 1)
    }
  })

  it('notifies only the subscribers of the bumped domain', () => {
    const list = vi.fn()
    const detail = vi.fn()
    const stopList = subscribeRevision('list', list)
    const stopDetail = subscribeRevision('detail', detail)
    bump('list')
    expect(list).toHaveBeenCalledTimes(1)
    expect(detail).not.toHaveBeenCalled()
    stopList()
    stopDetail()
    bump('list')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after the returned unsubscribe runs', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRevision('views', listener)
    unsubscribe()
    bump('views')
    expect(listener).not.toHaveBeenCalled()
    bump('views')
    expect(listener).not.toHaveBeenCalled()
  })

  it('recognises the domain names and nothing else', () => {
    for (const domain of MEMO_DOMAINS) expect(isMemoDomain(domain)).toBe(true)
    expect(isMemoDomain('memos')).toBe(false)
    expect(isMemoDomain(1)).toBe(false)
    expect(isMemoDomain(null)).toBe(false)
  })

  it('re-renders a component when its domain is bumped', () => {
    const view = renderElement(createElement(Probe, { domain: 'list' }))
    try {
      expect(view.container.querySelector('span')?.getAttribute('data-revision')).toBe(String(revisionOf('list')))
      act(() => bump('list'))
      expect(view.container.querySelector('span')?.getAttribute('data-revision')).toBe(String(revisionOf('list')))
      act(() => bump('detail'))
      expect(view.container.querySelector('span')?.getAttribute('data-revision')).toBe(String(revisionOf('list')))
    } finally {
      view.unmount()
    }
  })
})
