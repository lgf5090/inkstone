import { describe, expect, it } from 'vitest'
import { emptyCrossrefRegistry, nameCrossrefBlocks, readCrossrefLine, registerCrossref, takeCrossrefLabel, takeCrossrefSuffix } from './crossref'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

// i18n is left uninitialised on purpose: `t()` then returns the key, so an assertion names the copy slot
// rather than a translation that may be reworded.

const LABELLED_MATH = '$$E = mc^2 \\label{eq:einstein}$$\n\nAs @eq:einstein shows.\n'
const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\n{#tbl:results}\n\nSee @tbl:results.\n'

describe('naming a block', () => {
  it('reads a marker line only for the kind it was written under', () => {
    expect(readCrossrefLine('{#tbl:results}', 'tbl')).toBe('results')
    expect(readCrossrefLine('{#fig:results}', 'tbl')).toBeNull()
    expect(readCrossrefLine('{#results}', 'eq')).toBe('results')
  })

  it('refuses a name a block id could not carry', () => {
    expect(readCrossrefLine('{#two words}', 'tbl')).toBeNull()
    expect(readCrossrefLine('{#}', 'tbl')).toBeNull()
    expect(readCrossrefLine('{#tbl:a-b_1}', 'tbl')).toBe('a-b_1')
    expect(readCrossrefLine('not {#tbl:x} alone', 'tbl')).toBeNull()
  })

  it('takes TeX’s own label out of the body', () => {
    const taken = takeCrossrefLabel('x \\label{eq:foo} + y', 'eq')
    expect(taken.name).toBe('foo')
    expect(taken.body).toBe('x  + y')
  })

  it('leaves a body whose label names another kind alone', () => {
    const taken = takeCrossrefLabel('\\label{tbl:foo} x', 'eq')
    expect(taken.name).toBeNull()
    expect(taken.body).toBe('\\label{tbl:foo} x')
  })

  it('takes a trailing brace marker off the last line', () => {
    const taken = takeCrossrefSuffix('a^2 + b^2 = c^2 {#eq:pythagoras}', 'eq')
    expect(taken.name).toBe('pythagoras')
    expect(taken.body).toBe('a^2 + b^2 = c^2')
  })

  it('keeps the number a name was given first, and counts each kind on its own', () => {
    const registry = emptyCrossrefRegistry()
    expect(registerCrossref(registry, 'tbl', 'x')?.number).toBe(1)
    expect(registerCrossref(registry, 'tbl', 'x')?.number).toBe(1)
    expect(registerCrossref(registry, 'eq', 'x')?.number).toBe(1)
    expect(registerCrossref(registry, 'tbl', 'y')?.number).toBe(2)
    expect(registerCrossref(registry, 'tbl', 'no spaces')?.number).toBeUndefined()
  })
})

describe('an equation with a name', () => {
  it('shows its number beside the maths and carries the anchor a reference jumps to', () => {
    const html = renderMarkdown(LABELLED_MATH).html
    expect(html).toContain('id="^eq-einstein"')
    expect(html).toContain('data-block-id="eq-einstein"')
    expect(html).toContain('class="math-equation-number"')
    expect(html).toContain('markdown.equation 1')
  })

  it('hands KaTeX a body the label was taken out of', () => {
    const html = renderMarkdown(LABELLED_MATH).html
    expect(html).not.toContain('\\label')
    const encoded = /data-math="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(atob(encoded.replace(/^b64\./, ''))).toContain('E = mc^2')
  })

  it('leaves an unnamed equation exactly the element it always was', () => {
    const html = renderMarkdown('$$x$$\n').html
    expect(html).not.toContain('math-equation')
    expect(html).toContain('<div class="math-block"')
  })

  it('takes a name written after either spelling of the closing fence', () => {
    const oneLine = renderMarkdown('$$ab$$ {#eq:inline}\n\n@eq:inline.\n').html
    expect(oneLine).toContain('id="^eq-inline"')
    expect(oneLine).toContain('>markdown.equation 1</a>')
    expect(oneLine).not.toContain('{#eq:inline}')
    const manyLines = renderMarkdown('$$\na+b\n$$ {#eq:tall}\n\n@eq:tall.\n').html
    expect(manyLines).toContain('id="^eq-tall"')
    expect(manyLines).toContain('>markdown.equation 1</a>')
    expect(manyLines).not.toContain('{#eq:tall}')
  })

  it('numbers two labelled equations in the order they were written', () => {
    const html = renderMarkdown('$$a \\label{eq:one}$$\n\n$$b \\label{eq:two}$$\n\n@eq:two then @eq:one.\n').html
    expect(html.indexOf('markdown.equation 1')).toBeLessThan(html.indexOf('markdown.equation 2'))
    expect(html).toContain('>markdown.equation 2</a>')
    expect(html).toContain('>markdown.equation 1</a>')
  })
})

describe('a table with a name', () => {
  it('is captioned with its number and loses the marker line', () => {
    const html = renderMarkdown(TABLE).html
    expect(html).toContain('id="^tbl-results"')
    expect(html).toContain('<caption class="markdown-table-caption">markdown.table 1</caption>')
    expect(html).not.toContain('{#tbl:results}')
  })

  it('resolves a reference written above the table', () => {
    const html = renderMarkdown('See @tbl:early.\n\n| a |\n| - |\n| 1 |\n\n{#tbl:early}\n').html
    expect(html).toContain('>markdown.table 1</a>')
    expect(html).toContain('href="#%5Etbl-early"')
  })

  it('gives the marker line to the table, so the live editor draws it inside the block', () => {
    const source = '| a |\n| - |\n| 1 |\n\n{#tbl:x}\n\nafter\n'
    const rendered = renderMarkdownBlocks(source)
    const table = rendered.blocks.find((block) => block.html.includes('markdown-table-caption'))
    expect(table).toBeDefined()
    expect(source.split('\n').slice(table!.startLine, table!.endLine).join('\n')).toContain('{#tbl:x}')
    expect(rendered.blocks.some((block) => block.html.includes('{#tbl:x}'))).toBe(false)
  })

  it('will not take a name that has words beside it on the marker line', () => {
    const html = renderMarkdown('| a |\n| - |\n| 1 |\n\n{#tbl:x} trailing words\n').html
    expect(html).not.toContain('markdown-table-caption')
    expect(html).toContain('{#tbl:x} trailing words')
  })

  it('leaves a marker that is not alone in its paragraph as the text it is', () => {
    const html = renderMarkdown('| a |\n| - |\n| 1 |\n\nNote {#tbl:x} here.\n').html
    expect(html).not.toContain('markdown-table-caption')
    expect(html).toContain('Note {#tbl:x} here.')
  })

  it('leaves an unnamed table without a caption or an anchor', () => {
    const html = renderMarkdown('| a |\n| - |\n| 1 |\n').html
    expect(html).not.toContain('markdown-table-caption')
    expect(html).toContain('<div class="table-wrap"')
  })
})

describe('references', () => {
  it('says the author’s own spelling when the name was never given', () => {
    expect(renderMarkdown('See @eq:missing.\n').html).toContain('@eq:missing')
    expect(renderMarkdown('See @eq:missing.\n').html).not.toContain('figure-reference')
  })

  it('keeps a name that a block id could not carry as plain text', () => {
    expect(renderMarkdown('mail me@eq:x please\n').html).not.toContain('figure-reference')
    expect(renderMarkdown('@fig:bad name\n').html).not.toContain('figure-reference')
  })

  it('still resolves the figure names the layout block gave its pictures', () => {
    const html = renderMarkdown('::: media\n![beach](attachments/beach.png "The picture {#fig:beach}")\n:::\n\nSee @fig:beach.\n').html
    expect(html).toContain('id="^fig-beach"')
    expect(html).toContain('>markdown.figure 1</a>')
  })

  it('keeps the first picture a name was written on, so a reference has one answer', () => {
    const html = renderMarkdown('::: media\n![one](a.png "One {#fig:same}") ![two](b.png "Two {#fig:same}")\n:::\n\nSee @fig:same.\n').html
    expect(html).toContain('>markdown.figure 1</a>')
    expect(html).toContain('data-media-figure="2"')
  })

  it('keeps an at-handle glued to a word plain, even when that name exists', () => {
    const html = renderMarkdown('$$x \\label{eq:mass}$$\n\nmail me@eq:mass please\n').html
    expect(html).not.toContain('figure-reference')
    expect(html).toContain('me@eq:mass')
  })

  it('numbers each kind apart, so a table cannot shift an equation', () => {
    const html = renderMarkdown(`${LABELLED_MATH}\n\n${TABLE}\n\n@eq:einstein in @tbl:results.\n`).html
    expect(html).toContain('>markdown.equation 1</a>')
    expect(html).toContain('>markdown.table 1</a>')
  })
})

describe('the token pass on its own', () => {
  it('does nothing to a stream with no names in it', () => {
    const before = renderMarkdown('| a |\n| - |\n| 1 |\n\n$$x$$\n').html
    expect(nameCrossrefBlocks([], emptyCrossrefRegistry())).toBeUndefined()
    expect(renderMarkdown('| a |\n| - |\n| 1 |\n\n$$x$$\n').html).toBe(before)
  })
})
