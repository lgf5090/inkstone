import { describe, expect, it } from 'vitest'
import { DEFAULT_READING_SPEED_WPM, countText, deriveExcerpt, deriveTitle, extractAttachmentIds, extractTags, extractWikiLinks, isUsableTagName, linkFirstMention, mentionContext, readingMinutes, replaceTagInContent, tagNamesEqual, toPlainText, trimFrontMatterLead } from './markdown-utils'

const TAB_NOTE = [
  ':::: tabs',
  '::: tab-item Writing',
  'Body text here',
  ':::',
  '::::',
].join('\n')

describe('tab labels are plain text everywhere', () => {
  const labelled = [':::: tabs', '::: tab-item [[Label Note]]', '[[Body Note]]', ':::', '::::'].join('\n')

  it('does not turn a tab label into a link the preview cannot follow', () => {
    expect(extractWikiLinks(labelled).map((link) => link.target)).toEqual(['Body Note'])
  })

  it('does not count a tag that only exists as a label', () => {
    expect(extractTags(':::: tabs\n::: tab-item #labeltag\n#bodytag\n:::\n::::')).toEqual(['bodytag'])
    expect(extractTags(':::: tabs\n@tab #labeltag\n#bodytag\n::::')).toEqual(['bodytag'])
  })

  it('still counts a wikilink or tag in a details or callout title, which do render it', () => {
    expect(extractWikiLinks('::: details [[Sided Note]]\nbody\n:::').map((link) => link.target)).toEqual(['Sided Note'])
    expect(extractTags('> [!note] #titledtag\nbody')).toEqual(['titledtag'])
  })

  it('renames the real tag without corrupting the label it skipped', () => {
    const note = ':::: tabs\n::: tab-item #solo\nsee #solo here\n:::\n::::'
    const renamed = replaceTagInContent(note, 'solo', 'single')
    expect(renamed).toBe(':::: tabs\n::: tab-item #solo\nsee #single here\n:::\n::::')
  })
})

describe('embed labels in plain text', () => {
  it('keeps the file name when the alias is only a size', () => {
    expect(toPlainText('![[photo.png|120x90]] tail')).toBe('photo.png tail')
    expect(toPlainText('![[assets/sub/photo.png|600]]')).toBe('assets/sub/photo.png'.split('/').pop() ?? '')
    expect(deriveExcerpt('# T\n\n![[photo.png|120x90]]\n\nBODY')).toContain('BODY')
  })

  it('prefers a real alias and drops the embed bang', () => {
    expect(toPlainText('![[Note#Section|Shown]]')).toBe('Shown')
    expect(toPlainText('[[Note|Shown]]')).toBe('Shown')
    expect(toPlainText('![[Note]]')).toBe('Note')
  })
})

describe('container markers in plain text', () => {
  it('drops the colon fence lines but keeps each tab label', () => {
    expect(toPlainText(TAB_NOTE).trim()).toBe('Writing\nBody text here')
  })

  it('keeps a bracketed details label without the brackets or markers', () => {
    expect(toPlainText('::: details [Click to expand]\nhiding\n:::').trim()).toBe('Click to expand\nhiding')
  })

  it('drops a callout type marker but keeps its title', () => {
    expect(toPlainText('> [!WARNING]- Careful\nmore').trim()).toBe('Careful\nmore')
  })

  it('titles a note that opens with a tab set after the first real label', () => {
    expect(deriveTitle(`${TAB_NOTE}\n\n# Heading later`)).toBe('Heading later')
    expect(deriveTitle('::: details [Click to expand]\nhiding\n:::')).toBe('Click to expand')
    expect(deriveTitle(TAB_NOTE)).toBe('Writing')
  })

  it('keeps excerpt and word counts free of container syntax', () => {
    expect(deriveExcerpt(TAB_NOTE)).toBe('Body text here')
    expect(countText(TAB_NOTE).words).toBe(4)
  })

  it('never reads a layout block’s configuration as a title', () => {
    expect(deriveTitle('::: cols center\nthe real first line')).toBe('the real first line')
    expect(deriveTitle('::: justify\nthe real first line')).toBe('the real first line')
    expect(deriveExcerpt('::: cols 1fr 2fr\n# Heading\nbody')).toBe('body')
    expect(toPlainText('::: cols\n- a: b').trim()).toBe('a: b')
  })

  it('leaves ordinary colons and lists untouched', () => {
    expect(toPlainText('::: not a directive\n- a: b').trim()).toBe('not a directive\na: b')
    expect(toPlainText('time:: 12:00')).toContain('time:: 12:00')
  })

  it('ignores container-looking lines inside code fences', () => {
    expect(toPlainText('```\n:::: tabs\n```').trim()).toBe('')
  })
})

