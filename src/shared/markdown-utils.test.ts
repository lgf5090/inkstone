import { describe, expect, it } from 'vitest'
import { countText, deriveExcerpt, deriveTitle, extractAttachmentIds, extractTags, extractWikiLinks, isUsableTagName, replaceTagInContent, toPlainText } from './markdown-utils'

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
