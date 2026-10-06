import { describe, expect, it } from 'vitest'
import { applyExampleSplits, configureCodeBlockCollapsing, decorateCodeBlock } from './enhance'

function tree(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function codeBlock(inner: string, attrs = 'class="code-block" data-line="4"'): string {
  return `<div ${attrs}><div class="code-block-head"><button data-copy>Copy</button></div>${inner}</div>`
}

const THREE_LINES = '<pre id="keep"><code>aaa\nbbb\nccc\n</code></pre>'
const MANY_LINES = `<pre><code>${Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')}\n</code></pre>`

function normalized(root: HTMLElement): string {
  return root.innerHTML.replace(/ink-code-\d+/g, 'ink-code-N')
}

const CASES: Array<[string, HTMLElement]> = [
  ['plain', codeBlock(THREE_LINES)],
  ['short under threshold', codeBlock(MANY_LINES)],
  ['pre after other children', codeBlock(`<span>meta</span>${THREE_LINES}`)],
  ['no pre at all', codeBlock('<code>aaa\nbbb</code>')],
  ['pre without code', codeBlock('<pre>aaa\nbbb</pre>')],
  ['two pre children', codeBlock(`<pre><code>x\ny\n</code></pre>${THREE_LINES}`)],
  ['pre holding a nested pre', codeBlock('<pre><code>outer\nlines</code></pre>')],
  ['example block excluded', codeBlock(MANY_LINES, 'class="code-block markdown-example-code" data-line="4"')],
  ['empty code', codeBlock('<pre><code></code></pre>')],
  ['starts expanded', codeBlock(MANY_LINES).replace('class="code-block"', 'class="code-block is-code-expanded"')],
].map(([name, html]) => [name, tree(html)] as [string, HTMLElement])

describe('code block decoration', () => {
  it('derives the same line count as the selector it replaces', () => {
    for (const [name, source] of CASES) {
      const root = tree(source.innerHTML)
      const blocks = [...root.querySelectorAll<HTMLElement>('.code-block')]
      for (const block of blocks)
        decorateCodeBlock(block)
      const expected = blocks.map((block) => block.querySelectorAll(':scope pre code > .line').length)
      configureCodeBlockCollapsing(root, 8)
      blocks.forEach((block, index) => {
        const excluded = block.classList.contains('markdown-example-code')
        const wasExpanded = name === 'starts expanded'
        const over = !excluded && expected[index]! > 8
        expect(block.classList.contains('is-code-collapsed'), `${name} #${index}`).toBe(over && !wasExpanded)
        expect(block.classList.contains('is-code-expanded'), `${name} #${index}`).toBe(over && wasExpanded)
        expect(block.dataset.codeLineCount, `${name} #${index}`).toBe(over ? String(expected[index]) : undefined)
        expect(block.dataset.codeCollapseLines, `${name} #${index}`).toBe(over ? '8' : undefined)
        expect(block.querySelector('button.code-collapse') !== null, `${name} #${index}`).toBe(over)
        if (excluded)
          expect(expected[index], name).toBeGreaterThan(8)
      })
    }
  })

  it('keeps the line-number and collapse outcome for a decorated long block', () => {
    const root = tree(codeBlock(MANY_LINES))
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 8)
    const block = root.querySelector<HTMLElement>('.code-block')!
    expect(block.classList.contains('is-code-collapsed')).toBe(true)
    expect(block.dataset.codeLineCount).toBe('12')
    expect(block.dataset.codeCollapseLines).toBe('8')
    expect(block.dataset.codeCollapseMaxHeight).toBe(`${8 * 1.56 + 1.5}em`)
    expect(block.querySelector('pre')!.getAttribute('style')).toContain('max-height')
    expect(block.querySelector('button.code-collapse')!.getAttribute('aria-expanded')).toBe('false')
    expect([...block.querySelectorAll<HTMLElement>('.line')].map((line) => line.dataset.lineNumber)).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 1)),
    )
  })

  it('leaves a short decorated block uncollapsed and reuses the pre id', () => {
    const root = tree(codeBlock(THREE_LINES))
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 8)
    const block = root.querySelector<HTMLElement>('.code-block')!
    expect(block.className).toBe('code-block')
    expect(block.dataset.codeCollapseLines).toBeUndefined()
    expect(block.dataset.codeLineCount).toBeUndefined()
    expect(block.querySelector('button.code-collapse')).toBeNull()
    expect(block.querySelector('pre')!.id).toBe('keep')
    expect(block.querySelector('pre')!.getAttribute('style') ?? '').not.toContain('max-height')
    expect([...block.querySelectorAll('.line')].length).toBe(3)
  })

  it('decorates an undecorated block through the selector path', () => {
    const root = tree(codeBlock(MANY_LINES))
    configureCodeBlockCollapsing(root, 8)
    const block = root.querySelector<HTMLElement>('.code-block')!
    expect(block.dataset.codeLineCount).toBeUndefined()
    expect(block.classList.contains('is-code-collapsed')).toBe(false)
    expect(block.querySelector('button.code-collapse')).toBeNull()
  })

  it('is idempotent across repeated passes', () => {
    const root = tree(codeBlock(MANY_LINES))
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 8)
    const once = normalized(root)
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 8)
    expect(normalized(root)).toBe(once)
  })

  it('stops re-querying the line elements it already counted', () => {
    const proto = Element.prototype as { querySelectorAll: typeof Element.prototype.querySelectorAll }
    const original = proto.querySelectorAll
    const run = (root: HTMLElement, decorate: boolean): string[] => {
      const seen: string[] = []
      if (decorate)
        for (const block of Array.from(root.querySelectorAll('.code-block'))) decorateCodeBlock(block as HTMLElement)
      proto.querySelectorAll = function (this: Element, selectors: string) {
        seen.push(selectors)
        return original.call(this, selectors)
      }
      try {
        configureCodeBlockCollapsing(root, 8)
      } finally {
        proto.querySelectorAll = original
      }
      return seen
    }
    const cached = run(tree(codeBlock(MANY_LINES)), true)
    expect(cached.some((s) => s.includes('.line')), cached.join(' | ')).toBe(false)
    expect(cached.filter((s) => s.includes('.code-block')).length).toBe(1)
    const fallback = run(tree(codeBlock(MANY_LINES)), false)
    expect(fallback.filter((s) => s.includes(':scope pre code > .line')).length).toBe(1)
  })

  it('binds the collapse to the first matching child, not a later one', () => {
    const root = tree(codeBlock(`${MANY_LINES}<pre><code>tail\n</code></pre>`))
    const block = root.querySelector<HTMLElement>('.code-block')!
    const pres = [...block.querySelectorAll(':scope > pre')]
    expect(pres.length).toBe(2)
    decorateCodeBlock(block)
    configureCodeBlockCollapsing(root, 8)
    expect(pres[0]!.hasAttribute('id')).toBe(true)
    expect(pres[0]!.getAttribute('style') ?? '').toContain('max-height')
    expect(pres[1]!.hasAttribute('id')).toBe(false)
    expect(pres[1]!.getAttribute('style') ?? '').not.toContain('max-height')
    expect(block.dataset.codeLineCount).toBe('12')
    expect(block.querySelector('button.code-collapse')).not.toBeNull()
  })

  it('honours the collapse threshold boundary', () => {
    for (const [lines, collapsed] of [[8, false], [9, true], [16, true]] as const) {
      const root = tree(codeBlock(`<pre><code>${Array.from({ length: lines }, (_, i) => `l${i}`).join('\n')}\n</code></pre>`))
      const block = root.querySelector<HTMLElement>('.code-block')!
      decorateCodeBlock(block)
      configureCodeBlockCollapsing(root, 8)
      expect(block.classList.contains('is-code-collapsed'), `${lines} lines`).toBe(collapsed)
      expect(block.dataset.codeLineCount, `${lines} lines`).toBe(collapsed ? String(lines) : undefined)
    }
  })

  it('drops a stale collapse button when the threshold is turned off', () => {
    const root = tree(codeBlock(MANY_LINES))
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 8)
    expect(root.querySelector('button.code-collapse')).not.toBeNull()
    configureCodeBlockCollapsing(root, 0)
    expect(root.querySelector('button.code-collapse')).toBeNull()
    expect(root.querySelector<HTMLElement>('.code-block')!.className).toBe('code-block')
    expect(root.querySelector('pre')!.getAttribute('style') ?? '').not.toContain('max-height')
  })

  it('lets the fence overrule the account setting, both ways', () => {
    const cases: Array<[string, boolean, string?]> = [
      ['', true, '8'],
      ['0', false],
      ['8', true, '8'],
      ['9', true, '9'],
      ['12', false],
      ['40', false],
      ['nonsense', true, '8'],
      [' 10 ', true, '10'],
      ['-1', true, '8'],
    ]
    for (const [written, collapsed, threshold] of cases) {
      const attribute = written === '' ? '' : ` data-code-collapse-at="${written}"`
      const root = tree(codeBlock(MANY_LINES, `class="code-block" data-line="4"${attribute}`))
      const block = root.querySelector<HTMLElement>('.code-block')!
      decorateCodeBlock(block)
      configureCodeBlockCollapsing(root, 8)
      expect(block.classList.contains('is-code-collapsed'), `collapse="${written}"`).toBe(collapsed)
      expect(block.dataset.codeCollapseLines, `collapse="${written}"`).toBe(threshold)
    }
  })

  it('keeps a per-block fold when the account setting is off entirely', () => {
    const root = tree(codeBlock(MANY_LINES, 'class="code-block" data-line="4" data-code-collapse-at="9"'))
    decorateCodeBlock(root.querySelector<HTMLElement>('.code-block')!)
    configureCodeBlockCollapsing(root, 0)
    const block = root.querySelector<HTMLElement>('.code-block')!
    expect(block.classList.contains('is-code-collapsed')).toBe(true)
    expect(block.dataset.codeCollapseLines).toBe('9')
  })
})

