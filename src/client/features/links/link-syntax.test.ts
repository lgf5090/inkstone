import { describe, expect, it } from 'vitest'
import {
  collectLinks,
  copyAsMarkdown,
  copyAsWiki,
  defaultWikiText,
  displayTextOf,
  findLinkAt,
  headingsIn,
  isExternalTarget,
  isImageTarget,
  padNewLink,
  serializeLink,
  splitTarget,
  unwrapTextOf,
  type LinkMatch,
} from './link-syntax'

const WIKI_OPTIONS = { wiki: true, markdown: true, url: true, image: true }

function match(over: Partial<LinkMatch>): LinkMatch {
  return {
    kind: 'wiki',
    embed: false,
    image: false,
    raw: '',
    start: 0,
    end: 0,
    text: '',
    target: '',
    hasText: false,
    ...over,
  }
}

function only(line: string): LinkMatch {
  const found = collectLinks(line, WIKI_OPTIONS)
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('findLinkAt', () => {
  it('finds a wiki link anywhere inside its own span', () => {
    const line = 'Read [[Deep Notes]] for more.'
    const start = line.indexOf('[')
    for (const offset of [start, start + 5, line.indexOf(']]') + 1]) {
      expect(findLinkAt(line, offset)?.target).toBe('Deep Notes')
    }
  })

  it('does not claim the character right after a link unless asked to', () => {
    const line = '[[Note]] tail'
    expect(findLinkAt(line, 8)).toBeNull()
    expect(findLinkAt(line, 8, WIKI_OPTIONS, true)?.target).toBe('Note')
  })

  it('keeps the alias separate from the target', () => {
    const found = only('See [[Some Note|the write-up]].')
    expect(found).toMatchObject({ kind: 'wiki', target: 'Some Note', text: 'the write-up', hasText: true })
  })

  it('derives the display text when the source carries no alias', () => {
    const found = only('See [[folder/Some Note]].')
    expect(found.hasText).toBe(false)
    expect(found.text).toBe('Some Note')
  })

  it('treats an embedded image as its own kind and keeps an empty label', () => {
    const image = only('![[diagram.png]]')
    expect(image).toMatchObject({ kind: 'wiki', embed: true, image: true, text: '' })
  })

  it('reads a markdown link and its label', () => {
    const found = only('Go to [the site](https://example.com/a) now.')
    expect(found).toMatchObject({ kind: 'markdown', text: 'the site', target: 'https://example.com/a' })
  })

  it('keeps an angle-bracketed destination and drops its title', () => {
    const found = only('[x](<my file.md> "the title")')
    expect(found.target).toBe('my file.md')
  })

  it('finds a bare url and trims the sentence punctuation after it', () => {
    const found = only('Visited https://example.com/a?b=1.')
    expect(found).toMatchObject({ kind: 'url', target: 'https://example.com/a?b=1' })
  })

  it('does not report a url that is already inside a link', () => {
    const line = '[docs](https://example.com)'
    expect(collectLinks(line, WIKI_OPTIONS)).toHaveLength(1)
    expect(collectLinks(line, WIKI_OPTIONS)[0]!.kind).toBe('markdown')
  })

  it('leaves a url written inside inline code alone', () => {
    expect(findLinkAt('run `https://example.com` here', 6)).toBeNull()
  })

  it('honours the per-kind switches', () => {
    const line = '[[Note]] [a](https://x.dev) https://y.dev'
    expect(collectLinks(line, { wiki: true, markdown: false, url: false, image: true })).toHaveLength(1)
    expect(collectLinks(line, { wiki: false, markdown: true, url: false, image: true })).toHaveLength(1)
    expect(collectLinks(line, { wiki: false, markdown: false, url: true, image: true }).map((item) => item.target))
      .toEqual(['https://x.dev', 'https://y.dev'])
  })

  it('stops reporting image links when images are switched off', () => {
    const line = '![[shot.png]] and [[Note]]'
    expect(collectLinks(line, { wiki: true, markdown: true, url: true, image: false })).toHaveLength(1)
    expect(collectLinks(line, WIKI_OPTIONS)).toHaveLength(2)
  })

  it('orders several links on one line by where they are', () => {
    const found = collectLinks('[[b]] [a](https://x.dev) https://y.dev', WIKI_OPTIONS)
    expect(found.map((item) => item.kind)).toEqual(['wiki', 'markdown', 'url'])
    expect(found.map((item) => item.start)).toEqual([0, 6, 25])
  })
})

describe('serializeLink', () => {
  it('writes an internal target back as a wiki link, keeping the alias only when it differs', () => {
    const source = match({ kind: 'wiki', raw: '[[Note]]', target: 'Note' })
    expect(serializeLink(source, { text: 'Other', target: 'Other' })).toBe('[[Other]]')
    expect(serializeLink(source, { text: 'the write-up', target: 'Other' })).toBe('[[Other|the write-up]]')
  })

  it('drops an alias that merely repeats the derived name', () => {
    const source = match({ kind: 'wiki', raw: '[[a/Note|Note]]', target: 'a/Note', text: 'Note', hasText: true })
    expect(serializeLink(source, { text: 'Note', target: 'a/Note' })).toBe('[[a/Note]]')
  })

  it('keeps the embed marker on a wiki link', () => {
    const source = match({ kind: 'wiki', embed: true, image: true, raw: '[[shot.png]]', target: 'shot.png' })
    expect(serializeLink(source, { text: '', target: 'shot.png' })).toBe('![[shot.png]]')
  })

  it('turns a markdown link into a wiki link once the target is internal', () => {
    const source = match({ kind: 'markdown', raw: '[Site](https://x.dev)', text: 'Site', target: 'https://x.dev' })
    expect(serializeLink(source, { text: 'Site', target: 'Deep Notes' })).toBe('[[Deep Notes|Site]]')
  })

  it('keeps an external target in markdown shape', () => {
    const source = match({ kind: 'markdown', raw: '[Site](https://x.dev)', text: 'Site', target: 'https://x.dev' })
    expect(serializeLink(source, { text: 'Docs', target: 'https://y.dev' })).toBe('[Docs](https://y.dev)')
  })

  it('degrades a label-less markdown link to the bare address', () => {
    const source = match({ kind: 'markdown', raw: '[](https://x.dev)', text: '', target: 'https://x.dev' })
    expect(serializeLink(source, { text: '', target: 'https://y.dev' })).toBe('https://y.dev')
  })

  it('wraps a destination that contains spaces', () => {
    const source = match({ kind: 'markdown', raw: '[a](https://x.dev)', text: 'a', target: 'https://x.dev' })
    expect(serializeLink(source, { text: 'a', target: 'https://x.dev/my file.png' })).toBe('[a](<https://x.dev/my file.png>)')
  })

  it('falls back to markdown for a target a wiki link cannot hold', () => {
    const source = match({ kind: 'wiki', raw: '[[Note]]', text: 'Note', target: 'Note' })
    expect(serializeLink(source, { text: 'Note', target: 'Note[1]' })).toBe('[Note](Note[1])')
    expect(serializeLink(source, { text: 'Note', target: 'A|B' })).toBe('[Note](A|B)')
  })

  it('escapes brackets in the display text', () => {
    const source = match({ kind: 'markdown', raw: '[a](https://x.dev)', text: 'a', target: 'https://x.dev' })
    expect(serializeLink(source, { text: 'a [b] c', target: 'https://x.dev' })).toBe('[a \\[b\\] c](https://x.dev)')
  })

  it('empties the span when the target is cleared', () => {
    expect(serializeLink(match({ raw: '[[Note]]', target: 'Note' }), { text: 'x', target: '' })).toBe('')
  })

  it('is a no-op for the text the note already holds', () => {
    const source = match({ kind: 'wiki', raw: '[[Note|n]]', target: 'Note', text: 'n', hasText: true })
    expect(serializeLink(source, { text: 'n', target: 'Note' })).toBe(source.raw)
  })
})

describe('copy shapes', () => {
  const wiki = match({ kind: 'wiki', raw: '[[Note]]', target: 'Note', text: 'Note' })
  const image = match({ kind: 'wiki', embed: true, image: true, raw: '![[a.png]]', target: 'a.png' })

  it('copies a wiki link without an alias that repeats the name', () => {
    expect(copyAsWiki(wiki, { text: 'Note', target: 'Note' })).toBe('[[Note]]')
    expect(copyAsWiki(wiki, { text: 'Note', target: 'Other' })).toBe('[[Other|Note]]')
  })

  it('copies markdown with the label and the address spelled out', () => {
    expect(copyAsMarkdown(wiki, { text: 'Note', target: 'Note' })).toBe('[Note](Note)')
    expect(copyAsMarkdown(image, { text: '', target: 'a.png' })).toBe('![](a.png)')
  })
})

describe('target helpers', () => {
  it('splits a note, a heading and a block reference', () => {
    expect(splitTarget('a/B#Heading')).toEqual({ note: 'a/B', heading: 'Heading', block: null })
    expect(splitTarget('#Heading')).toEqual({ note: '', heading: 'Heading', block: null })
    expect(splitTarget('B#^abc')).toEqual({ note: 'B', heading: null, block: 'abc' })
    expect(splitTarget('^abc')).toEqual({ note: '', heading: null, block: 'abc' })
  })

  it('names an address by its scheme and not by a drive letter', () => {
    expect(isExternalTarget('https://x.dev')).toBe(true)
    expect(isExternalTarget('mailto:a@b.dev')).toBe(true)
    expect(isExternalTarget('C:\\notes')).toBe(false)
    expect(isExternalTarget('Some Note')).toBe(false)
  })

  it('recognises an attachment behind its query string', () => {
    expect(isImageTarget('a/b.png?v=2')).toBe(true)
    expect(isImageTarget('a/b#png')).toBe(false)
  })

  it('reduces a wiki target to the name a reader would write', () => {
    expect(defaultWikiText('folder/Deep Notes.md#Part')).toBe('Deep Notes')
    expect(defaultWikiText('#Part')).toBe('')
  })

  it('shows a bare url as its own text', () => {
    expect(displayTextOf(match({ kind: 'url', target: 'https://x.dev' }))).toBe('https://x.dev')
    expect(unwrapTextOf(match({ kind: 'url', target: 'https://x.dev' }))).toBe('https://x.dev')
  })

  it('leaves nothing behind when an image is unwrapped', () => {
    expect(unwrapTextOf(match({ kind: 'wiki', embed: true, image: true, target: 'a.png' }))).toBe('')
  })
})

describe('padNewLink', () => {
  it('adds a space only where the link would touch a word', () => {
    expect(padNewLink('[[A]]', 'one two', 3).text).toBe(' [[A]]')
    expect(padNewLink('[[A]]', 'one two', 4).text).toBe('[[A]] ')
    expect(padNewLink('[[A]]', 'one, two', 4).text).toBe('[[A]]')
    expect(padNewLink('[[A]]', '\u4e00\uff0c\u4e8c', 2).text).toBe('[[A]] ')
  })

  it('puts the cursor after the link and any trailing pad', () => {
    expect(padNewLink('[[A]]', 'one two', 3).cursor).toBe(6)
    expect(padNewLink('[[A]]', 'one two', 4).cursor).toBe(5)
  })

  it('reports the left pad as how far the cursor sits short of the text it returned', () => {
    for (const [line, at] of [['one two', 3], ['one two', 4], ['one, two', 4]] as [string, number][]) {
      const padded = padNewLink('[[A]]', line, at)
      expect(padded.text.slice(padded.cursor - 5, padded.cursor)).toBe('[[A]]')
    }
  })
})

describe('headingsIn', () => {
  it('lists the note headings with their levels', () => {
    expect(headingsIn('# One\nbody\n### Three ###')).toEqual([{ level: 1, text: 'One' }, { level: 3, text: 'Three' }])
  })

  it('ignores a heading written inside a fence', () => {
    expect(headingsIn('```js\n// # fake\n```\n# Real')).toEqual([{ level: 1, text: 'Real' }])
  })

  it('ignores the front matter block', () => {
    expect(headingsIn('---\ntitle: x\n---\n# Real')).toEqual([{ level: 1, text: 'Real' }])
  })

  it('keeps an indented heading inside a list', () => {
    expect(headingsIn('- item\n  # Nested')).toEqual([{ level: 1, text: 'Nested' }])
  })
})