describe('tag list separators', () => {
  const tagsOf = (tags: string) => extractTags(['---', `tags: ${tags}`, '---', 'body'].join('\n'))

  it('splits a flow sequence written with a full-width comma', () => {
    expect(tagsOf('[getting-started, Inkstone]')).toEqual(['getting-started', 'Inkstone'])
  })

  it('splits the punctuation a CJK keyboard produces', () => {
    expect(tagsOf('[\u7532\u3001\u4e59]')).toEqual(['\u7532', '\u4e59'])
    expect(tagsOf('[a\uff1bb]')).toEqual(['a', 'b'])
    expect(tagsOf('getting-started\uff0cInkstone')).toEqual(['getting-started', 'Inkstone'])
  })

  it('keeps a well formed list exactly as written', () => {
    expect(tagsOf('[a, b/c]')).toEqual(['a', 'b/c'])
    expect(tagsOf('\n  - a\n  - b/c')).toEqual(['a', 'b/c'])
  })

  it('never yields a name the tag API would reject', () => {
    for (const name of tagsOf('[one two, three#four, five]'))
      expect(isUsableTagName(name)).toBe(true)
    expect(tagsOf('[one two, three#four, five]')).toEqual(['five', 'one', 'two'])
  })
})


describe('tag-shaped aliases are tags', () => {
  const fm = (...lines: string[]) => ['---', ...lines, '---', 'body'].join('\n')

  it('counts a page alias as the tag it names', () => {
    expect(extractTags(fm('aliases: ["#a/b"]'))).toEqual(['a/b'])
    expect(extractTags(fm('Aliases: [ "#a/b" ]'))).toEqual(['a/b'])
    expect(extractTags(fm('alias: "#wip"'))).toEqual(['wip'])
    expect(extractTags(fm('aliases:', "  - '#two'", '  - One'))).toEqual(['two'])
  })

  it('ignores ordinary aliases and dedupes against the tags key', () => {
    expect(extractTags(fm('aliases: [Note B, Plain Name]'))).toEqual([])
    expect(extractTags(fm('tags: [a]', 'aliases: ["#a"]'))).toEqual(['a'])
    expect(extractTags(fm('aliases: ["#a", "#"]'))).toEqual(['a'])
  })

  it('rewrites a page alias when the tag is renamed', () => {
    const next = replaceTagInContent(fm('aliases: ["#a/b"]'), 'a/b', 'x/y')
    expect(next).toContain('aliases: ["#x/y"]')
    expect(extractTags(next)).toEqual(['x/y'])
  })

  it('drops the alias entry when the tag is deleted and keeps the rest', () => {
    const next = replaceTagInContent(fm('aliases: ["#a", Other]'), 'a', null)
    expect(next).toContain('Other')
    expect(next).not.toContain('#a')
  })

  it('leaves an unhashéd alias alone during a rename of the same word', () => {
    const source = fm('aliases: [wip]')
    expect(replaceTagInContent(source, 'wip', 'done')).toBe(source)
  })

  it('does not re-space a tag list it was not asked to change', () => {
    const source = fm('tags: a,b')
    expect(replaceTagInContent(source, 'zzz', 'yyy')).toBe(source)
  })
})

describe('tagNamesEqual', () => {
  it('folds the same things the tag key folds', () => {
    expect(tagNamesEqual('work', 'WORK')).toBe(true)
    expect(tagNamesEqual('work', '\uFF37\uFF2F\uFF32\uFF2B')).toBe(true)
    expect(tagNamesEqual('A/b', 'a/B')).toBe(true)
  })

  it('does not fold what the server does not fold', () => {
    expect(tagNamesEqual('stra\u00DFe', 'STRASSE')).toBe(false)
    expect(tagNamesEqual('caf\u00E9', 'CAFE')).toBe(false)
    expect(tagNamesEqual('a', 'a/b')).toBe(false)
  })
})

describe('isUsableTagName', () => {
  it.each(['a', 'a/b', '\u6807\u7b7e', '\u2162'])('accepts %s', (name) => {
    expect(isUsableTagName(name)).toBe(true)
  })

  it.each(['', 'a b', 'a#b', 'a,b', 'a\uff0cb', 'a\u3001b', 'a;b', 'a\uff1bb'])('rejects %s', (name) => {
    expect(isUsableTagName(name)).toBe(false)
  })
})

