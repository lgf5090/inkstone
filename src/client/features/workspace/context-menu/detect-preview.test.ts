import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../../lib/markdown/renderer'
import { registerFenceBodies } from '../../../lib/markdown/fence-bodies'
import { detectPreviewContext } from './detect-preview'

/** The rendered document, with the fence bodies registered the way the preview host does it. */
function host(source: string): HTMLElement {
  const { html, fences } = renderMarkdown(source)
  const root = document.createElement('div')
  root.innerHTML = html
  registerFenceBodies(root, fences)
  document.body.append(root)
  return root
}

function at(root: HTMLElement, selector: string, text?: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => (text ? el.textContent?.includes(text) : true))
  if (found.length !== 1) throw new Error(`expected one ${selector}${text ? ` holding ${text}` : ''}, saw ${found.length}`)
  return found[0]!
}

function clear(): void {
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
}

describe('detectPreviewContext blocks', () => {
  it('reads a table cell as its row and column, with the header as row -1', () => {
    const root = host('| a | b |\n|---|---|\n| 1 | 2 |\n')
    const body = detectPreviewContext(at(root, 'td', '2'))
    expect(body.kind).toBe('table')
    expect(body.table).toEqual({ rowIndex: 1, colIndex: 1 })
    expect(body.line).toBe(0)
    expect(detectPreviewContext(at(root, 'th', 'a')).table?.rowIndex).toBe(-1)
    clear()
  })

  it('reads a heading with its level and the line it came from', () => {
    const root = host('intro\n\n## Second\n')
    expect(detectPreviewContext(at(root, 'h2'))).toMatchObject({ kind: 'heading', line: 2, heading: { level: 2, text: 'Second' } })
    clear()
  })

  it('reads a mermaid block back as its own family, body included', () => {
    const root = host('```mermaid\ngraph TD;A-->B;\n```\n')
    const context = detectPreviewContext(at(root, '[data-mermaid]'))
    expect(context.kind).toBe('mermaid')
    expect(context.fence).toMatchObject({ language: 'mermaid', body: 'graph TD;A-->B;\n' })
    expect(context.line).toBe(0)
    clear()
  })

  it('reads a chart block, keeping the pipes of a chart table out of the attribute', () => {
    const root = host('```chart style=table\nkind|value\nbar|3\nline|5\n```\n')
    const context = detectPreviewContext(at(root, '[data-chart]'))
    expect(context.kind).toBe('chart')
    expect(context.fence?.body).toContain('bar|3')
    clear()
  })

  it('reads a kanban body from the fence set rather than from the markup', () => {
    const root = host('```kanban\n- [ ] one card\n```\n')
    const context = detectPreviewContext(at(root, '[data-kanban]'))
    expect(context.kind).toBe('kanban')
    expect(context.fence?.body).toContain('one card')
    clear()
  })

  it('reads a mind map body the same way', () => {
    const root = host('```mindmap\n# Root\n## Branch\n```\n')
    const context = detectPreviewContext(at(root, '[data-mindmap]'))
    expect(context.kind).toBe('mindmap')
    expect(context.fence?.body).toContain('Branch')
    clear()
  })

  it('answers the example block, not the code pane drawn inside it', () => {
    const root = host('~~~md-example title="D"\n**b**\n~~~\n')
    const context = detectPreviewContext(at(root, 'pre'))
    expect(context.kind).toBe('example')
    expect(context.fence?.body).toContain('**b**')
    clear()
  })

  it('reads a plain code block with its language', () => {
    const root = host('```python\nx = 1\n```\n')
    const context = detectPreviewContext(at(root, '.code-block'))
    expect(context.kind).toBe('codeblock')
    expect(context.fence).toMatchObject({ language: 'python' })
    clear()
  })

  it('reads inline and block math with their formulas decoded', () => {
    const root = host('Inline $x^2$ here\n\n$$\ny = x\n$$\n')
    const inline = detectPreviewContext(at(root, '.math-inline'))
    expect(inline.math).toEqual({ formula: 'x^2', block: false })
    const block = detectPreviewContext(at(root, '.math-block'))
    expect(block.math).toMatchObject({ formula: 'y = x', block: true })
    clear()
  })

  it('answers from an SVG shape inside a diagram, which is not an HTMLElement', () => {
    const root = host('```mermaid\ngraph TD;A-->B;\n```\n')
    const block = at(root, '[data-mermaid]')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    svg.append(shape)
    block.append(svg)
    expect(detectPreviewContext(shape).kind).toBe('mermaid')
    expect(detectPreviewContext(svg).kind).toBe('mermaid')
    clear()
  })
})

