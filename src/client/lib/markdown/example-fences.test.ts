import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderer'

function first(html: string, selector: string): Element | null {
  const frame = document.createElement('template')
  frame.innerHTML = renderMarkdown(html).html
  return frame.content.querySelector(selector)
}

function tree(html: string): DocumentFragment {
  const frame = document.createElement('template')
  frame.innerHTML = renderMarkdown(html).html
  return frame.content
}

describe('md-example fence', () => {
  it('carries the family and the split the note asked for', () => {
    const plain = first('~~~md-example\n**bold**\n~~~', '.markdown-example')!
    expect(plain.getAttribute('data-example-family')).toBe('md')
    expect(plain.getAttribute('data-line')).toBe('0')
    const grid = plain.querySelector('.markdown-example-grid')!
    expect(grid.getAttribute('data-example-layout')).toBe('lr')
    expect(grid.getAttribute('data-example-ratio')).toBe('45:55')
  })

  it('keeps an explicit layout and ratio through sanitization', () => {
    const grid = first('~~~md-example title="D" layout=rl ratio="3:7"\nx\n~~~', '.markdown-example-grid')!
    expect(grid.getAttribute('data-example-layout')).toBe('rl')
    expect(grid.getAttribute('data-example-ratio')).toBe('3:7')
  })

  it('numbers nested examples apart so two blocks cannot share one body', () => {
    const root = tree('~~~~~md-example\n~~~~md-example\na\n~~~~\n~~~~~\n\n~~~~~md-example\nb\n~~~~~')
    const ids = [...root.querySelectorAll('[data-markdown-example-id]')].map((node) => node.getAttribute('data-markdown-example-id'))
    expect(ids).toEqual(['1', '2', '3'])
    const titles = [...root.querySelectorAll('[id*="markdown-example-"]')].map((node) => node.id)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('javascript-example fence', () => {
  const SOURCE = '~~~~javascript-example title="Sum"\nconsole.log(1 + 1);\n~~~~'

  it('renders the two panels with the runnable family mark', () => {
    const block = first(SOURCE, '.js-example-block')!
    expect(block.getAttribute('data-example-family')).toBe('js')
    expect(block.getAttribute('data-line')).toBe('0')
    expect(block.querySelector('.js-example-badge')?.textContent).toBe('JS')
    expect(block.querySelector('.markdown-example-title')?.textContent).toContain('Sum')
    const grid = block.querySelector('.markdown-example-grid')!
    expect(grid.getAttribute('data-example-layout')).toBe('tb')
  })

  it('ships no run button and no output, so a share page cannot execute the author\'s code', () => {
    const block = first(SOURCE, '.js-example-block')!
    expect(block.querySelector('[data-js-run]')).toBeNull()
    expect(block.querySelector('[data-js-switch]')).toBeNull()
    expect(block.querySelector('.js-example-controls')).toBeNull()
    const output = block.querySelector('[data-js-example-output]')!
    expect(output.childElementCount).toBe(0)
  })

  it('numbers the source gutter and keeps the code escaped', () => {
    const block = first('~~~js-example\nconst a = "<img src=x onerror=alert(1)>";\n~~~', '.js-example-block')!
    const code = block.querySelector('.code-block')!
    expect(code.getAttribute('data-line-numbers')).toBe('true')
    expect(code.getAttribute('data-lang')).toBe('javascript')
    expect(code.querySelector('img')).toBeNull()
    expect(code.querySelector('code')!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('accepts the shorter alias and the four-tilde fence alike', () => {
    expect(first('~~~js-example\nx\n~~~', '.js-example-block')).not.toBeNull()
    expect(first('~~~~javascript-example\nx\n~~~~', '.js-example-block')).not.toBeNull()
  })

  it('loses its line anchor inside an example preview, so it gets no controls there', () => {
    const root = tree('~~~~~md-example\n~~~~javascript-example\nx\n~~~~\n~~~~~')
    const inner = root.querySelector('.markdown-example-preview .js-example-block')!
    expect(inner.hasAttribute('data-line')).toBe(false)
    expect(inner.querySelector('[data-js-example-output]')).not.toBeNull()
  })
})

describe('standard code fence options', () => {
  it('carries the title, wrap, fold and palette the info string states', () => {
    const block = first('```ts title="utils.ts" wrap collapse=20 theme=dark\nx\n```', '.code-block')!
    expect(block.getAttribute('data-code-title')).toBe('utils.ts')
    expect(block.getAttribute('data-code-wrap')).toBe('true')
    expect(block.getAttribute('data-code-collapse-at')).toBe('20')
    expect(block.getAttribute('data-code-theme')).toBe('dark')
  })

  it('omits an attribute for every default, so a plain block stays plain', () => {
    const block = first('```ts\nx\n```', '.code-block')!
    for (const attribute of ['data-code-title', 'data-code-wrap', 'data-code-collapse-at', 'data-code-theme', 'data-line-numbers', 'data-highlight-lines'])
      expect(block.hasAttribute(attribute), attribute).toBe(false)
    expect(block.getAttribute('data-code-start')).toBe('1')
  })

  it('writes zero as a fold value rather than dropping it', () => {
    expect(first('```ts collapse=0\nx\n```', '.code-block')!.getAttribute('data-code-collapse-at')).toBe('0')
  })

  it('adds the gutter class only when the fence asks for numbers', () => {
    expect(first('```ts line-numbers\nx\n```', '.code-block')!.classList.contains('has-line-numbers')).toBe(true)
    expect(first('```ts\nx\n```', '.code-block')!.classList.contains('has-line-numbers')).toBe(false)
  })

  it('escapes a title so it cannot open a tag', () => {
    const block = first('```ts title="><img src=x onerror=alert(1)>"\nx\n```', '.code-block')!
    expect(block.querySelector('img')).toBeNull()
    expect(block.querySelector('.code-title')!.getAttribute('onerror')).toBeNull()
    expect(block.querySelector('.code-title')!.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