describe('extractTags', () => {
  it('handles an unterminated inline-code marker with a mismatched trailing marker', () => {
    expect(extractTags('` #visible ``')).toEqual(['visible'])
  })

  it('does not treat tags in complete inline code or fenced blocks as tags', () => {
    expect(extractTags('`#inline`\n```\n#fenced\n```\n#visible')).toEqual(['visible'])
  })
})

describe('extractAttachmentIds', () => {
  const idA = '01m1r8923zajxnw9y0dhs6sy8j'
  const idB = '01m1r9qq6zb99ef3cqkjrzrn89'

  it('collects plain and angle-bracket references outside code regions', () => {
    expect(extractAttachmentIds(
      `![a](/api/files/${idA})\n\n![b](</api/files/${idB} "t">)`,
    )).toEqual([idA, idB])
  })

  it('ignores references inside ordinary fenced code', () => {
    expect(extractAttachmentIds(
      '```\n![a](/api/files/' + idA + ')\n```\n![b](/api/files/' + idB + ')',
    )).toEqual([idB])
  })

  it('collects references inside md-example fences, which render as live markdown', () => {
    expect(extractAttachmentIds(
      `~~~~md-example title="Image"\n![a](</api/files/${idA} "a">)\n~~~~`,
    )).toEqual([idA])
  })

  it('keeps stripping nested ordinary code inside an md-example fence', () => {
    expect(extractAttachmentIds(
      `~~~~md-example\n\`\`\`\n![a](/api/files/${idA})\n\`\`\`\n![b](/api/files/${idB})\n~~~~`,
    )).toEqual([idB])
  })

  it('accepts the markdown-example alias', () => {
    expect(extractAttachmentIds(
      `~~~markdown-example\n![a](/api/files/${idA})\n~~~`,
    )).toEqual([idA])
  })

  it('does not close an md-example fence on a marker followed by text', () => {
    expect(extractAttachmentIds(
      `~~~~md-example\n![a](/api/files/${idA})\n~~~~ trailing\n![b](/api/files/${idB})`,
    )).toEqual([idA])
  })

  it('collects absolute attachment URLs', () => {
    expect(extractAttachmentIds(`![a](https://inkstone.example.com/api/files/${idA})`)).toEqual([idA])
  })

  it('does not close ordinary fences on markers followed by text', () => {
    expect(extractAttachmentIds(
      `\`\`\`text\nexample\n\`\`\`not-a-close\nmore code\n\`\`\`\n![b](/api/files/${idB})`,
    )).toEqual([idB])
  })

  it('ignores md-example markers inside ordinary code fences', () => {
    expect(extractAttachmentIds(`~~~~text\n\`\`\`md-example\n![a](/api/files/${idA})\n\`\`\`\n~~~~`)).toEqual([])
  })
})

describe('readingMinutes', () => {
  it('keeps a one minute floor for nothing to read', () => {
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(149)).toBe(1)
  })

  it('rounds to the nearest minute at the default speed', () => {
    expect(readingMinutes(450)).toBe(2)
    expect(readingMinutes(DEFAULT_READING_SPEED_WPM * 3)).toBe(3)
  })

  it('honours a slower reading speed', () => {
    expect(readingMinutes(600, 100)).toBe(6)
    expect(readingMinutes(600, 1000)).toBe(1)
  })
})

describe('mention excerpts', () => {
  it('cuts the front matter a window started inside', () => {
    const window = `---\ncreated: 2026-10-08\ntags: []\n---\nThe sentence naming Deep Research Notes here`
    expect(trimFrontMatterLead(window)).toBe('The sentence naming Deep Research Notes here')
  })

  it('keeps a window that begins mid front matter', () => {
    expect(trimFrontMatterLead('tags: []\naliases: []\n---\nbody text')).toBe('body text')
  })

  it('cuts the front matter a new note actually carries', () => {
    const window = '---\ncreated: 2026-10-08T06:43:53.000Z\ntags: []\naliases:\n  - \'\'\n---\njust says Target in passing, no brackets'
    expect(trimFrontMatterLead(window)).toBe('just says Target in passing, no brackets')
  })

  it('leaves a horizontal rule and a colon-led sentence alone', () => {
    const rule = 'First paragraph.\n---\nSecond paragraph.'
    expect(trimFrontMatterLead(rule)).toBe(rule)
    const colon = 'Note: this matters\n---\nstill body'
    expect(trimFrontMatterLead(colon)).toBe(colon)
  })

  it('centres the excerpt on the mention and ellipsises both ends', () => {
    const body = `a${'x'.repeat(200)} TARGET b${'y'.repeat(200)}`
    const out = mentionContext(body, 'TARGET', 10, 10)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toContain('TARGET')
    expect(out.length).toBeLessThan(40)
  })

  it('falls back to the head of the text when the needle is absent', () => {
    expect(mentionContext('no match at all', 'TARGET')).toBe('no match at all')
  })
})