describe('example split tracks', () => {
  it('hands the ratio to CSS on the axis the layout uses, and only that one', () => {
    const root = tree([
      '<div class="markdown-example-grid" data-example-layout="lr" data-example-ratio="3:7"></div>',
      '<div class="markdown-example-grid" data-example-layout="bt" data-example-ratio="2:8"></div>',
      '<div class="markdown-example-grid" data-example-layout="tb" data-example-ratio="99:1"></div>',
      '<div class="markdown-example-grid" data-example-layout="lr" data-example-ratio="0:7"></div>',
      '<div class="markdown-example-grid" data-example-layout="lr" data-example-ratio="3-7"></div>',
      '<div class="markdown-example-grid" data-example-layout="lr"></div>',
    ].join(''))
    const grids = [...root.querySelectorAll<HTMLElement>('.markdown-example-grid')]
    applyExampleSplits(root)
    expect(grids[0]!.style.getPropertyValue('--ex-cols')).toBe('3fr 7fr')
    expect(grids[0]!.style.getPropertyValue('--ex-rows')).toBe('')
    expect(grids[1]!.style.getPropertyValue('--ex-rows')).toBe('2fr 8fr')
    expect(grids[1]!.style.getPropertyValue('--ex-cols')).toBe('')
    expect(grids[2]!.style.getPropertyValue('--ex-rows')).toBe('99fr 1fr')
    for (const grid of grids.slice(3))
      expect(grid.hasAttribute('style'), grid.outerHTML).toBe(false)
  })

  it('clears the stale axis when a block switches between a row and a column split', () => {
    const root = tree('<div class="markdown-example-grid" data-example-layout="lr" data-example-ratio="3:7"></div>')
    const grid = root.querySelector<HTMLElement>('.markdown-example-grid')!
    applyExampleSplits(root)
    grid.dataset.exampleLayout = 'tb'
    applyExampleSplits(root)
    expect(grid.style.getPropertyValue('--ex-cols')).toBe('')
    expect(grid.style.getPropertyValue('--ex-rows')).toBe('3fr 7fr')
  })
})
