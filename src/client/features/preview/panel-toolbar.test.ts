import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePanelToolbarsInRoot, executePanelAction } from './panel-toolbar'

// i18n is left uninitialised on purpose: `t()` then returns the key, so the assertions name the copy
// slot rather than a translation that may be reworded.

function withSource(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  enhancePanelToolbarsInRoot(root)
  root.dataset.source = markdown
  return root
}

function click(root: HTMLElement, action: string, value?: string) {
  const selector = value === undefined
    ? `[data-panel-action="${action}"]`
    : `[data-panel-action="${action}"][data-panel-val="${value}"]`
  const button = root.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`no ${selector} in ${root.innerHTML}`)
  const editContent = vi.fn()
  const toast = vi.fn()
  const handled = executePanelAction(action, button, root.dataset.source ?? '', editContent, toast)
  return { handled, editContent, toast, button, next: () => String(editContent.mock.calls[0]?.[0]) }
}

function settings(root: HTMLElement): HTMLElement | null {
  return root.querySelector('.panel-block > .block-settings')
}

function openSettings(root: HTMLElement): HTMLElement | null {
  click(root, 'toggle-settings')
  return settings(root)
}

function countSeparators(source: string): number {
  return source.split('\n').filter((line) => line.trim() === '::').length
}

describe('the layout block’s chrome', () => {
  it('wraps an alignment block and names it', () => {
    const root = withSource('::: center\nbody\n:::')
    const wrapper = root.querySelector('.panel-block')
    expect(wrapper?.querySelector('.markdown-align')).not.toBeNull()
    expect(wrapper?.querySelector('.block-head-title')?.textContent).toBe('workspace.alignment')
    expect(root.querySelectorAll('.panel-block')).toHaveLength(1)
  })

  it('names a column block by what it is', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    expect(root.querySelector('.block-head-title')?.textContent).toBe('workspace.columns')
  })

  it('builds the settings rows only once the panel is opened', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    expect(settings(root)?.childElementCount).toBe(0)
    expect(openSettings(root)?.querySelectorAll('[data-panel-action]').length).toBeGreaterThan(4)
  })

  it('does not wrap a block twice', () => {
    const root = withSource('::: center\na\n:::')
    enhancePanelToolbarsInRoot(root)
    expect(root.querySelectorAll('.panel-block')).toHaveLength(1)
  })

  it('leaves a read-only embed alone', () => {
    const root = document.createElement('div')
    root.className = 'ink-prose'
    const embed = document.createElement('div')
    embed.className = 'note-embed-body'
    embed.innerHTML = renderMarkdown('::: center\na\n:::').html
    root.append(embed)
    enhancePanelToolbarsInRoot(root)
    expect(root.querySelector('.panel-block')).toBeNull()
  })

  it('gives the gear a control target that exists', () => {
    const root = withSource('::: center\na\n:::')
    const trigger = root.querySelector<HTMLButtonElement>('[data-panel-action="toggle-settings"]')!
    const target = root.querySelector(`#${trigger.getAttribute('aria-controls')}`)
    expect(target?.classList.contains('block-settings')).toBe(true)
  })
})

describe('rewriting an alignment block', () => {
  it('writes the chosen alignment into the header', () => {
    const root = withSource('::: center\nbody\n:::')
    openSettings(root)
    expect(click(root, 'set-align', 'right').next()).toBe('::: right\nbody\n:::')
  })

  it('routes a column block’s alignment to its own attribute', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    openSettings(root)
    expect(click(root, 'set-align', 'center').next()).toBe('::: cols center\na\n::\nb\n:::')
  })

  it('says so when the header is no longer where the block was drawn', () => {
    const root = withSource('::: center\nbody\n:::')
    openSettings(root)
    root.dataset.source = '# nothing here\n'
    const rejected = click(root, 'set-align', 'right')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.panel_edit_unavailable', tone: 'warning' }))
  })

  it('closes the panel as it commits, so the reader sees the block change', () => {
    const root = withSource('::: center\nbody\n:::')
    openSettings(root)
    expect(settings(root)?.hasAttribute('hidden')).toBe(false)
    click(root, 'set-align', 'right')
    expect(settings(root)?.hasAttribute('hidden')).toBe(true)
  })
})

