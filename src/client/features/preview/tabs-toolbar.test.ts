import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { closeBlockToolbarOverlay } from './block-actions'
import { dismissTabsOverlays, enhanceTabsToolbarsInRoot, executeTabsAction } from './tabs-toolbar'
import { groupTabButtons, selectMarkdownTab } from './markdown-tabs'

afterEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

function withSource(markdown: string, options = {}): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  enhanceTabsToolbarsInRoot(root, options)
  root.dataset.source = markdown
  document.body.append(root)
  return root
}

function group(root: HTMLElement, index = 0): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>('.markdown-tabs[data-tabs]')[index]
  if (!found) throw new Error('no tab block')
  return found
}

function buttonOf(root: HTMLElement, action: string, opts: { value?: string, set?: string, group?: number, in?: 'popover' | 'settings' } = {}): HTMLButtonElement {
  const scope = group(root, opts.group ?? 0)
  const within = opts.in === 'popover' ? '.block-popover ' : opts.in === 'settings' ? '.block-settings ' : ''
  const parts = [`[data-tabs-action="${action}"]`]
  if (opts.set) parts.push(`[data-tabs-set="${opts.set}"]`)
  if (opts.value !== undefined) parts.push(`[data-tabs-val="${opts.value}"]`)
  const button = scope.querySelector<HTMLButtonElement>(`${within}${parts.join('')}`)
  if (!button) throw new Error(`no ${within}${parts.join('')} in ${scope.innerHTML}`)
  return button
}

function click(root: HTMLElement, action: string, opts: { value?: string, set?: string, group?: number, in?: 'popover' | 'settings' } = {}) {
  const button = buttonOf(root, action, opts)
  const editContent = vi.fn()
  const toast = vi.fn()
  const handled = executeTabsAction(action, button, root.dataset.source ?? '', editContent, toast)
  return { handled, editContent, toast, button, next: () => String(editContent.mock.calls[0]?.[0]) }
}

const TWO_TABS = ':::: tabs\n@tab One\na\n@tab Two\nb\n::::'

describe('the tab block’s chrome', () => {
  it('prepends the toolbar inside the box, ahead of the strip', () => {
    const root = withSource(TWO_TABS)
    const tabs = group(root)
    expect(tabs.firstElementChild?.className).toBe('markdown-tabs-header-wrap')
    expect(tabs.querySelector('.tab-list')?.previousElementSibling?.className).toContain('markdown-tabs-header-wrap')
    expect(tabs.querySelectorAll(':scope > .markdown-tabs-header-wrap')).toHaveLength(1)
  })

  it('builds the settings rows only once the panel is opened', () => {
    const root = withSource(TWO_TABS)
    const panel = group(root).querySelector<HTMLElement>('.markdown-tabs-header-wrap > .block-settings')
    expect(panel?.childElementCount).toBe(0)
    click(root, 'toggle-settings')
    expect(panel?.querySelectorAll('[data-tabs-action]').length).toBeGreaterThan(6)
  })

  it('does not add a second toolbar to a block it has already dressed', () => {
    const root = withSource(TWO_TABS)
    enhanceTabsToolbarsInRoot(root)
    expect(group(root).querySelectorAll(':scope > .markdown-tabs-header-wrap')).toHaveLength(1)
  })

  it('leaves a read-only embed alone', () => {
    const root = document.createElement('div')
    root.className = 'ink-prose'
    const embed = document.createElement('div')
    embed.className = 'note-embed-body'
    embed.innerHTML = renderMarkdown(TWO_TABS).html
    root.append(embed)
    enhanceTabsToolbarsInRoot(root)
    expect(root.querySelector('.markdown-tabs-header-wrap')).toBeNull()
  })

  it('gives the layout trigger a control target that exists', () => {
    const root = withSource(TWO_TABS)
    const trigger = group(root).querySelector<HTMLButtonElement>('[data-tabs-action="toggle-layout"]')!
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull()
  })
})