describe('detectPreviewContext inline', () => {
  it('reads a wiki link target and alias', () => {
    const root = host('[[Note|shown]]\n')
    expect(detectPreviewContext(at(root, '[data-wikilink]')).wikiLink).toEqual({ target: 'Note', alias: 'shown' })
    clear()
  })

  it('reads a tag name', () => {
    const root = host('text #topic more\n')
    expect(detectPreviewContext(at(root, '[data-tag]')).tag).toEqual({ name: 'topic' })
    clear()
  })

  it('reads an external link but leaves a page anchor alone', () => {
    const root = host('[out](https://example.test/x) and [up](#top)\n')
    expect(detectPreviewContext(at(root, 'a[href^="https"]')).link?.url).toBe('https://example.test/x')
    expect(detectPreviewContext(at(root, 'a[href="#top"]')).kind).not.toBe('link')
    clear()
  })

  it('reads a task item with its source line, which is not the block line', () => {
    const root = host('lead\n\n- [x] done\n')
    const context = detectPreviewContext(at(root, 'li'))
    expect(context.kind).toBe('task')
    expect(context.task?.checked).toBe(true)
    expect(context.line).toBe(2)
    clear()
  })

  it('reads the properties panel as front matter on line zero', () => {
    const root = host('---\ntitle: Doc\n---\n\nBody\n')
    expect(detectPreviewContext(at(root, '.frontmatter-properties dt')).kind).toBe('frontmatter')
    clear()
  })
})

describe('detectPreviewContext containers', () => {
  it('names a tab set and a column set', () => {
    const root = host(':::: tabs\n@tab One\none\n@tab Two\ntwo\n::::\n')
    expect(detectPreviewContext(at(root, '[data-tabs]')).container?.directive).toBe('tabs')
    const cols = host('::: cols\na :: b\n:::\n')
    expect(detectPreviewContext(at(cols, '.markdown-cols')).container?.directive).toBe('cols')
    clear()
  })

  it('names an alignment container with the alignment it carries', () => {
    const root = host('::: center\nword\n:::\n')
    expect(detectPreviewContext(at(root, '[data-align]')).container?.directive).toBe('align center')
    clear()
  })
})

describe('detectPreviewContext fallbacks', () => {
  it('reports a paragraph as empty, with the block line for the canvas menu', () => {
    const root = host('lead\n\na paragraph\n')
    expect(detectPreviewContext(at(root, 'p', 'a paragraph'))).toMatchObject({ kind: 'empty', line: 2 })
    clear()
  })

  it('reports a live selection over anything it covers', () => {
    const root = host('# Title\n\nbody text\n')
    const heading = at(root, 'h1').lastChild!
    const range = document.createRange()
    range.setStart(heading, 1)
    range.setEnd(heading, 6)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(detectPreviewContext(at(root, 'h1'))).toMatchObject({ kind: 'selection', selectedText: 'Title' })
    clear()
  })

  it('steps aside for a selection that does not cover the pointer', () => {
    const root = host('# Title\n\nbody text\n')
    const range = document.createRange()
    range.selectNodeContents(at(root, 'p'))
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(detectPreviewContext(at(root, 'h1')).kind).toBe('heading')
    clear()
  })
})
