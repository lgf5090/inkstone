import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../i18n'
import { renderMarkdown } from './renderer'

beforeAll(async () => {
  await initI18n()
})

function html(source: string): string {
  return renderMarkdown(source).html
}

function root(source: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html(source)
  return template.content
}

function first<T extends HTMLElement>(source: string, selector: string): T | null {
  return root(source).querySelector<T>(selector)
}

/** Column text with the markup's whitespace folded away, so a merged column reads as one string. */
function columns(source: string): string[] {
  const grid = first<HTMLElement>(source, '.markdown-cols')
  return [...(grid?.querySelectorAll<HTMLElement>(':scope > .markdown-col') ?? [])]
    .map((col) => (col.textContent ?? '').replace(/\s+/g, ''))
}

function columnCount(source: string): string | undefined {
  return first<HTMLElement>(source, '.markdown-cols')?.dataset.cols
}

function tabTitles(source: string): string[] {
  const fragment = root(source)
  return [...fragment.querySelectorAll<HTMLElement>('.markdown-tabs > .tab-list [data-tab-button]')].map((button) => button.textContent ?? '')
}

function panelTexts(source: string): string[] {
  const fragment = root(source)
  return [...fragment.querySelectorAll<HTMLElement>('.markdown-tabs > [data-tab-panel]')].map((panel) => panel.textContent?.trim() ?? '')
}

describe('::: alignment blocks', () => {
  it('draws each alignment the vocabulary knows', () => {
    for (const align of ['left', 'center', 'right', 'justify'] as const) {
      const block = first<HTMLElement>(`::: ${align}\nbody\n:::`, '.markdown-align')
      expect(block?.dataset.align).toBe(align)
      expect(block?.querySelector('p')?.textContent).toBe('body')
    }
  })

  it('reads the single-letter spellings', () => {
    expect(first<HTMLElement>('::: c\nbody\n:::', '.markdown-align')?.dataset.align).toBe('center')
    expect(first<HTMLElement>(':::j\nbody\n:::', '.markdown-align')?.dataset.align).toBe('justify')
  })

  it('leaves a word it does not claim as the plain text it was', () => {
    expect(html('::: centre\nbody\n:::')).not.toContain('markdown-align')
  })

  it('carries the source line so a toolbar can rewrite the header', () => {
    expect(first<HTMLElement>('text\n\n::: center\nbody\n:::', '.markdown-align')?.dataset.line).toBe('2')
  })
})

