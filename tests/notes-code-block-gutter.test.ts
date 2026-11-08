import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/client/lib/markdown/renderer'

const prose = fs.readFileSync('src/client/styles/prose.css', 'utf8')

describe('code block gutter contract', () => {
  it('keeps the numbered line block-level with a reserved gutter column', () => {
    const rule = prose.slice(
      prose.indexOf('.ink-prose .code-block.has-line-numbers .line {'),
      prose.indexOf('.ink-prose .code-block.has-line-numbers .line::before'),
    )
    expect(rule).toContain('display: block')
    expect(rule).toContain('padding-left: var(--code-gutter')
  })

  it('places the number in the reserved column instead of inline content', () => {
    const rule = prose.slice(
      prose.indexOf('.ink-prose .code-block.has-line-numbers .line::before'),
      prose.indexOf("[data-code-wrap='true']"),
    )
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('left: 0')
    expect(rule).toContain("content: attr(data-line-number)")
  })

  it('still lets a fence ask for wrapped long lines', () => {
    expect(prose).toContain("[data-code-wrap='true'] pre")
    expect(prose).toContain('white-space: pre-wrap')
  })

  it('renders a numbered, wrapped fence with the attributes the layout reads', () => {
    const html = renderMarkdown('```ts title="demo.ts" line-numbers wrap\nconst a = 1\n```').html
    expect(html).toContain('has-line-numbers')
    expect(html).toContain('data-line-numbers="true"')
    expect(html).toContain('data-code-wrap="true"')
    expect(html).toContain('data-code-start="1"')
  })
})

describe('note typography tokens', () => {
  it('sets the hover card prose from its own step, not the reading column', () => {
    const rule = prose.slice(prose.indexOf('.wiki-hover-body .ink-prose {'), prose.indexOf('.wiki-hover-body .ink-prose h1'))
    expect(rule).toContain('font-size: var(--hover-card-size')
    expect(rule).toContain('line-height: var(--hover-card-line')
    expect(rule).not.toContain('font-size: var(--prose-size')
  })

  it('does not keep literal 11px sizes in prose.css', () => {
    expect(prose).not.toMatch(/font-size:\s*11px/)
  })
})
