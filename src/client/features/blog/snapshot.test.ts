import { describe, expect, it } from 'vitest'
import { isPublicBlogNote } from './snapshot'

function note(frontMatter: string): string {
  return `---\n${frontMatter}\n---\n\nBody.\n`
}

describe('public embed eligibility', () => {
  it('accepts a published post', () => {
    expect(isPublicBlogNote(note('blogType: post\nisPublished: true'))).toBe(true)
  })

  it('refuses a draft', () => {
    expect(isPublicBlogNote(note('blogType: post\nisPublished: false'))).toBe(false)
  })

  it('refuses a password-protected post even when it is published', () => {
    expect(isPublicBlogNote(note('blogType: post\nisPublished: true\nblogProtected: true'))).toBe(false)
  })

  it('refuses a post scheduled for the future', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect(isPublicBlogNote(note(`blogType: post\nisPublished: true\nblogPublishedAt: ${future}`))).toBe(false)
  })

  it('accepts a post whose schedule has passed', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    expect(isPublicBlogNote(note(`blogType: post\nisPublished: true\nblogPublishedAt: ${past}`))).toBe(true)
  })
})
