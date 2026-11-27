import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { emptyLibrary, newFeed, type RssEntry } from '@shared/rss/model'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { EntryRows } from './RssListParts'

const feed = newFeed('f1', 'https://example.com/feed', 'Example', 0)
const entry: RssEntry = {
  id: 'e1', feedId: feed.id, title: 'A concise title', link: 'https://example.com/1',
  author: '', publishedTs: 1, summary: 'A very long summary '.repeat(80), content: '', imageUrl: '', audioUrl: '',
}

beforeAll(async () => { await initI18n() })

describe('article row accessibility', () => {
  it('names the row by its title and exposes selection as a button state', () => {
    const rendered = renderElement(createElement(EntryRows, {
      entries: [entry],
      library: { ...emptyLibrary(), feeds: [feed] },
      readIds: new Set<string>(),
      starred: new Set<string>(),
      picked: new Set<string>(),
      selected: '',
      density: 'comfortable',
      images: 'off',
      thumbnail: false,
      groupByDay: false,
      onPick: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    }))
    const button = rendered.container.querySelector<HTMLButtonElement>('button[data-entry="e1"]')
    expect(button?.getAttribute('aria-label')).toBe(entry.title)
    expect(button?.getAttribute('aria-label')).not.toContain('very long summary')
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    expect(button?.hasAttribute('aria-selected')).toBe(false)
    expect(button?.getAttribute('aria-current')).toBeNull()
    rendered.unmount()
  })
})
