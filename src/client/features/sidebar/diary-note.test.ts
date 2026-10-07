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

  it('leaves the diary tag findable by the tag reader', () => {
    expect(extractTags(buildDiaryContent(KEY, 'Diary 2026-10-28', 'diary'))).toEqual(['diary'])
  })
})
