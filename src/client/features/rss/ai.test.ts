/**
 * What the reader's key is asked, in the reader's name.
 *
 * These two builders are the whole of what leaves the device for a model: the article as text a
 * sanitizer already stripped, the passage the reader marked, and the question they typed. Markup
 * would be more tokens and more ways for a feed to talk to the model than the reader meant, and an
 * uncapped passage would spend the reader's money on text nobody is asking about.
 */
import { describe, expect, it } from 'vitest'
import { type RssEntry, type RssFeed } from '@shared/rss/model'
import { buildExcerptPrompts, buildPrompts } from './ai'

const feed: RssFeed = { id: 'f1', url: 'https://x.test/feed', title: 'A weekly', siteUrl: '', imageUrl: '', groupId: '', tags: [], order: 0, updatedAt: 0, lastAttemptAt: 0, error: '', errorCount: 0, lastErrorAt: 0, etag: '', lastModified: '', paused: false }
const entry: RssEntry = {
  id: 'e1', feedId: 'f1', title: 'On passages', link: 'https://x.test/1', author: 'Author',
  publishedTs: null, summary: '', content: '<p>First paragraph.</p><p>Second one.</p>', imageUrl: '', audioUrl: '',
}

describe('the whole-article ask', () => {
  it('carries the byline and the text, and no markup', () => {
    const [system, user] = buildPrompts(entry, feed, 'summary', 'interface')
    expect(user).toContain('A weekly / Author / On passages')
    expect(user).toContain('First paragraph.')
    expect(user).not.toContain('<p>')
    expect(system).toMatch(/no preamble/i)
  })

  it('names the language the reader asked the answer in', () => {
    expect(buildPrompts(entry, feed, 'translation', 'interface')[1]).toMatch(/into (Simplified Chinese|English)/)
    expect(buildPrompts(entry, feed, 'translation', 'source')[1]).toMatch(/into the language the article is written in/)
  })
})

describe('the passage ask', () => {
  it('puts the question and the marked passage first', () => {
    const [system, user] = buildExcerptPrompts('Who is this about?', 'Second one.', entry, feed, 'interface')
    expect(user.indexOf('Who is this about?')).toBeLessThan(user.indexOf('Second one.'))
    expect(user.indexOf('Second one.')).toBeLessThan(user.indexOf('On passages'))
    expect(user).toContain('First paragraph.')
    expect(system).toContain('does not answer')
  })

  it('caps what a long selection or a long question can spend', () => {
    const [, user] = buildExcerptPrompts('q'.repeat(900), 'x'.repeat(9000), entry, feed, 'interface')
    expect(user).toContain('x'.repeat(4000))
    expect(user).not.toContain('x'.repeat(4001))
    expect(user).toContain('q'.repeat(500))
    expect(user).not.toContain('q'.repeat(501))
  })

  it('sends the passage as text even when the article is markup', () => {
    const [, user] = buildExcerptPrompts('Why?', 'anything', { ...entry, content: '<img src=x onerror=alert(1)><script>bad()</script><p>Real words.</p>' }, feed, 'interface')
    expect(user).toContain('Real words.')
    expect(user).not.toContain('<script>')
    expect(user).not.toContain('onerror')
  })
})
