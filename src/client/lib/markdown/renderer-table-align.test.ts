import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

const ALIGNED = '| left | mid | right | plain |\n| :- | :-: | -: | --- |\n| a | b | c | d |\n'

/** The opening tags of one cell type, with their attribute text. `<thead>` must not read as a `<th>`. */
function cells(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g'))].map((match) => match[1] ?? '')
}

describe('table cell alignment', () => {
  it('gives each aligned column a class on the header and on the body', () => {
    const { html } = renderMarkdown(ALIGNED, {})
    expect(cells(html, 'th').map((attrs) => /markdown-cell-\w+/.exec(attrs)?.[0] ?? 'none'))
      .toEqual(['markdown-cell-left', 'markdown-cell-center', 'markdown-cell-right', 'none'])
    expect(cells(html, 'td').map((attrs) => /markdown-cell-\w+/.exec(attrs)?.[0] ?? 'none'))
      .toEqual(['markdown-cell-left', 'markdown-cell-center', 'markdown-cell-right', 'none'])
  })

  it('leaves no inline style for the sanitizer to refuse', () => {
    const { html } = renderMarkdown(ALIGNED, {})
    expect(html).not.toContain('text-align')
    expect(cells(html, 'td').every((attrs) => !/\bstyle=/.test(attrs))).toBe(true)
  })

  it('keeps a column that asked for nothing unstyled', () => {
    const { html } = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n', {})
    expect(html).not.toContain('markdown-cell-')
  })

  it('still strips a style written straight into the note', () => {
    const { html } = renderMarkdown('<table><tr><td style="text-align:right;color:red">x</td></tr></table>\n', {})
    expect(html).not.toContain('style=')
    expect(html).not.toContain('color:red')
  })

  it('carries the alignment through the block renderer the editor uses', () => {
    const blocks = renderMarkdownBlocks(ALIGNED, {})
    const table = blocks.blocks.find((block) => block.html.includes('<table'))
    expect(table?.html).toContain('markdown-cell-center')
    expect(table?.html).not.toContain('text-align')
  })
})