describe('::: column blocks', () => {
  it('infers the count from the separators and keeps the separators out of the content', () => {
    expect(columnCount('::: cols\none\n::\ntwo\n::\nthree\n:::')).toBe('3')
    expect(columns('::: cols\none\n::\ntwo\n::\nthree\n:::')).toEqual(['one', 'two', 'three'])
  })

  it('folds an overflow to the stated count without leaking separators into the last column', () => {
    const source = '::: cols 2\none\n::\ntwo\n::\nthree\n::\nfour\n:::'
    expect(columnCount(source)).toBe('2')
    expect(columns(source)).toEqual(['one', 'twothreefour'])
    expect(html(source)).not.toContain('::')
  })

  it('pads to a stated count above the body’s own', () => {
    expect(columnCount('::: 3cols\none\n::\ntwo\n:::')).toBe('3')
    expect(columns('::: 3cols\none\n::\ntwo\n:::')).toEqual(['one', 'two', ''])
  })

  it('reads a count, gap, divider and content alignment off the header', () => {
    const block = first<HTMLElement>('::: cols 2 gap=wide divider center\none\n::\ntwo\n:::', '.markdown-cols')
    expect(block?.dataset.cols).toBe('2')
    expect(block?.dataset.colsGap).toBe('wide')
    expect(block?.dataset.colsDivider).toBe('true')
    expect(block?.dataset.colsAlign).toBe('center')
  })

  it('omits the attributes a default would draw anyway', () => {
    const block = first<HTMLElement>('::: cols\none\n::\ntwo\n:::', '.markdown-cols')
    expect(block?.hasAttribute('data-cols-gap')).toBe(false)
    expect(block?.hasAttribute('data-cols-align')).toBe(false)
    expect(block?.hasAttribute('data-cols-tracks')).toBe(false)
  })

  it('carries track sizes only when there is one per column', () => {
    expect(first<HTMLElement>('::: cols 1fr 2fr\none\n::\ntwo\n:::', '.markdown-cols')?.dataset.colsTracks).toBe('1fr 2fr')
    expect(first<HTMLElement>('::: cols 1fr 2fr\none\n::\ntwo\n::\nthree\n:::', '.markdown-cols')?.hasAttribute('data-cols-tracks')).toBe(false)
    expect(first<HTMLElement>('::: cols 1fr\none\n::\ntwo\n:::', '.markdown-cols')?.hasAttribute('data-cols-tracks')).toBe(false)
  })

  it('keeps an empty column standing once a width list is on the header', () => {
    // The toolbar writes `4 2fr 1fr 1fr 1fr` for a block whose fourth column the reader has not filled
    // yet. Without the count the body reads back three columns and the widths no longer fit, so the
    // column the reader just opened disappears the moment they set its width.
    const source = '::: cols 4 2fr 1fr 1fr 1fr\none\n::\ntwo\n::\nthree\n::\n\n:::'
    const block = first<HTMLElement>(source, '.markdown-cols')
    expect(block?.dataset.cols).toBe('4')
    expect(block?.dataset.colsTracks).toBe('2fr 1fr 1fr 1fr')
    expect(columns(source)).toEqual(['one', 'two', 'three', ''])
  })

  it('escapes a header value that tries to leave its attribute', () => {
    expect(html('::: cols center" onload="alert(1)\none\n:::')).not.toContain('onload="alert')
  })

  it('treats a separator inside a code fence as text', () => {
    const source = '::: cols\nfirst\n::\n```\na :: b\n::: not a close\n```\n:::'
    expect(columnCount(source)).toBe('2')
    expect(columns(source)[1]).toContain('a::b')
  })

  it('leaves separators inside a nested container to that container', () => {
    const source = '::: cols\nouter\n::\n::: cols\ninner one\n::\ninner two\n:::\n:::'
    expect(columnCount(source)).toBe('2')
    expect(columns(source)).toEqual(['outer', 'inneroneinnertwo'])
  })

  it('holds any block content in a column', () => {
    const fragment = root('::: cols\n| a |\n|---|\n| 1 |\n::\n> quoted\n:::')
    expect(fragment.querySelector('.markdown-col table')).not.toBeNull()
    expect(fragment.querySelector('.markdown-col:nth-child(2) blockquote')).not.toBeNull()
  })

  it('accepts a nested container whose header omits the space', () => {
    const source = '::: cols\nouter\n::\n:::cols\ninner one\n::\ninner two\n:::\n:::'
    expect(columnCount(source)).toBe('2')
    expect(columns(source)).toEqual(['outer', 'inneroneinnertwo'])
    expect(html(source)).not.toContain(':::cols')
  })

  it('keeps a column count inside the range the stylesheet draws', () => {
    const body = Array.from({ length: 9 }, (_unused, index) => `c${index}`).join('\n::\n')
    expect(Number(columnCount(`::: cols 9\n${body}\n:::`))).toBeLessThanOrEqual(6)
  })
})

