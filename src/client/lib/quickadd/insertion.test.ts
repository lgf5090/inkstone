import { describe, expect, it } from 'vitest'
import {
  anchorAllowsSubsections,
  appendAtBottom,
  bodyStartLine,
  extractHeadings,
  findTargetRange,
  headingEndLine,
  insertAfterInline,
  insertAfterLine,
  insertBeforeLine,
  nonHeadingBlockLines,
  onlyHeadingLines,
  orderedSlotFor,
  positionAfterMatch,
  positionAtSectionEnd,
  prependAtBodyStart,
  sectionEndLine,
  splitLines,
  spliceAtSlot,
  toTargetLines,
} from './insertion'

const doc = (text: string): string[] => splitLines(text)

/**
 * Headings a Chinese-writing reader has in their own journal. `check-i18n.mjs` keeps Han literals out
 * of `src/` because user-facing copy belongs in the catalog; note text a placement rule has to read is
 * not copy, and this is the case the date ordering cannot see with `Date.parse`.
 */
const CJK_DATE_FIXTURES = {
  format: 'YYYY年MM月DD日',
  note: '# L\n\n## 2025年12月31日\nx\n\n## 2026年11月01日\ny',
  newHeading: '## 2026年10月08日',
}

describe('headings', () => {
  it('finds ATX headings and ignores the ones that are not headings', () => {
    const lines = doc([
      '---',
      'title: "# not a heading"',
      '---',
      '# Real',
      '```',
      '# fenced',
      '```',
      '        # indented code',
      '#### Four',
      '####### Seven is not',
    ].join('\n'))
    expect(extractHeadings(lines).map((heading) => [heading.level, heading.text, heading.line]))
      .toEqual([[1, 'Real', 3], [4, 'Four', 8]])
  })

  it('reads a setext heading as two lines', () => {
    const lines = doc('Title\n=====\nbody')
    const heading = extractHeadings(lines)[0]
    expect(heading).toMatchObject({ level: 1, text: 'Title', line: 0 })
    expect(headingEndLine(lines, heading)).toBe(1)
  })

  it('does not mistake a thematic break for a setext underline', () => {
    expect(extractHeadings(doc('- item\n---\nmore'))).toEqual([])
    expect(extractHeadings(doc('two\nlines\nabove\n---'))).toEqual([])
  })

  it('treats a %% comment and a $$ block as no-heading territory', () => {
    const lines = doc('%%\n# hidden\n%%\nshown\n$$\n# also hidden\n$$\n# shown')
    expect(extractHeadings(lines).map((heading) => heading.text)).toEqual(['shown'])
    expect(nonHeadingBlockLines(lines).filter(Boolean).length).toBe(6)
  })

  it('ends a section on its last non-blank line, honouring subsections', () => {
    const lines = doc('# A\ntext\n\n## B\ninner\n\n# C')
    expect(sectionEndLine(lines, 0)).toBe(1)
    expect(sectionEndLine(lines, 0, true)).toBe(4)
    expect(sectionEndLine(lines, 2, true)).toBeNull()
    expect(anchorAllowsSubsections(true, lines, 2)).toBe(false)
    expect(anchorAllowsSubsections(true, lines, 0)).toBe(true)
  })

  it('ends a plain block at the next blank or heading', () => {
    expect(sectionEndLine(doc('para\nmore\n\nnext'), 0)).toBe(1)
    expect(sectionEndLine(doc('para\n# H'), 0)).toBe(0)
    expect(sectionEndLine(doc('para\nmore'), 0)).toBe(1)
  })
})

describe('matching an anchor line', () => {
  it('prefers an exact line, then a whitespace tail, then a suffix', () => {
    const lines = doc('prefix ## Log suffix\n## Log  \nother')
    expect(findTargetRange(lines, ['## Log']).start).toBe(1)
    // A table separator row is found by the anchor that ends it, which is what a
    // `| ----- |` selector means in practice.
    expect(findTargetRange(doc('| a | ----- |\nnext'), ['| ----- |']).start).toBe(0)
  })

  it('matches a multi-line anchor only verbatim, indentation included', () => {
    const flat = doc('- Parent\n- Child')
    expect(findTargetRange(flat, ['- Parent', '- Child']).start).toBe(0)
    const nested = doc('  - Parent\n    - Child')
    expect(findTargetRange(nested, ['- Parent', '- Child']).start).toBe(-1)
    expect(findTargetRange(nested, ['  - Parent', '    - Child']).start).toBe(0)
  })

  it('drops the trailing blank a \\n escape leaves, keeping an interior blank', () => {
    expect(toTargetLines('a\n')).toEqual(['a'])
    expect(toTargetLines('a\n\n')).toEqual(['a'])
    expect(toTargetLines('a\n\nb')).toEqual(['a', '', 'b'])
  })

  it('can restrict the search to heading lines', () => {
    const lines = doc('key: ## Log\n## Log\nbody')
    expect(findTargetRange(onlyHeadingLines(lines), ['## Log']).start).toBe(1)
  })

  it('refuses an empty anchor instead of matching the first blank line', () => {
    expect(findTargetRange(doc('\n\n'), ['']).start).toBe(-1)
  })
})