describe('the remembered choice of a sync group', () => {
  const scope = { noteId: 'note-9', userId: 'user-9' }

  it('is applied to the block before it reaches the page', () => {
    localStorage.setItem('inkstone:tabs-sync:v1:user-9:note-9:lang', '1')
    const root = withSource(':::: tabs sync=lang\n@tab One\na\n@tab Two\nb\n::::', { tabScope: scope })
    expect(groupTabButtons(group(root))[1]?.getAttribute('aria-selected')).toBe('true')
    expect(group(root).querySelector<HTMLElement>('[data-tab-panel="0"]')?.hidden).toBe(true)
  })

  it('leaves a stored index the block does not have alone', () => {
    localStorage.setItem('inkstone:tabs-sync:v1:user-9:note-9:lang', '7')
    const root = withSource(':::: tabs sync=lang\n@tab One\na\n@tab Two\nb\n::::', { tabScope: scope })
    expect(groupTabButtons(group(root))[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('does nothing to a block that is in no group', () => {
    const root = withSource(TWO_TABS, { tabScope: scope })
    expect(groupTabButtons(group(root))[0]?.getAttribute('aria-selected')).toBe('true')
  })
})

describe('rewriting the tab block', () => {
  it('sets the style from the settings panel', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    expect(click(root, 'set-option', { in: 'settings', set: 'variant', value: 'pills' }).next()).toBe(':::: tabs variant=pills\n@tab One\na\n@tab Two\nb\n::::')
  })

  it('writes a position chosen from the floating popover', () => {
    const root = withSource(TWO_TABS)
    expect(click(root, 'set-option', { in: 'popover', set: 'position', value: 'bottom' }).next()).toBe(':::: tabs position=bottom\n@tab One\na\n@tab Two\nb\n::::')
  })

  it('closes the popover as it commits a layout choice', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-layout')
    expect(group(root).classList.contains('is-layout-open')).toBe(true)
    click(root, 'set-option', { in: 'popover', set: 'position', value: 'left' })
    expect(group(root).classList.contains('is-layout-open')).toBe(false)
  })

  it('adds a tab in the spelling the block uses', () => {
    const root = withSource(TWO_TABS)
    // i18n is left uninitialised here, so the fallback title arrives as its key.
    expect(click(root, 'add-tab').next()).toBe(':::: tabs\n@tab One\na\n@tab Two\nb\n@tab common.tabs 3\n\n::::')
  })

  it('renames the tab being shown', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    root.querySelector<HTMLInputElement>('[data-tabs-rename-input]')!.value = 'Renamed'
    expect(click(root, 'rename-tab').next()).toBe(':::: tabs\n@tab Renamed\na\n@tab Two\nb\n::::')
  })

  it('names the rename field after the tab it will change', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    expect(root.querySelector<HTMLInputElement>('[data-tabs-rename-input]')?.value).toBe('One')
    selectMarkdownTab(groupTabButtons(group(root))[1]!)
    click(root, 'toggle-settings')
    click(root, 'toggle-settings')
    expect(root.querySelector<HTMLInputElement>('[data-tabs-rename-input]')?.value).toBe('Two')
  })

  it('refuses to rename a tab to nothing', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    root.querySelector<HTMLInputElement>('[data-tabs-rename-input]')!.value = '   '
    const rejected = click(root, 'rename-tab')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_name_required' }))
  })

  it('refuses to delete the only tab', () => {
    const root = withSource(':::: tabs\n@tab One\na\n::::')
    click(root, 'toggle-settings')
    expect(root.querySelector<HTMLButtonElement>('[data-tabs-action="delete-tab"]')?.hasAttribute('disabled')).toBe(true)
    const rejected = click(root, 'delete-tab')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_cannot_delete_last' }))
  })

  it('deletes the tab being shown and keeps the other', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    expect(click(root, 'delete-tab').next()).toBe(':::: tabs\n@tab Two\nb\n::::')
  })

  it('links a sync group and clears it again', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    root.querySelector<HTMLInputElement>('[data-tabs-sync-input]')!.value = 'lang'
    expect(click(root, 'set-sync').next()).toBe(':::: tabs sync=lang\n@tab One\na\n@tab Two\nb\n::::')
    const cleared = withSource(':::: tabs sync=lang\n@tab One\na\n::::')
    click(cleared, 'toggle-settings')
    expect(click(cleared, 'clear-sync').next()).toBe(':::: tabs\n@tab One\na\n::::')
  })

  it('rejects a group name that would not survive an attribute', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-settings')
    root.querySelector<HTMLInputElement>('[data-tabs-sync-input]')!.value = 'a b"onmouseover=x'
    const rejected = click(root, 'set-sync')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_sync_invalid' }))
  })

  it('says so when the block is no longer where it was drawn', () => {
    const root = withSource(TWO_TABS)
    root.dataset.source = '# nothing here\n'
    const rejected = click(root, 'add-tab')
    expect(rejected.editContent).not.toHaveBeenCalled()
    expect(rejected.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_edit_unavailable' }))
  })
})

