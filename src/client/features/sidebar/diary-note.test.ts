import { describe, expect, it } from 'vitest'
import { extractTags, parseFrontMatter } from '@shared/markdown-utils'
import { buildDiaryContent } from './diary-note'

const KEY = '2026-10-28'

const cases = [
  { label: 'plain copy', title: 'Diary 2026-10-28', tag: 'diary' },
  { label: 'a double quote', title: 'Diary "2026-10-28" \\ end', tag: 'diary' },
  { label: 'a colon in the tag', title: 'Diary 2026-10-28', tag: 'daily: journal' },
  { label: 'an early document break', title: 'Diary\n---\ninjected: true', tag: 'diary' },
  { label: 'a leading dash', title: '- Diary 2026-10-28', tag: 'diary' },
]

describe('buildDiaryContent', () => {
  for (const item of cases) {
    it(`round-trips a title and tag carrying ${item.label}`, () => {
      const content = buildDiaryContent(KEY, item.title, item.tag)
      expect(content.startsWith('---\n')).toBe(true)
      const parsed = parseFrontMatter(content)
      expect(parsed.errors, content).toEqual([])
      expect(parsed.data.title).toBe(item.title)
      expect(parsed.data.tags).toEqual([item.tag])
    })
  }

  it('stamps the diary with the day it is about, not a invented minute', () => {
    const first = buildDiaryContent(KEY, 'Diary 2026-10-28', 'diary')
    const second = buildDiaryContent(KEY, 'Diary 2026-10-28', 'diary')
    expect(first).toBe(second)
    expect(first).toContain('createdAt: 2026-10-28 00:00:00\n')
  })

  it('leaves the diary tag findable by the tag reader', () => {
    expect(extractTags(buildDiaryContent(KEY, 'Diary 2026-10-28', 'diary'))).toEqual(['diary'])
  })
})