describe('::: tab blocks', () => {
  it('reads the :: spelling of a panel', () => {
    const source = ':::: tabs\n:: First\none\n:: Second\ntwo\n::::'
    expect(tabTitles(source)).toEqual(['First', 'Second'])
    const fragment = root(source)
    expect(fragment.querySelector('[data-tab-panel="1"]')?.textContent?.trim()).toBe('two')
  })

  it('names a bare separator with the fallback title', () => {
    expect(tabTitles(':::: tabs\n:: One\na\n::\nb\n::::')).toEqual(['One', 'Tabs'])
  })

  it('keeps the text above the first separator as the first panel', () => {
    // A `::` divides, so unlike `@tab` it does not introduce: nothing the author wrote may fall off
    // the front of the block.
    const source = ':::: tabs\nlead\n::\ntail\n::::'
    expect(tabTitles(source)).toEqual(['Tabs', 'Tabs'])
    expect(panelTexts(source)).toEqual(['lead', 'tail'])
  })

  it('honours the active marker on an @tab line', () => {
    const source = ':::: tabs\n@tab One\none\n@tab:active Two\ntwo\n::::'
    const fragment = root(source)
    expect(fragment.querySelector('[data-tab-button="1"]')?.getAttribute('aria-selected')).toBe('true')
    expect(fragment.querySelector('[data-tab-button="0"]')?.getAttribute('aria-selected')).toBe('false')
    expect(html(source)).not.toContain('@tab:active')
  })

  it('carries the layout options as attributes and wraps the block for container queries', () => {
    const fragment = root(':::: tabs vertical pills align=center sync=lang\n@tab One\none\n::::')
    const tabs = fragment.querySelector<HTMLElement>('.markdown-tabs')
    expect(tabs?.parentElement?.className).toBe('markdown-tabs-outer')
    expect(tabs?.dataset.tabsStyle).toBe('vertical')
    expect(tabs?.dataset.tabsVariant).toBe('pills')
    expect(tabs?.dataset.tabsAlign).toBe('center')
    expect(tabs?.dataset.tabsSync).toBe('lang')
  })

  it('drops an out-of-vocabulary option rather than passing it through', () => {
    const fragment = root(':::: tabs variant=nope sync="a b"\n@tab One\none\n::::')
    const tabs = fragment.querySelector<HTMLElement>('.markdown-tabs')
    expect(tabs?.hasAttribute('data-tabs-variant')).toBe(false)
    expect(tabs?.hasAttribute('data-tabs-sync')).toBe(false)
  })

  it('keeps an unclosed layout container claiming the rest of its context', () => {
    expect(html('::: cols\na\n::\nb')).toContain('markdown-cols')
    expect(html('::: center\na')).toContain('markdown-align')
  })
})

describe('a note that uses all three blocks together', () => {
  // The shapes come from the fixture note the feature was asked for: a justify block, a three-column
  // block whose alignment is stated on the same header line, a footnote referenced from inside a
  // column's blockquote, and a tab set written with the `::` spelling.
  const note = [
    '---',
    'title: "align + columns + tabs"',
    'tags: [demo]',
    '---',
    '',
    '::: justify',
    'Justified text lines up at both edges, with the space added between the words.',
    ':::',
    '',
    '**three columns, centered**',
    '',
    '::: cols center',
    '**First poem**',
    'Ten years of parting, a ghostly dream.',
    '> 1075[^author-age] in spring, mourning Wang Fu.',
    '',
    '::',
    '**Second poem**',
    'I dress in plain silk and lead a thousand riders.',
    '',
    '::',
    '**Third poem**',
    'When did the bright moon first appear?',
    '',
    ':::',
    '',
    '[^author-age]: Su Shi, born 1037, died 1101.',
    '',
    ':::: tabs pills',
    ':: spring',
    'A decade of parting.',
    ':: autumn',
    'When did the bright moon first appear?',
    '::::',
  ].join('\n')

  it('lays the note out as its header lines say', () => {
    const fragment = root(note)
    expect(fragment.querySelector<HTMLElement>('.markdown-align')?.dataset.align).toBe('justify')
    const grid = fragment.querySelector<HTMLElement>('.markdown-cols')
    expect(grid?.dataset.cols).toBe('3')
    expect(grid?.dataset.colsAlign).toBe('center')
    expect(grid?.querySelectorAll('.markdown-col')).toHaveLength(3)
    expect(tabTitles(note)).toEqual(['spring', 'autumn'])
    expect(fragment.querySelector<HTMLElement>('.markdown-tabs')?.dataset.tabsVariant).toBe('pills')
  })

  it('keeps the footnote reachable from inside a column', () => {
    expect(html(note)).toContain('footnotes')
  })

  it('leaves no container marker in the rendered text', () => {
    expect(html(note)).not.toContain(':::')
    expect(html(note)).not.toMatch(/>\s*::\s*</)
  })
})