describe('copying the tab being shown', () => {
  it('tells the reader when the browser will not take the text', async () => {
    const root = withSource(TWO_TABS)
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const toast = vi.fn()
    executeTabsAction('copy-tab', buttonOf(root, 'copy-tab'), root.dataset.source!, vi.fn(), toast)
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_copy_unavailable', tone: 'warning' })))
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
  })

  it('tells the reader when the browser refuses a write it accepted', async () => {
    const root = withSource(TWO_TABS)
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    const toast = vi.fn()
    executeTabsAction('copy-tab', buttonOf(root, 'copy-tab'), root.dataset.source!, vi.fn(), toast)
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.tabs_copy_unavailable', tone: 'warning' })))
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
  })

  it('writes the visible panel’s text and nothing else', async () => {
    const root = withSource(TWO_TABS)
    // `innerText` is the copy that respects the rendered line breaks, and jsdom has no layout engine
    // to compute it, so the panel stands in for the browser rather than the code standing down.
    const panel = group(root).querySelector<HTMLElement>('[data-tab-panel="0"]')!
    Object.defineProperty(panel, 'innerText', { value: 'a', configurable: true })
    const other = group(root).querySelector<HTMLElement>('[data-tab-panel="1"]')!
    Object.defineProperty(other, 'innerText', { value: 'b', configurable: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toast = vi.fn()
    executeTabsAction('copy-tab', buttonOf(root, 'copy-tab'), root.dataset.source!, vi.fn(), toast)
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('a'))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'common.copied', tone: 'success' }))
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
  })
})

describe('opening and closing the overlays', () => {
  it('keeps only one of the two open at a time', () => {
    const root = withSource(TWO_TABS)
    const tabs = group(root)
    click(root, 'toggle-layout')
    expect(tabs.classList.contains('is-layout-open')).toBe(true)
    click(root, 'toggle-settings')
    expect(tabs.classList.contains('is-layout-open')).toBe(false)
    expect(tabs.classList.contains('is-settings-open')).toBe(true)
  })

  it('closes on a click elsewhere in the same surface', () => {
    const root = withSource(`${TWO_TABS}\n\n::: center\nx\n:::`)
    click(root, 'toggle-layout')
    dismissTabsOverlays(root.querySelector<HTMLElement>('.markdown-align')!)
    expect(group(root).classList.contains('is-layout-open')).toBe(false)
  })

  it('closes a block’s popover when the reader works on another block', () => {
    const root = withSource(`${TWO_TABS}\n\n${TWO_TABS}`)
    click(root, 'toggle-layout', { group: 1 })
    dismissTabsOverlays(buttonOf(root, 'toggle-settings', { group: 0 }))
    expect(group(root, 1).classList.contains('is-layout-open')).toBe(false)
  })

  it('leaves the pressed block’s own overlay for the click handler to act on', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-layout')
    dismissTabsOverlays(buttonOf(root, 'toggle-layout'))
    expect(group(root).classList.contains('is-layout-open')).toBe(true)
  })

  it('returns the trigger that escape should refocus', () => {
    const root = withSource(TWO_TABS)
    click(root, 'toggle-layout')
    const trigger = closeBlockToolbarOverlay(buttonOf(root, 'toggle-layout'))
    expect(trigger?.dataset.tabsAction).toBe('toggle-layout')
    expect(group(root).classList.contains('is-layout-open')).toBe(false)
  })
})