describe('splicing text in', () => {
  it('skips blank lines after the match only where the mode allows', () => {
    const lines = doc('# H\n\n\nbody')
    // `auto` skips the blanks only under a heading, which is where a capture belongs after the gap.
    expect(positionAfterMatch(lines, 0, '# H\n\n\nbody', 'auto')).toBe(2)
    expect(positionAfterMatch(lines, 0, '# H\n\n\nbody', 'skip')).toBe(2)
    expect(positionAfterMatch(lines, 0, '# H\n\n\nbody', 'none')).toBe(0)
    expect(positionAfterMatch(doc('text\n\nbody'), 0, 'text\n\nbody', 'auto')).toBe(0)
  })

  it('inserts below a heading without eating its blank line', () => {
    const placed = insertAfterLine('# Log\n\nbefore', 0, 'entry')
    expect(placed.content).toBe('# Log\nentry\n\nbefore')
    expect(placed.changed).toBe(true)
  })

  it('drops the newline a task adds when a blank line already follows', () => {
    expect(insertAfterLine('- [ ] one\n\nnext', 0, '- [ ] two\n', { task: true }).content)
      .toBe('- [ ] one\n- [ ] two\nnext')
    expect(insertAfterLine('- [ ] one\n\nnext', 0, '- [ ] two\n', { task: false }).content)
      .toBe('- [ ] one\n- [ ] two\n\nnext')
  })

  it('ends the inserted line when anything follows it', () => {
    expect(insertAfterLine('a\nb', 0, 'x').content).toBe('a\nx\nb')
    expect(insertAfterLine('a\n', 0, 'x').content).toBe('a\nx')
  })

  it('keeps the caret where the marker said', () => {
    const placed = insertAfterLine('a\nb', 0, 'xy', { cursor: 1 })
    expect(placed.cursor).toBe(3)
  })

  it('inserts before the whole matched block', () => {
    expect(insertBeforeLine('a\nb', 1, 'x').content).toBe('a\nx\nb')
    expect(insertBeforeLine('a', 0, 'x').content).toBe('x\na')
  })

  it('appends at the bottom and terminates the last line once', () => {
    expect(appendAtBottom('a', 'b\n').content).toBe('a\nb\n')
    expect(appendAtBottom('a\n', 'b').content).toBe('a\nb')
    expect(appendAtBottom('> q', '> r').content).toBe('> q\n\n> r')
  })

  it('puts a capture under the front matter, not inside it', () => {
    const body = '---\ntitle: x\n---\n# H\n'
    expect(bodyStartLine(body)).toBe(3)
    expect(prependAtBodyStart(body, 'new').content).toBe('---\ntitle: x\n---\nnew\n# H\n')
    expect(prependAtBodyStart('# H', 'new').content).toBe('new\n# H')
  })

  it('holds at the section end unless the entry carries its own newline', () => {
    const lines = doc('# A\nbody\n\n\n# B')
    // Blanks that lead to another heading are not the section's end, so the entry stays put.
    expect(positionAtSectionEnd(lines, 1, '# A\nbody\n\n\n# B', 'x\n')).toBe(1)
    // At the end of the note one trailing blank is kept below the entry, so repeated captures stack.
    expect(positionAtSectionEnd(splitLines('# A\nbody\n\n\n'), 1, '# A\nbody\n\n\n', 'x\n')).toBe(3)
    expect(positionAtSectionEnd(lines, 1, '# A\nbody\n\n\n# B', 'x')).toBe(1)
  })

  it('inserts after a phrase inside the line, and can drop the rest of it', () => {
    const hit = insertAfterInline('a bb c', 'bb', '!', false)
    expect(hit.matched).toBe(true)
    expect(hit.result.content).toBe('a bb! c')
    // The caret lands at the end of what was inserted, not at the end of the note.
    expect(hit.result.cursor).toBe(5)
    expect(insertAfterInline('a bb c', 'bb', '!', true).result.content).toBe('a bb!')
    expect(insertAfterInline('x y LAST', 'y', '!', true).result.content).toBe('x y!')
    expect(insertAfterInline('a bb c', 'zz', '!').matched).toBe(false)
    expect(insertAfterInline('a bb c', '', '!').matched).toBe(false)
  })
})

