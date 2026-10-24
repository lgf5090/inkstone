import { describe, expect, it } from 'vitest'
import { emailAttachmentCategory, EMAIL_ATTACHMENT_CATEGORIES } from './model'
import { parseEmailSearchQuery } from './search'
import {
  buildEmailQuoteMarkdown,
  emailSnippet,
  formatEmailQuotedDate,
  isValidEmailAddress,
  splitEmailList,
  stripEmailHtmlToText,
} from './format'

describe('email search parser', () => {
  it('parses quoted and unquoted operators with free text', () => {
    const parsed = parseEmailSearchQuery('from:"John Doe" subject:invoice is:unread has:attachment quarterly')
    expect(parsed.from).toBe('John Doe')
    expect(parsed.subject).toBe('invoice')
    expect(parsed.isRead).toBe(false)
    expect(parsed.hasAttachment).toBe(true)
    expect(parsed.query).toBe('quarterly')
  })

  it('parses folder and date bounds', () => {
    const parsed = parseEmailSearchQuery('in:Archive after:2026-01-01 before:2026-02-01')
    expect(parsed.folder).toBe('archive')
    expect(parsed.dateStart).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.dateEnd).toBe('2026-02-01T00:00:00.000Z')
  })

  it('treats unknown operators as text', () => {
    expect(parseEmailSearchQuery('near:here hello').query).toBe('near:here hello')
  })
})

describe('email formatting', () => {
  it('strips tags and decodes entities for snippets', () => {
    expect(stripEmailHtmlToText('<p>Hello&nbsp;<b>world</b></p>')).toBe('Hello world')
    expect(emailSnippet('<style>x</style><p>a &amp; b</p>', 4)).toBe('a & ...')
  })

  it('builds a markdown quote instead of injecting html', () => {
    const quote = buildEmailQuoteMarkdown('2026-10-22T10:00:00.000Z', 'a@example.com', '<p>first</p><p>second</p>')
    expect(quote).toContain('a@example.com wrote:')
    expect(quote).toContain('> first second')
    expect(quote).not.toContain('<p>')
  })

  it('formats a quoted date and validates addresses', () => {
    expect(formatEmailQuotedDate('2026-10-22T10:00:00.000Z')).toContain('2026')
    expect(isValidEmailAddress('a@example.com')).toBe(true)
    expect(isValidEmailAddress('not-an-address')).toBe(false)
    expect(splitEmailList('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
  })
})

describe('email attachment categories', () => {
  it('maps mime and extension to a bucket', () => {
    expect(emailAttachmentCategory('image/png', 'a.png')).toBe('images')
    expect(emailAttachmentCategory('application/pdf', 'a.pdf')).toBe('docs')
    expect(emailAttachmentCategory('audio/mpeg', 'a.mp3')).toBe('audio')
    expect(emailAttachmentCategory('video/mp4', 'a.mp4')).toBe('video')
    expect(emailAttachmentCategory('application/zip', 'a.zip')).toBe('archives')
    expect(emailAttachmentCategory('text/plain', 'a.ts')).toBe('code')
    expect(emailAttachmentCategory('application/octet-stream', 'a.bin')).toBe('other')
    expect(EMAIL_ATTACHMENT_CATEGORIES).toContain('docs')
  })
})
