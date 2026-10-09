import { describe, expect, it } from 'vitest'
import { parseFrontMatter } from '@shared/markdown-utils'
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
  isBlankPayload,
  lineSlot,
  mergeTemplateProperties,
  nonHeadingBlockLines,
  onlyHeadingLines,
  orderedSlotFor,
  placeTemplate,
  positionAfterMatch,
  positionAtSectionEnd,
  prependAtBodyStart,
  sectionEndLine,
  splitLines,
  splitTemplate,
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

  it('floats the unreadable headings to the top of the band when the choice says so', () => {
    const lines = splitLines('# L\n\n## 2026-01-01\nx\n\n## someday')
    // The same input the previous test sinks below `## someday` now lands inside the readable run.
    expect(orderedSlotFor(lines, '## 2025-12-31', { by: 'date', direction: 'desc', dateFormat: '', unparseable: 'top' }, 'en-US'))
      .toEqual({ mode: 'after', line: 3 })
    // A new heading the rule cannot read joins the floated group instead of trailing the band.
    expect(orderedSlotFor(lines, '## someday else', { by: 'date', direction: 'desc', dateFormat: '', unparseable: 'top' }, 'en-US'))
      .toEqual({ mode: 'before', line: 2 })
    // Omitting the policy keeps the reference's own behaviour byte for byte.
    expect(orderedSlotFor(lines, '## 2025-12-31', { by: 'date', direction: 'desc', dateFormat: '' }, 'en-US'))
      .toEqual({ mode: 'before', line: 5 })
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

describe('a new line beside the caret’s own line', () => {
  const doc = 'first\nsecond\nthird'

  it('writes above the whole line the caret sits on', () => {
    const slot = lineSlot(doc, 8, 'above', 'CAP', null)
    expect(slot.at).toBe(6)
    expect(slot.insert).toBe('CAP\n')
    expect(doc.slice(0, slot.at) + slot.insert + doc.slice(slot.at)).toBe('first\nCAP\nsecond\nthird')
    expect(slot.caret).toBe(9)
  })

  it('writes below it, keeping the caret inside what was captured', () => {
    const slot = lineSlot(doc, 8, 'below', 'CAP', null)
    expect(slot.at).toBe(12)
    expect(doc.slice(0, slot.at) + slot.insert + doc.slice(slot.at)).toBe('first\nsecond\nCAP\nthird')
    const cursor = lineSlot(doc, 8, 'below', 'a|b', 1)
    expect(cursor.caret).toBe(cursor.at + 2)
  })

  it('handles the first and last lines without inventing a blank one', () => {
    expect(lineSlot(doc, 0, 'above', 'CAP', null).at).toBe(0)
    const belowLast = lineSlot(doc, 17, 'below', 'CAP', null)
    expect(doc.slice(0, belowLast.at) + belowLast.insert + doc.slice(belowLast.at)).toBe('first\nsecond\nthird\nCAP')
  })

  it('refuses to split a note’s properties, from either side', () => {
    const front = '---\nmood: glad\n---\nbody line\n'
    const above = lineSlot(front, 4, 'above', 'CAP', null)
    expect(above.at).toBe(19)
    expect(front.slice(0, above.at) + above.insert + front.slice(above.at)).toBe('---\nmood: glad\n---\nCAP\nbody line\n')
    expect(lineSlot(front, 4, 'below', 'CAP', null).at).toBe(19)
  })

  it('fills an empty line instead of stacking a blank one beside it', () => {
    const middle = lineSlot('a\n\nb', 2, 'below', 'CAP', null)
    expect('a\n\nb'.slice(0, middle.at) + middle.insert + 'a\n\nb'.slice(middle.at)).toBe('a\nCAP\n\nb')
    expect(lineSlot('', 0, 'below', 'CAP', null)).toEqual({ at: 0, insert: 'CAP\n', caret: 3 })
    expect(lineSlot('a\n', 2, 'above', 'CAP', null)).toEqual({ at: 2, insert: 'CAP', caret: 5 })
  })

  it('leaves a note that opens with text alone', () => {
    expect(lineSlot('one line only', 3, 'above', 'CAP', null).at).toBe(0)
    expect(lineSlot('one line only', 3, 'above', 'CAP', null).insert).toBe('CAP\n')
  })
})

describe('what counts as nothing to write', () => {
  it('treats a fullwidth or non-breaking space as content', () => {
    expect(isBlankPayload('\u3000')).toBe(false)
    expect(isBlankPayload('\u00a0')).toBe(false)
    expect(isBlankPayload('\u3000 done')).toBe(false)
  })

  it('reads an ASCII blank answer as nothing', () => {
    expect(isBlankPayload('')).toBe(true)
    expect(isBlankPayload(' \t')).toBe(true)
    expect(isBlankPayload('\r\n\n')).toBe(true)
  })
})

describe('splitting a template', () => {
  it('keeps its own properties apart from the body', () => {
    const parts = splitTemplate('---\nmood: glad\n---\nBody line\n')
    expect(parts.properties).toBe('mood: glad')
    expect(parts.data).toEqual({ mood: 'glad' })
    expect(parts.body).toBe('Body line\n')
    expect(parts.bodyOffset).toBe(19)
  })

  it('reports a plain template as all body', () => {
    const parts = splitTemplate('Body line\n')
    expect(parts.properties).toBeNull()
    expect(parts.body).toBe('Body line\n')
    expect(parts.bodyOffset).toBe(0)
  })

  it('drops an empty properties block instead of carrying the dashes', () => {
    const parts = splitTemplate('---\n---\nBody\n')
    expect(parts.properties).toBeNull()
    expect(parts.body).toBe('Body\n')
  })
})

describe('merging a template’s properties into a note', () => {
  const TEMPLATE = '---\nmood: glad\nstatus: draft\ntags:\n  - b\n  - c\n---\nTemplate body\n'

  it('carries the whole block when the note has none', () => {
    expect(mergeTemplateProperties('# Title\n', TEMPLATE)).toBe('---\nmood: glad\nstatus: draft\ntags:\n  - b\n  - c\n---\n# Title\n')
  })

  it('lets the note keep what it already has and fills the rest', () => {
    const out = mergeTemplateProperties('---\nmood: sad\nstatus:\n---\nBody\n', TEMPLATE)
    const data = parseFrontMatter(out).data
    expect(data.mood).toBe('sad')
    expect(data.status).toBe('draft')
    expect(out.endsWith('Body\n')).toBe(true)
  })

  it('adds to a list-valued key the app treats as a set', () => {
    const out = mergeTemplateProperties('---\ntags: [a, b]\n---\nBody\n', TEMPLATE)
    expect(parseFrontMatter(out).data.tags).toEqual(['a', 'b', 'c'])
  })

  it('leaves an ordinary list alone rather than merging into it', () => {
    const out = mergeTemplateProperties('---\nsteps: [a]\n---\nBody\n', '---\nsteps:\n  - b\n---\nT\n')
    expect(parseFrontMatter(out).data.steps).toEqual(['a'])
  })

  it('skips a value the properties block cannot express', () => {
    const out = mergeTemplateProperties('---\na: 1\n---\nBody\n', '---\nmeta:\n  name: x\n---\nT\n')
    expect(out).not.toContain('meta')
    expect(out).toContain('a: 1')
  })

  it('refuses a prototype-pollution key from a template written elsewhere', () => {
    const out = mergeTemplateProperties('# Title\n', '---\n__proto__: polluted\n---\nT\n')
    expect(out).not.toContain('proto')
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('leaves a template without properties untouched', () => {
    expect(mergeTemplateProperties('---\na: 1\n---\nBody\n', '---\na: 1\n---\nBody\n')).toBe('---\na: 1\n---\nBody\n')
  })
})

describe('placing a template into a note', () => {
  it('merges its properties above and its body at the caret', () => {
    const placed = placeTemplate({
      text: '# Title\n', from: 8, to: 8, drop: 'cursor', template: '---\nmood: glad\n---\nCAP\n', cursor: null,
    })
    expect(placed).toEqual({ content: '---\nmood: glad\n---\n# Title\nCAP\n', cursor: 31, changed: true })
  })

  it('replaces what the reader had selected', () => {
    const placed = placeTemplate({ text: 'start OLD end', from: 6, to: 9, drop: 'cursor', template: 'X', cursor: null })
    expect(placed?.content).toBe('start X end')
  })

  it('refuses to write inside the note’s own properties', () => {
    const placed = placeTemplate({ text: '---\na: 1\n---\nbody\n', from: 4, to: 4, drop: 'cursor', template: 'CAP\n', cursor: null })
    expect(placed?.content).toBe('---\na: 1\n---\nCAP\nbody\n')
  })

  it('keeps a caret marker on the text it marked, past the merged properties', () => {
    const template = '---\nm: 1\n---\nALPHA|OMEGA\n'
    const placed = placeTemplate({ text: 'body\n', from: 5, to: 5, drop: 'cursor', template, cursor: template.indexOf('|') })
    expect(placed?.content).toBe('---\nm: 1\n---\nbody\nALPHA|OMEGA\n')
    expect(placed.content.slice(placed.cursor ?? -1, (placed.cursor ?? -1) + 6)).toBe('|OMEGA')
  })

  it('drops the body below the properties when the template starts the note', () => {
    const placed = placeTemplate({ text: '---\na: 1\n---\nbody\n', from: 0, to: 0, drop: 'top', template: '## T\n', cursor: null })
    expect(placed?.content).toBe('---\na: 1\n---\n## T\nbody\n')
  })

  it('leaves exactly one blank line above a bottom template', () => {
    const placed = placeTemplate({ text: 'a\n\n\n', from: 0, to: 0, drop: 'bottom', template: '\n\n## T\nbody\n', cursor: null })
    expect(placed?.content).toBe('a\n\n## T\nbody\n')
    const empty = placeTemplate({ text: '   \n\n', from: 0, to: 0, drop: 'bottom', template: '## T\n', cursor: null })
    expect(empty?.content).toBe('## T\n')
  })

  it('replaces the whole note when that is what the drop says', () => {
    const template = '---\nnew: 2\n---\nFresh\n'
    const placed = placeTemplate({ text: '---\nold: 1\n---\nBody\n', from: 0, to: 0, drop: 'replace', template, cursor: template.indexOf('Fresh') })
    expect(placed?.content).toBe(template)
    expect(placed.content.slice(placed.cursor ?? -1, (placed.cursor ?? -1) + 5)).toBe('Fresh')
  })

  it('still merges when the template has nothing but properties', () => {
    const placed = placeTemplate({ text: '# Title\n', from: 8, to: 8, drop: 'cursor', template: '---\nm: 1\n---\n\n', cursor: null })
    expect(placed?.content).toBe('---\nm: 1\n---\n# Title\n')
    expect(placed?.changed).toBe(true)
  })

  it('says nothing changed when a plain template lands on an empty drop', () => {
    const placed = placeTemplate({ text: 'body\n', from: 5, to: 5, drop: 'cursor', template: '', cursor: null })
    expect(placed?.changed).toBe(false)
  })
})