describe('creating a heading at its sorted place', () => {
  const body = '# Log\n\n## 2026-01-02\nold\n\n## 2026-01-01\nolder'

  it('puts the newest first when the direction is descending', () => {
    const slot = orderedSlotFor(splitLines(body), '## 2026-01-03', {
      by: 'date', direction: 'desc', dateFormat: 'YYYY-MM-DD',
    }, 'en-US')
    expect(slot).toEqual({ mode: 'before', line: 2 })
  })

  it('puts the oldest first when the direction is ascending', () => {
    const slot = orderedSlotFor(splitLines(body), '## 2025-12-31', {
      by: 'date', direction: 'asc', dateFormat: 'YYYY-MM-DD',
    }, 'en-US')
    expect(slot.mode).toBe('before')
  })

  it('sorts numbers by value and words by the locale', () => {
    const numbers = splitLines('# L\n\n## 9\n## 10')
    expect(orderedSlotFor(numbers, '## 100', { by: 'numeric', direction: 'asc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'after', line: 3 })
    expect(orderedSlotFor(numbers, '## 5', { by: 'numeric', direction: 'asc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 2 })
    const words = splitLines('# L\n\n## Beta\n## Gamma')
    expect(orderedSlotFor(words, '## Alpha', { by: 'lexical', direction: 'asc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 2 })
  })

  it('lets a heading it cannot read sink to the end of the band', () => {
    const lines = splitLines('# L\n\n## 2026-01-01\nx\n\n## someday')
    // 2025-12-31 does not precede the dated sibling, but it does belong above the unreadable one.
    expect(orderedSlotFor(lines, '## 2025-12-31', { by: 'date', direction: 'desc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 5 })
    expect(orderedSlotFor(lines, '## 2099-01-01', { by: 'date', direction: 'desc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 2 })
    // A new key the rule cannot read at all is appended, not slotted in by guesswork.
    expect(orderedSlotFor(lines, '## someday else', { by: 'date', direction: 'desc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'after', line: 5 })
  })

  it('walks past a sibling with the same key as the new one', () => {
    const lines = splitLines('# L\n\n## 2026-01-01\nfirst\n\n## 2026-01-02\nsecond')
    // Two captures on the same day stack under the first one rather than shuffling it down.
    expect(orderedSlotFor(lines, '## 2026-01-01', { by: 'date', direction: 'asc', dateFormat: 'YYYY-MM-DD' }, 'en-US'))
      .toEqual({ mode: 'before', line: 5 })
  })

  it('reads a heading in the format the choice names, and in ISO when it names none', () => {
    const lines = splitLines(CJK_DATE_FIXTURES.note)
    expect(orderedSlotFor(lines, CJK_DATE_FIXTURES.newHeading, {
      by: 'date', direction: 'asc', dateFormat: CJK_DATE_FIXTURES.format,
    }, 'en-US')).toEqual({ mode: 'before', line: 5 })
    expect(orderedSlotFor(splitLines('# L\n\n## 2026-06-14 (Friday)\nx'), '## 2026-06-01', {
      by: 'date', direction: 'asc', dateFormat: '',
    }, 'en-US')).toEqual({ mode: 'before', line: 2 })
  })

  it('uses the band order when nothing is parsed', () => {
    const lines = splitLines('# L\n\n## newest\n## oldest')
    expect(orderedSlotFor(lines, '## brand new', { by: 'insertion', direction: 'desc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 2 })
    expect(orderedSlotFor(lines, '## brand new', { by: 'insertion', direction: 'asc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'after', line: 3 })
  })

  it('pads the created block away from its neighbours', () => {
    const spliced = spliceAtSlot('# L\n\n## B\n', { mode: 'before', line: 2 }, '## A\ncapture')
    expect(spliced.content).toBe('# L\n\n## A\ncapture\n\n## B\n')
  })
})
