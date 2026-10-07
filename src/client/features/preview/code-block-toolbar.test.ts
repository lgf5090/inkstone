import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { readCodeOptions } from '../../lib/markdown/code-options'
import { codeBlockToolbar, enhanceCodeBlockToolbarsInRoot, executeCodeBlockAction } from './code-block-toolbar'
import type { BlockToast } from './block-overlay'

function codeRoot(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  return root
}

function node(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no node for ${selector}`)
  return found
}

function run(root: HTMLElement, selector: string, source: string): string | null {
  const target = node(root, selector)
  const edits: string[] = []
  const handled = executeCodeBlockAction(target.dataset.codeAction!, target, source, (next) => edits.push(next), vi.fn())
  expect(handled, selector).toBe(true)
  return edits[0] ?? null
}

function openPanel(root: HTMLElement): void {
  const trigger = node(root, '[data-code-action="toggle-settings"]')
  if (trigger.getAttribute('aria-expanded') !== 'true') executeCodeBlockAction('toggle-settings', trigger, '', vi.fn(), vi.fn())
}

const BASE = '```ts\nconst a = 1;\n```'

describe('code block settings toolbar', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = codeRoot(BASE)
    enhanceCodeBlockToolbarsInRoot(root)
  })

  it('injects the trigger and defers the panel until it is opened', () => {
    expect(root.querySelectorAll('.block-tools').length).toBe(1)
    expect(root.querySelectorAll('.block-settings').length).toBe(0)
    const head = node(root, '.code-block-head')
    expect([...head.children].map((child) => child.className)).toEqual(['code-title', 'block-tools', 'code-copy'])
    openPanel(root)
    expect(root.querySelectorAll('.block-settings').length).toBe(1)
    openPanel(root)
    expect(root.querySelectorAll('.block-settings').length).toBe(1)
    enhanceCodeBlockToolbarsInRoot(root)
    expect(root.querySelectorAll('.block-tools').length).toBe(1)
  })

  it('stays out of an example source and out of a note embed', () => {
    const example = codeRoot('~~~md-example\n```ts\nx\n```\n~~~')
    enhanceCodeBlockToolbarsInRoot(example)
    expect(example.querySelectorAll('.block-settings').length).toBe(0)
    const wrap = document.createElement('div')
    wrap.className = 'note-embed-body'
    wrap.innerHTML = renderMarkdown(BASE).html
    enhanceCodeBlockToolbarsInRoot(wrap)
    expect(wrap.querySelectorAll('.block-settings').length).toBe(0)
    expect(wrap.querySelector('.code-block-head .block-tools')).toBeNull()
  })

  it('prefills every field from what the block drew with', () => {
    const decorated = codeRoot('```ts title="utils.ts" line-numbers start=3 {2,4} wrap collapse=20 theme=dark\nx\n```')
    enhanceCodeBlockToolbarsInRoot(decorated)
    openPanel(decorated)
    const value = (name: string) => (node(decorated, `[data-code-input="${name}"]`) as HTMLInputElement).value
    expect(value('title')).toBe('utils.ts')
    expect(value('start')).toBe('3')
    expect(value('highlight')).toBe('2,4')
    expect(value('collapse')).toBe('20')
    expect(node(decorated, '[data-code-action="set-line-numbers"][data-code-val="on"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(decorated, '[data-code-action="set-theme"][data-code-val="dark"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(decorated, '[data-code-action="set-wrap"][data-code-val="wrap"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(decorated, '[data-code-action="set-collapse"][data-code-val="auto"]').getAttribute('aria-pressed')).toBe('false')
    expect(node(decorated, '[data-code-action="set-collapse"][data-code-val="never"]').getAttribute('aria-pressed')).toBe('false')
    const plain = codeRoot(BASE)
    enhanceCodeBlockToolbarsInRoot(plain)
    openPanel(plain)
    expect(node(plain, '[data-code-action="set-collapse"][data-code-val="auto"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(plain, '[data-code-action="set-line-numbers"][data-code-val="off"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(plain, '[data-code-action="set-theme"][data-code-val="auto"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(plain, '[data-code-action="set-wrap"][data-code-val="nowrap"]').getAttribute('aria-pressed')).toBe('true')
    expect((node(plain, '[data-code-input="collapse"]') as HTMLInputElement).value).toBe('')
  })

  it('writes the title, gutter, start and highlight back into the fence', () => {
    const write = (name: string, value: string, selector: string, source: string) => {
      const built = codeRoot(source)
      enhanceCodeBlockToolbarsInRoot(built)
      openPanel(built)
      ;(node(built, `[data-code-input="${name}"]`) as HTMLInputElement).value = value
      return run(built, selector, source)
    }
    expect(write('title', 'a.ts', '[data-code-action="apply-title"]', BASE)).toBe('```ts title="a.ts"\nconst a = 1;\n```')
    expect(write('title', '   ', '[data-code-action="apply-title"]', '```ts title="a.ts"\nx\n```')).toBe('```ts\nx\n```')
    expect(write('start', '7', '[data-code-action="apply-start"]', BASE)).toBe('```ts start=7\nconst a = 1;\n```')
    expect(write('start', 'abc', '[data-code-action="apply-start"]', BASE)).toBe('```ts\nconst a = 1;\n```')
    expect(write('highlight', '2,4-6', '[data-code-action="apply-highlight"]', BASE)).toBe('```ts {2,4,5,6}\nconst a = 1;\n```')
    expect(write('collapse', '30', '[data-code-action="apply-collapse"]', BASE)).toBe('```ts collapse=30\nconst a = 1;\n```')
  })

  it('toggles the gutter, palette and long-line mode', () => {
    openPanel(root)
    expect(run(root, '[data-code-action="set-line-numbers"][data-code-val="on"]', BASE)).toBe('```ts line-numbers\nconst a = 1;\n```')
    expect(run(root, '[data-code-action="set-theme"][data-code-val="light"]', BASE)).toBe('```ts theme=light\nconst a = 1;\n```')
    expect(run(root, '[data-code-action="set-wrap"][data-code-val="wrap"]', BASE)).toBe('```ts wrap\nconst a = 1;\n```')
    expect(run(root, '[data-code-action="set-collapse"][data-code-val="never"]', BASE)).toBe('```ts collapse=0\nconst a = 1;\n```')
    expect(run(root, '[data-code-action="set-collapse"][data-code-val="auto"]', '```ts collapse=12\nx\n```')).toBe('```ts\nx\n```')
  })

  it('refuses a fold value that is not a line count and writes nothing', () => {
    const built = codeRoot(BASE)
    enhanceCodeBlockToolbarsInRoot(built)
    openPanel(built)
    ;(node(built, '[data-code-input="collapse"]') as HTMLInputElement).value = 'lots'
    const toast = vi.fn()
    const edits: string[] = []
    expect(executeCodeBlockAction('apply-collapse', node(built, '[data-code-action="apply-collapse"]'), BASE, (next) => edits.push(next), toast as unknown as BlockToast)).toBe(true)
    expect(edits).toEqual([])
    expect(toast).toHaveBeenCalled()
  })

  it('keeps an option it does not own', () => {
    openPanel(root)
    expect(run(root, '[data-code-action="set-theme"][data-code-val="dark"]', '```ts layout=rl\nx\n```')).toBe('```ts layout=rl theme=dark\nx\n```')
  })

  it('declines when the line the block was drawn from is no longer a fence', () => {
    openPanel(root)
    const toast = vi.fn()
    const edits: string[] = []
    executeCodeBlockAction('set-wrap', node(root, '[data-code-action="set-wrap"][data-code-val="wrap"]'), '# just a heading\n', (next) => edits.push(next), toast as unknown as BlockToast)
    expect(edits).toEqual([])
    expect(toast).toHaveBeenCalled()
  })

  it('opens and closes the panel on its trigger', () => {
    const block = node(root, '.code-block')
    executeCodeBlockAction('toggle-settings', node(root, '[data-code-action="toggle-settings"]'), BASE, vi.fn(), vi.fn())
    expect(block.classList.contains('is-block-settings-open')).toBe(true)
    expect(node(root, '.block-settings').hasAttribute('hidden')).toBe(false)
    executeCodeBlockAction('toggle-settings', node(root, '[data-code-action="toggle-settings"]'), BASE, vi.fn(), vi.fn())
    expect(block.classList.contains('is-block-settings-open')).toBe(false)
    expect(node(root, '.block-settings').hasAttribute('hidden')).toBe(true)
    expect(codeBlockToolbar.close(node(root, '[data-code-action="toggle-settings"]'))).toBeNull()
  })

  it('reports an action it does not know and a target outside a code block', () => {
    openPanel(root)
    expect(executeCodeBlockAction('launch', node(root, '[data-code-action="set-wrap"]'), BASE, vi.fn(), vi.fn())).toBe(false)
    const outside = document.createElement('p')
    outside.textContent = 'plain prose'
    root.append(outside)
    expect(executeCodeBlockAction('set-wrap', outside, BASE, vi.fn(), vi.fn())).toBe(false)
  })

  it('routes a click through the note and refuses a stale preview', () => {
    openPanel(root)
    const editContent = vi.fn()
    codeBlockToolbar.handle({ preventDefault: vi.fn() }, node(root, '[data-code-action="set-wrap"][data-code-val="wrap"]'), {
      content: `${BASE}\nmore`,
      sourceNoteId: 'n1',
      committedSourceRef: { current: BASE },
      api: { editContent, toast: vi.fn() },
    })
    expect(editContent).not.toHaveBeenCalled()
    codeBlockToolbar.handle({ preventDefault: vi.fn() }, node(root, '[data-code-action="set-wrap"][data-code-val="wrap"]'), {
      content: BASE,
      sourceNoteId: 'n1',
      committedSourceRef: { current: BASE },
      api: { editContent, toast: vi.fn() },
    })
    expect(editContent).toHaveBeenCalledWith('n1', '```ts wrap\nconst a = 1;\n```')
  })
})

describe('code block format button', () => {
  const MESSY = '```ts\nfunction f(){\nconst a=1\nreturn a\n}\n```'
  const FORMATTED = '```ts\nfunction f() {\n  const a = 1\n  return a\n}\n```'
  const PADDED = '# Title\n\n' + MESSY + '\n\nafter\n'

  function built(source = MESSY, codeFormat?: { enabled: boolean, tabSize: number, keywordCase: 'upper' | 'lower' | 'keep' }): HTMLElement {
    const root = codeRoot(source)
    enhanceCodeBlockToolbarsInRoot(root, codeFormat ? { codeFormat } : undefined)
    return root
  }

  function press(root: HTMLElement, source: string, format?: { enabled: boolean, tabSize: number, keywordCase: 'upper' | 'lower' | 'keep' }): { edits: string[], toasts: { title: string, tone?: string }[] } {
    const edits: string[] = []
    const toasts: { title: string, tone?: string }[] = []
    const handled = executeCodeBlockAction(
      'format-code',
      node(root, '[data-code-action="format-code"]'),
      source,
      (next) => edits.push(next),
      (opts) => toasts.push(opts),
      format,
    )
    expect(handled).toBe(true)
    return { edits, toasts }
  }

  it('sits before the settings trigger and carries its own accessible name', () => {
    const root = built()
    const actions = [...node(root, '.block-tools').querySelectorAll<HTMLButtonElement>('button')].map((button) => button.dataset.codeAction)
    expect(actions).toEqual(['format-code', 'toggle-settings'])
    expect(node(root, '[data-code-action="format-code"]').getAttribute('aria-label')).toBeTruthy()
  })

  it('is not drawn when the setting is off, and the settings trigger still is', () => {
    const root = built(MESSY, { enabled: false, tabSize: 2, keywordCase: 'upper' })
    expect(root.querySelector('[data-code-action="format-code"]')).toBeNull()
    expect(root.querySelector('[data-code-action="toggle-settings"]')).not.toBeNull()
  })

  it('rewrites the body and leaves the fence lines and the rest of the note alone', () => {
    const { edits, toasts } = press(built(PADDED), PADDED)
    expect(edits).toEqual(['# Title\n\n' + FORMATTED + '\n\nafter\n'])
    expect(toasts[0]?.title).toBe('preview.code_format_done')
  })

  it('follows the tab size and keyword case it was drawn with', () => {
    const source = '```sql\nselect a from t\n```'
    const lower = press(built(source), source, { enabled: true, tabSize: 2, keywordCase: 'lower' })
    expect(lower.edits[0]).toBe('```sql\nselect a\nfrom t\n```')
    const upper = press(built(source), source, { enabled: true, tabSize: 2, keywordCase: 'upper' })
    expect(upper.edits[0]).toBe('```sql\nSELECT a\nFROM t\n```')
  })

  it('says the block was already formatted rather than writing nothing quietly', () => {
    const { edits, toasts } = press(built(FORMATTED), FORMATTED)
    expect(edits).toEqual([])
    expect(toasts[0]).toMatchObject({ title: 'preview.code_format_unchanged', tone: 'warning' })
  })

  it('keeps an offer to put the previous text back', () => {
    const edits: string[] = []
    const toasts: { title: string, action?: { label: string, run: () => void } }[] = []
    executeCodeBlockAction('format-code', node(built(PADDED), '[data-code-action="format-code"]'), PADDED, (next) => edits.push(next), (opts) => toasts.push(opts))
    expect(edits.length).toBe(1)
    toasts[0]?.action?.run()
    expect(edits[1]).toBe(PADDED)
  })

  it('refuses a block whose fence line no longer opens one', () => {
    const root = built(PADDED)
    const moved = PADDED.replace('```ts', 'plain prose')
    const { edits, toasts } = press(root, moved)
    expect(edits).toEqual([])
    expect(toasts[0]).toMatchObject({ title: 'preview.code_edit_unavailable', tone: 'warning' })
  })

  it('routes a click through the note and refuses a stale preview', () => {
    const root = built(PADDED)
    const editContent = vi.fn()
    const context = (source: string, committed: string) => ({
      content: source,
      sourceNoteId: 'n1',
      committedSourceRef: { current: committed },
      codeFormat: { enabled: true, tabSize: 2, keywordCase: 'upper' as const },
      api: { editContent, toast: vi.fn() },
    })
    codeBlockToolbar.handle({ preventDefault: vi.fn() }, node(root, '[data-code-action="format-code"]'), context(`${PADDED}typed`, PADDED))
    expect(editContent).not.toHaveBeenCalled()
    codeBlockToolbar.handle({ preventDefault: vi.fn() }, node(root, '[data-code-action="format-code"]'), context(PADDED, PADDED))
    expect(editContent).toHaveBeenCalledWith('n1', '# Title\n\n' + FORMATTED + '\n\nafter\n')
  })
})

describe('code option reads from rendered markup', () => {
  it('the panel reads the same values the renderer wrote', () => {
    const info = 'ts title="utils.ts" line-numbers start=3 {2,4} wrap collapse=20 theme=dark'
    const built = codeRoot('```' + info + '\nx\n```')
    enhanceCodeBlockToolbarsInRoot(built)
    openPanel(built)
    const block = node(built, '.code-block')
    expect(readCodeOptions(info)).toEqual({
      title: block.dataset.codeTitle,
      lineNumbers: block.dataset.lineNumbers === 'true',
      startLine: Number(block.dataset.codeStart),
      highlighted: (block.dataset.highlightLines ?? '').split(',').map(Number),
      wrap: block.dataset.codeWrap === 'true',
      collapse: block.dataset.codeCollapseAt === undefined ? null : Number(block.dataset.codeCollapseAt),
      theme: block.dataset.codeTheme ?? 'auto',
    })
  })
})