describe('linking a bare mention', () => {
  it('wraps the first plain mention', () => {
    expect(linkFirstMention('see Deep Research Notes today', 'Deep Research Notes'))
      .toBe('see [[Deep Research Notes]] today')
  })

  it('leaves an already-linked title alone and takes the bare one', () => {
    const content = 'first [[Deep Research Notes]] then Deep Research Notes again'
    expect(linkFirstMention(content, 'Deep Research Notes'))
      .toBe('first [[Deep Research Notes]] then [[Deep Research Notes]] again')
  })

  it('does not reach into inline code, fences, front matter or markdown links', () => {
    expect(linkFirstMention('run `Deep Research Notes` now', 'Deep Research Notes'))
      .toBe('run `Deep Research Notes` now')
    expect(linkFirstMention('```\nDeep Research Notes\n```\n', 'Deep Research Notes'))
      .toBe('```\nDeep Research Notes\n```\n')
    expect(linkFirstMention('---\ntitle: Deep Research Notes\n---\nbody', 'Deep Research Notes'))
      .toBe('---\ntitle: Deep Research Notes\n---\nbody')
    expect(linkFirstMention('see [Deep Research Notes](https://x.test/y)', 'Deep Research Notes'))
      .toBe('see [Deep Research Notes](https://x.test/y)')
  })

  it('will not cut a latin title out of a longer word', () => {
    expect(linkFirstMention('that AINT right', 'AI')).toBe('that AINT right')
    expect(linkFirstMention('that AI is right', 'AI')).toBe('that [[AI]] is right')
  })

  it('takes the next occurrence on the same line when the first is inside a word', () => {
    expect(linkFirstMention('AINT and AI', 'AI')).toBe('AINT and [[AI]]')
  })

  it('links a chinese mention mid-sentence', () => {
    const title = String.fromCodePoint(0x6DF1, 0x5EA6, 0x7814, 0x7A76, 0x7B14, 0x8BB0)
    const about = String.fromCodePoint(0x5173, 0x4E8E)
    const ideas = String.fromCodePoint(0x7684, 0x4E00, 0x4E9B, 0x60F3, 0x6CD5)
    expect(linkFirstMention(about + title + ideas, title)).toBe(about + '[[' + title + ']]' + ideas)
  })

  it('links one more mention each time it is called', () => {
    const once = linkFirstMention('Deep Research Notes and Deep Research Notes', 'Deep Research Notes')
    expect(once).toBe('[[Deep Research Notes]] and Deep Research Notes')
    expect(linkFirstMention(once, 'Deep Research Notes')).toBe('[[Deep Research Notes]] and [[Deep Research Notes]]')
  })

  it('matches case but writes the title as it is spelled', () => {
    expect(linkFirstMention('about deep research notes here', 'Deep Research Notes'))
      .toBe('about [[Deep Research Notes]] here')
  })

  it('returns the same string when there is nothing to link', () => {
    const content = 'nothing relevant here\nsecond line'
    expect(linkFirstMention(content, 'Deep Research Notes')).toBe(content)
    expect(linkFirstMention('body', '')).toBe('body')
  })

  it('refuses a title the wikilink grammar cannot hold', () => {
    for (const title of ['a]b', 'a|b', 'a#b']) {
      const content = `see ${title} here`
      expect(linkFirstMention(content, title), title).toBe(content)
    }
  })

  it('keeps its place in a title whose lowercase form is longer than the title', () => {
    const title = 'İstanbul'
    expect(linkFirstMention(`notes about ${title} today`, title)).toBe(`notes about [[${title}]] today`)
    expect(linkFirstMention(`see ${title} and ${title}`, title)).toBe(`see [[${title}]] and ${title}`)
  })
})
