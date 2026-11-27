import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'

describe('RSS saved views in account settings', () => {
  it('persists a valid view through settings merge and patch', () => {
    const view = { id: 'view-ai', name: 'Unread AI', channel: 'feed:f1', query: 'author:Rae is:unread', sort: 'oldest' }
    const merged = mergeSettings({ rss: { savedViews: [view] } })
    expect(merged.rss.savedViews).toEqual([view])
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, { rss: { savedViews: [view] } })
    expect(patched.rss.savedViews).toEqual([view])
  })

  it('drops unknown channels and caps the list instead of trimming silently', () => {
    const views = Array.from({ length: 25 }, (_, index) => ({
      id: `view-${index}`, name: `View ${index}`, channel: 'all', query: '', sort: 'newest',
    }))
    expect(mergeSettings({ rss: { savedViews: [...views, { ...views[0], channel: 'private:admin' }] } }).rss.savedViews).toHaveLength(20)
  })

  it('gives each settings clone its own saved-view array', () => {
    const first = mergeSettings({})
    const second = mergeSettings({})
    first.rss.savedViews.push({ id: 'view-1', name: 'One', channel: 'all', query: '', sort: 'newest' })
    expect(second.rss.savedViews).toEqual([])
  })
})