describe('rewriting a column block', () => {
  it('sets the gap', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    openSettings(root)
    expect(click(root, 'set-gap', 'wide').next()).toBe('::: cols gap=wide\na\n::\nb\n:::')
  })

  it('sets the divider', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    openSettings(root)
    expect(click(root, 'set-divider', 'on').next()).toBe('::: cols divider\na\n::\nb\n:::')
  })

  it('ignores a gap the vocabulary does not know', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    openSettings(root)
    const button = root.querySelector<HTMLButtonElement>('[data-panel-action="set-gap"]')!.cloneNode(true) as HTMLButtonElement
    button.dataset.panelVal = 'enormous'
    const editContent = vi.fn()
    expect(executePanelAction('set-gap', button, '::: cols\na\n::\nb\n:::', editContent, vi.fn())).toBe(false)
    expect(editContent).not.toHaveBeenCalled()
  })

  it('steps from the count the block actually draws', () => {
    const root = withSource('::: cols 2\na\n::\nb\n::\nc\n::\nd\n:::')
    expect(root.querySelector<HTMLElement>('.markdown-cols')?.dataset.cols).toBe('2')
    openSettings(root)
    expect(root.querySelector('.block-settings-value')?.textContent).toBe('2')
    const next = click(root, 'columns-add').next()
    expect(next).toMatch(/^::: cols 3\n/)
    expect(countSeparators(next)).toBe(2)
  })

  it('refuses to step past what the stylesheet draws, in either direction', () => {
    const single = withSource('::: cols\na\n:::')
    expect(openSettings(single)?.querySelector('[data-panel-action="columns-remove"]')?.hasAttribute('disabled')).toBe(true)
    const six = withSource('::: cols 6\na\n::\nb\n::\nc\n::\nd\n::\ne\n::\nf\n:::')
    expect(six.querySelector<HTMLElement>('.markdown-cols')?.dataset.cols).toBe('6')
    expect(openSettings(six)?.querySelector('[data-panel-action="columns-add"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('offers a wider-column preset at either end of any count', () => {
    const labels = (source: string) => {
      const root = withSource(source)
      openSettings(root)
      return [...root.querySelectorAll<HTMLButtonElement>('[data-panel-action="set-ratio"]')].map((button) => button.dataset.panelVal)
    }
    expect(labels('::: cols\na\n::\nb\n:::')).toEqual(['', '1:2', '2:1'])
    expect(labels('::: cols\na\n::\nb\n::\nc\n:::')).toEqual(['', '1:1:2', '2:1:1'])
    expect(labels('::: cols\na\n::\nb\n::\nc\n::\nd\n:::')).toEqual(['', '1:1:1:2', '2:1:1:1'])
  })

  it('applies a preset without touching the separators', () => {
    const root = withSource('::: cols\na\n::\nb\n:::')
    openSettings(root)
    const next = click(root, 'set-ratio', '2:1').next()
    expect(next).toMatch(/^::: cols 2 2fr 1fr\n/)
    expect(countSeparators(next)).toBe(1)
  })

  it('takes a typed ratio and rejects one that would reshape the block', () => {
    const root = withSource('::: cols\na\n::\nb\n::\nc\n:::')
    openSettings(root)
    root.querySelector<HTMLInputElement>('[data-panel-ratio-input]')!.value = '2:1:1'
    expect(click(root, 'apply-ratio').next()).toMatch(/^::: cols 3 2fr 1fr 1fr\n/)

    const other = withSource('::: cols\na\n::\nb\n:::')
    openSettings(other)
    other.querySelector<HTMLInputElement>('[data-panel-ratio-input]')!.value = '1:1:2'
    const rejected = click(other, 'apply-ratio')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.panel_ratio_invalid', tone: 'warning' }))

    const malformed = withSource('::: cols\na\n::\nb\n:::')
    openSettings(malformed)
    malformed.querySelector<HTMLInputElement>('[data-panel-ratio-input]')!.value = '50:50'
    expect(click(malformed, 'apply-ratio').editContent).not.toHaveBeenCalled()
  })

  it('clears back to equal widths', () => {
    const root = withSource('::: cols 1fr 2fr\na\n::\nb\n:::')
    openSettings(root)
    expect(click(root, 'set-ratio', '').next()).toBe('::: cols\na\n::\nb\n:::')
  })

  it('marks the choice the block already made', () => {
    const root = withSource('::: cols 2 gap=wide divider center\na\n::\nb\n:::')
    openSettings(root)
    const active = [...root.querySelectorAll<HTMLButtonElement>('.block-settings .block-opt-btn.is-active')].map((button) => `${button.dataset.panelAction}:${button.dataset.panelVal}`)
    expect(active).toEqual(expect.arrayContaining(['set-gap:wide', 'set-divider:on', 'set-align:center']))
  })
})
