import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { executeExampleLayoutAction, exampleToolbar, enhanceExampleLayoutsInRoot } from './example-layout'
import type { BlockToast } from './block-overlay'

function exampleRoot(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  return root
}

function click(block: HTMLElement, selector: string): HTMLElement {
  const node = block.querySelector<HTMLElement>(selector)
  if (!node) throw new Error(`no node for ${selector}`)
  return node
}

function commit(block: HTMLElement, selector: string, source: string): string | null {
  const edits: string[] = []
  const handled = executeExampleLayoutAction(
    click(block, selector).dataset.exampleAction!,
    click(block, selector),
    source,
    (next) => edits.push(next),
    vi.fn(),
  )
  expect(handled).toBe(true)
  return edits[0] ?? null
}

function openSettings(root: HTMLElement): void {
  const trigger = click(root, '[data-example-action="toggle-settings"]')
  if (trigger.getAttribute('aria-expanded') !== 'true') executeExampleLayoutAction('toggle-settings', trigger, '', vi.fn(), vi.fn())
}

const MD_SOURCE = '~~~md-example title="Demo"\n**bold**\n~~~'

describe('example layout toolbar', () => {
  let block: HTMLElement
  let source: string

  beforeEach(() => {
    block = exampleRoot(MD_SOURCE)
    source = MD_SOURCE
    enhanceExampleLayoutsInRoot(block)
  })

  it('builds the settings panel only when it is opened', () => {
    const head = block.querySelector('.markdown-example-head')!
    expect(head.querySelectorAll('.block-tool-btn').length).toBe(2)
    expect(block.querySelector('.block-popover')).not.toBeNull()
    expect(block.querySelector('.block-settings')).toBeNull()
    openSettings(block)
    expect(block.querySelectorAll('.block-settings').length).toBe(1)
    openSettings(block)
    expect(block.querySelectorAll('.block-settings').length).toBe(1)
    enhanceExampleLayoutsInRoot(block)
    expect(block.querySelectorAll('.block-tools').length).toBe(1)
  })

  it('stays out of a nested example, which has no line to write back to', () => {
    const nested = exampleRoot('~~~~~md-example\n~~~~md-example\nx\n~~~~\n~~~~~')
    enhanceExampleLayoutsInRoot(nested)
    expect(nested.querySelectorAll('.markdown-example').length).toBe(2)
    expect(nested.querySelectorAll('.block-tools').length).toBe(1)
  })

  it('writes the chosen direction into the fence and leaves the body alone', () => {
    const next = commit(block, '[data-example-action="set-layout"][data-example-val="rl"]', source)!
    expect(next).toBe('~~~md-example title="Demo" layout=rl\n**bold**\n~~~')
  })

  it('writes a preset ratio and the typed one alike', () => {
    openSettings(block)
    expect(commit(block, '[data-example-action="set-ratio"][data-example-val="3:7"]', source))
      .toBe('~~~md-example title="Demo" ratio="3:7"\n**bold**\n~~~')
    const input = click(block, '[data-example-ratio-input]') as HTMLInputElement
    input.value = '6:4'
    expect(commit(block, '[data-example-action="apply-ratio"]', source))
      .toBe('~~~md-example title="Demo" ratio="6:4"\n**bold**\n~~~')
  })

  it('refuses a ratio that would collapse a panel and writes nothing', () => {
    openSettings(block)
    const toast = vi.fn() as unknown as BlockToast
    const input = click(block, '[data-example-ratio-input]') as HTMLInputElement
    input.value = '0:7'
    const edits: string[] = []
    expect(executeExampleLayoutAction('apply-ratio', click(block, '[data-example-action="apply-ratio"]'), source, (next) => edits.push(next), toast)).toBe(true)
    expect(edits).toEqual([])
    expect(toast).toHaveBeenCalled()
  })

  it('swaps the current direction and resets to a plain fence', () => {
    openSettings(block)
    const swapped = commit(block, '[data-example-action="swap"]', source)!
    expect(swapped).toBe('~~~md-example title="Demo" layout=rl\n**bold**\n~~~')
    const block2 = exampleRoot(swapped)
    enhanceExampleLayoutsInRoot(block2)
    openSettings(block2)
    expect(commit(block2, '[data-example-action="reset"]', swapped)).toBe('~~~md-example title="Demo"\n**bold**\n~~~')
  })

  it('drops an option that equals the family default and keeps the other', () => {
    const withLayout = '~~~md-example title="Demo" layout=tb ratio="2:8"\n**bold**\n~~~'
    const block = exampleRoot(withLayout)
    enhanceExampleLayoutsInRoot(block)
    openSettings(block)
    expect(commit(block, '[data-example-action="set-layout"][data-example-val="lr"]', withLayout))
      .toBe('~~~md-example title="Demo" ratio="2:8"\n**bold**\n~~~')
    const input = click(block, '[data-example-ratio-input]') as HTMLInputElement
    expect(input.value).toBe('2:8')
    input.value = '45:55'
    expect(commit(block, '[data-example-action="apply-ratio"]', withLayout))
      .toBe('~~~md-example title="Demo" layout=tb\n**bold**\n~~~')
  })

  it('opens one overlay at a time and hands focus back on Escape', () => {
    const example = block.querySelector('.markdown-example')!
    const layoutTrigger = click(block, '[data-example-action="toggle-layout"]')
    const settingsTrigger = click(block, '[data-example-action="toggle-settings"]')
    executeExampleLayoutAction('toggle-layout', layoutTrigger, source, vi.fn(), vi.fn())
    expect(example.classList.contains('is-block-layout-open')).toBe(true)
    expect(layoutTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(block.querySelector('.block-popover')!.hasAttribute('hidden')).toBe(false)
    executeExampleLayoutAction('toggle-settings', settingsTrigger, source, vi.fn(), vi.fn())
    expect(example.classList.contains('is-block-layout-open')).toBe(false)
    expect(example.classList.contains('is-block-settings-open')).toBe(true)
    expect(block.querySelector('.block-popover')!.hasAttribute('hidden')).toBe(true)
    const input = click(block, '[data-example-ratio-input]') as HTMLInputElement
    input.value = 'stale'
    expect(exampleToolbar.close(settingsTrigger)).toBe(settingsTrigger)
    expect(example.classList.contains('is-block-settings-open')).toBe(false)
    executeExampleLayoutAction('toggle-settings', settingsTrigger, source, vi.fn(), vi.fn())
    expect(input.value).toBe('45:55')
  })

  it('closes an overlay when the click lands outside the block', () => {
    const example = block.querySelector('.markdown-example')!
    executeExampleLayoutAction('toggle-layout', click(block, '[data-example-action="toggle-layout"]'), source, vi.fn(), vi.fn())
    expect(example.classList.contains('is-block-layout-open')).toBe(true)
    exampleToolbar.dismiss(block)
    expect(example.classList.contains('is-block-layout-open')).toBe(false)
  })

  it('leaves an overlay open when the click lands inside its own panel', () => {
    const example = block.querySelector('.markdown-example')!
    executeExampleLayoutAction('toggle-settings', click(block, '[data-example-action="toggle-settings"]'), source, vi.fn(), vi.fn())
    exampleToolbar.dismiss(click(block, '[data-example-ratio-input]'))
    expect(example.classList.contains('is-block-settings-open')).toBe(true)
  })

  it('declines to write when the fence is no longer where the block was drawn', () => {
    openSettings(block)
    const toast = vi.fn() as unknown as BlockToast
    const edits: string[] = []
    executeExampleLayoutAction('swap', click(block, '[data-example-action="swap"]'), '# Title\n\n~~~md-example title="Demo"\ntotally different\n~~~\n', (next) => edits.push(next), toast)
    expect(edits).toEqual([])
    expect(toast).toHaveBeenCalled()
  })

  it('refuses to act without a note to write to', () => {
    openSettings(block)
    const editContent = vi.fn()
    const handled = exampleToolbar.handle({ preventDefault: vi.fn() }, click(block, '[data-example-action="swap"]'), {
      content: source,
      sourceNoteId: null,
      committedSourceRef: { current: source },
      api: { editContent, toast: vi.fn() },
    })
    expect(handled).toBe(true)
    expect(editContent).not.toHaveBeenCalled()
  })

  it('refuses to write while the preview is behind the editor', () => {
    openSettings(block)
    const editContent = vi.fn()
    const toast = vi.fn()
    exampleToolbar.handle({ preventDefault: vi.fn() }, click(block, '[data-example-action="swap"]'), {
      content: `${source}\ntyping`,
      sourceNoteId: 'n1',
      committedSourceRef: { current: source },
      api: { editContent, toast: toast as unknown as BlockToast },
    })
    expect(editContent).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })

  it('writes through the note when the preview and the editor agree', () => {
    openSettings(block)
    const editContent = vi.fn()
    exampleToolbar.handle({ preventDefault: vi.fn() }, click(block, '[data-example-action="swap"]'), {
      content: source,
      sourceNoteId: 'n1',
      committedSourceRef: { current: source },
      api: { editContent, toast: vi.fn() },
    })
    expect(editContent).toHaveBeenCalledWith('n1', '~~~md-example title="Demo" layout=rl\n**bold**\n~~~')
  })
})

describe('javascript-example layout defaults', () => {
  it('starts stacked and writes the js fence, not the markdown one', () => {
    const jsSource = '~~~~javascript-example title="Sum"\nconsole.log(2);\n~~~~'
    const block = exampleRoot(jsSource)
    enhanceExampleLayoutsInRoot(block)
    const grid = block.querySelector<HTMLElement>('.markdown-example-grid')!
    expect(grid.dataset.exampleLayout).toBe('tb')
    openSettings(block)
    const input = click(block, '[data-example-ratio-input]') as HTMLInputElement
    expect(input.value).toBe('45:55')
    expect(commit(block, '[data-example-action="set-layout"][data-example-val="lr"]', jsSource))
      .toBe('~~~~javascript-example title="Sum" layout=lr\nconsole.log(2);\n~~~~')
  })

  it('keeps the run controls and the layout tools in one row', () => {
    const jsSource = '~~~js-example\n1\n~~~'
    const block = exampleRoot(jsSource)
    block.querySelector('.js-example-head')!.append(Object.assign(document.createElement('div'), { className: 'js-example-controls' }))
    enhanceExampleLayoutsInRoot(block)
    const controls = block.querySelector('.js-example-controls')!
    expect(controls.firstElementChild!.className).toBe('block-tools')
    expect(block.querySelector('.markdown-example-head > .block-tools')).toBeNull()
  })
})
