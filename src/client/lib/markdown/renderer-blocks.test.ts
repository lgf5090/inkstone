import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownBlocks } from './renderer'

const CORPUS: Array<[string, string]> = [
  ['paragraphs', '# Title\n\nFirst paragraph with **bold** and *em*.\n\nSecond paragraph.\n'],
  ['tasks', '- [ ] open\n- [x] done\n\nText after.\n'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter table.\n'],
  ['code', '```js\nconst a = 1;\n```\n\nAfter code.\n'],
  ['list-nesting', '1. one\n   - inner\n2. two\n\n> quote\n\n- [ ] task in doc\n'],
  ['wiki-and-tags', 'Link [[Some Note]] and [[Other#Heading]] plus #tag inline.\n'],
  ['footnote', 'Statement[^1]\n\n[^1]: the note\n'],
  ['html-block', '<div class="x"><p>raw html</p></div>\n\nAfter raw.\n'],
  ['html-with-marker', '<div data-render-group="0">hostile</div>\n\n<p>kept</p>\n'],
  ['html-many-markers', '<section><div data-render-group="1">a</div><div data-render-group="99">b</div></section>\n\n<p>tail</p>\n'],
  ['stray-table-fragment', '<table><tbody><tr><td>cell</td></tr></tbody></table>\n\n<p>after</p>\n'],
  ['unbalanced', '<p>unclosed\n\n<p>next paragraph</p>\n'],
  ['math', 'Inline $x^2$ and block\n\n$$\ny = x\n$$\n\nAfter math.\n'],
  ['mermaid', '```mermaid\ngraph TD;\nA-->B;\n```\n\nAfter diagram.\n'],
  ['callout-tabs', ':::note\nCallout body\n:::\n\n===Tab A\n\ncontent a\n\n===Tab B\n\ncontent b\n'],
  ['comments', 'Visible\n\n%%\nhidden block\n%%\n\nMore visible\n'],
  ['frontmatter', '---\ntitle: Doc\ntags: [a, b]\n---\n\nBody paragraph\n'],
  ['entities', 'A & B < C > D "quoted" `code`\n\n<a href="http://e.com/?a=1&b=2">link</a>\n'],
  ['xss', '<img src=x onerror="alert(1)">\n\n<script>alert(2)<\/script>\n\n<style>p{color:red}</style>\n\n<iframe src="http://e"></iframe>\n\n<input name=pw>\n'],
  ['empty-blocks', '\n\n\n\nonly text\n\n\n'],
  ['single', 'One line only'],
  ['no-trailing-newline', '- [ ] a\n- [ ] b'],
  ['style-then-p', '<style>p{color:red}</style>\n\n<p>visible</p>\n'],
  ['two-task-lists', '- [ ] a\n\nText\n\n- [ ] b\n'],
  ['marker-lookalike', '<div data-render-group="abc:0">x</div>\n\n<p>y</p>\n'],
  ['html-block-open', '<div>\n<p>inside</p>\n<p>more</p>\n</div>\n\nafter\n'],
  ['deep-html', '<div><span><b>x</b></span></div>\n\n# H\n\n- li\n'],
  ['hr-and-html', '---\n\n<div>after rule</div>\n\n---\n\nend\n'],
  ['md-example', '~~~md-example title="D" layout=rl ratio="3:7"\n**b**\n~~~\n\nAfter example.\n'],
  ['js-example', '~~~~javascript-example title="R"\nconsole.log(1);\n~~~~\n\nAfter runnable.\n'],
  ['two-examples', '~~~md-example\na\n~~~\n\n~~~md-example\nb\n~~~\n\n~~~js-example\n1\n~~~\n'],
  ['nested-example', '~~~~~md-example\n~~~~md-example\nx\n~~~~\n~~~~~\n\nTail\n'],
  ['code-options', '```ts title="a.ts" line-numbers start=3 {2} wrap collapse=20 theme=dark\nx\ny\n```\n\nAfter options.\n'],
]

function signature(html: string): string {
  const frame = document.createElement('template')
  frame.innerHTML = html
  const parts: string[] = []
  const walk = (node: Element): void => {
    const attrs = [...node.attributes]
      .filter((a) => a.name === 'data-line' || a.name === 'data-task-line' || a.name === 'data-lang' || a.name === 'href' || a.name === 'class' || a.name === 'data-math' || a.name === 'data-mermaid' || a.name === 'data-example-family' || a.name === 'data-example-layout' || a.name === 'data-example-ratio' || a.name === 'data-code-title' || a.name === 'data-code-wrap' || a.name === 'data-code-collapse-at' || a.name === 'data-code-theme' || a.name === 'data-js-example-output' || a.name === 'data-code-start')
      .map((a) => `${a.name}=${a.value.replace(/\s+/g, ' ').replace(/ink-[0-9a-f-]{8,}/g, 'ink-N').trim()}`)
      .sort()
      .join(',')
    parts.push(`<${node.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ''}>`)
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) parts.push(`#${text}`)
        continue
      }
      if (child.nodeType === 1) walk(child as Element)
    }
    parts.push(`</${node.tagName.toLowerCase()}>`)
  }
  for (const child of Array.from(frame.content.childNodes)) {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) parts.push(`#${text}`)
      continue
    }
    if (child.nodeType === 1) walk(child as Element)
  }
  return parts.join('|')
}

