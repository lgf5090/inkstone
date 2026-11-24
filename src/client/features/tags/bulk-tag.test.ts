import { describe, expect, it } from 'vitest'
import { addTagToNoteContent } from './bulk-tag'

describe('addTagToNoteContent', () => {
  it('creates front matter for a plain note and keeps its body unchanged', () => {
    expect(addTagToNoteContent('Body\n\nMore', 'work')).toBe('---\ntags: [work]\n---\n\nBody\n\nMore')
  })

  it('preserves an existing flow list and does not duplicate a tag', () => {
    const once = addTagToNoteContent('---\ntags: [daily]\n---\nBody', 'work')
    expect(once).toContain('tags: [daily, work]')
    expect(addTagToNoteContent(once, 'work')).toBe(once)
  })

  it('ignores a blank tag instead of adding empty front matter', () => {
    expect(addTagToNoteContent('Body', '  # ')).toBe('Body')
  })
})