describe('renderMarkdownBlocks matches the whole-document preview', () => {
  for (const [name, source] of CORPUS) {
    it(`keeps identical rendered DOM for ${name}`, () => {
      const blocks = renderMarkdownBlocks(source).blocks
      const joined = blocks.map((block) => block.html).join('\n')
      expect(signature(joined)).toBe(signature(renderMarkdown(source).html))
    })
  }

  it('renders the footnote tail that the token stream synthesises without a map', () => {
    const source = 'Statement[^1]\n\n[^1]: the note\n'
    const blocks = renderMarkdownBlocks(source).blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.html).toContain('footnote-ref')
    expect(blocks[0]!.html).toContain('footnotes-list')
    expect(blocks[0]!.html).toContain('the note')
    expect(blocks[0]!.html).toContain('footnote-backref')
  })

  it('appends the synthesised tail to the last block rather than inventing a line range', () => {
    const blocks = renderMarkdownBlocks('One\n\nTwo[^a]\n\n[^a]: tail\n').blocks
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([[0, 1], [2, 3]])
    expect(blocks[1]!.html).toContain('tail')
    expect(blocks[0]!.html).not.toContain('footnotes-list')
  })

  it('never leaks the internal group wrapper into a block', () => {
    for (const [name, source] of CORPUS) {
      for (const block of renderMarkdownBlocks(source).blocks) {
        expect(block.html, name).not.toMatch(/data-render-group="[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+"/)
      }
    }
    const lookalike = renderMarkdownBlocks('<div data-render-group="abc:0">x</div>\n\n<p>y</p>\n').blocks
    expect(lookalike.map((b) => b.html.trim())).toEqual(['<div data-render-group="abc:0">x</div>', '<p>y</p>'])
    const hostile = renderMarkdownBlocks('<div data-render-group="0">hostile</div>\n\n<p>kept</p>\n').blocks
    expect(hostile.map((b) => b.html.trim())).toEqual(['<div data-render-group="0">hostile</div>', '<p>kept</p>'])
  })

  it('reports one block per top-level token with source line bounds', () => {
    const result = renderMarkdownBlocks('# T\n\npara one\n\npara two\n')
    expect(result.blocks.map((b) => [b.startLine, b.endLine])).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(result.blocks.map((b) => b.html.trim())).toEqual([
      '<h1 id="t" tabindex="-1" data-line="0"><a class="heading-anchor" href="#t" aria-hidden="true"></a> T</h1>',
      '<p data-line="2">para one</p>',
      '<p data-line="4">para two</p>',
    ])
  })

  it('drops whitespace-only and empty blocks without dropping neighbours', () => {
    const withStyle = renderMarkdownBlocks('<style>p{color:red}</style>\n\n<p>visible</p>\n')
    expect(withStyle.blocks.some((b) => b.html.includes('color:red'))).toBe(false)
    expect(withStyle.blocks.map((b) => b.html.trim())).toEqual(['<p>visible</p>'])
    expect(renderMarkdownBlocks('').blocks).toEqual([])
    expect(renderMarkdownBlocks('   \n\n\t\n').blocks).toEqual([])
  })

  it('keeps task checkboxes bound to their source line across blocks', () => {
    const blocks = renderMarkdownBlocks('- [x] first\n- [ ] second\n\n- [ ] third\n').blocks
    expect(blocks).toHaveLength(1)
    const lines = [...blocks[0]!.html.matchAll(/data-task-line="(\d+)"/g)].map((m) => m[1])
    expect(new Set(lines)).toEqual(new Set(['0', '1', '3']))
    expect(blocks[0]!.html).toContain('checked')
    const separated = renderMarkdownBlocks('- [ ] a\n\nText\n\n- [ ] b\n').blocks
    expect(separated.map((b) => [...b.html.matchAll(/data-task-line="(\d+)"/g)].map((m) => m[1]))).toEqual([['0', '0'], [], ['4', '4']])
  })

  it('keeps hostile markup removed for every corpus document', () => {
    for (const [name, source] of CORPUS) {
      const html = renderMarkdownBlocks(source).blocks.map((b) => b.html).join('\n')
      expect(html, name).not.toMatch(/<script|onerror=|onload=|<iframe|<style|srcdoc=/)
      expect(html, name).not.toMatch(/<input(?![^>]*task-list-item-checkbox)/)
    }
  })
})
