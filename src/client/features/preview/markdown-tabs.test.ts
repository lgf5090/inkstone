import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import {
  applyTabSelection,
  groupTabButtons,
  moveMarkdownTabFocus,
  readSyncedTabChoice,
  revealPreviewTarget,
  selectMarkdownTab,
  selectedTabIndex,
} from './markdown-tabs'

const SCOPE = { noteId: 'note-1', userId: 'user-1' }

afterEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

function surface(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  // jsdom only moves `document.activeElement` for a node that is in the document, which is what the
  // keyboard-handling assertions below are about.
  document.body.append(root)
  return root
}

function groups(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.markdown-tabs[data-tabs]')]
}

function button(group: HTMLElement, index: number): HTMLButtonElement {
  const found = groupTabButtons(group).find((candidate) => candidate.dataset.tabButton === String(index))
  if (!found) throw new Error(`no tab button ${index}`)
  return found
}

function visiblePanel(group: HTMLElement): string | null {
  const panel = groupTabPanelsOf(group).find((candidate) => !candidate.hidden)
  return panel?.dataset.tabPanel ?? null
}

function groupTabPanelsOf(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('[data-tab-panel]')].filter((panel) => panel.closest('[data-tabs]') === group)
}

const TWO_GROUPS = [
  ':::: tabs sync=lang',
  '@tab One',
  'first',
  '@tab Two',
  'second',
  '::::',
  '',
  ':::: tabs sync=lang',
  '@tab A',
  'a',
  '@tab B',
  'b',
  '@tab C',
  'c',
  '::::',
].join('\n')

describe('selecting a tab', () => {
  it('shows the chosen panel and roves the rest', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\nb\n::::')
    const group = groups(root)[0]!
    expect(applyTabSelection(group, 1)).toBe(true)
    expect(visiblePanel(group)).toBe('1')
    expect(button(group, 1).getAttribute('aria-selected')).toBe('true')
    expect(button(group, 0).tabIndex).toBe(-1)
    expect(button(group, 1).tabIndex).toBe(0)
  })

  it('reports a repeat and an out-of-range index rather than hiding everything', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\nb\n::::')
    const group = groups(root)[0]!
    expect(applyTabSelection(group, 1)).toBe(true)
    expect(applyTabSelection(group, 1)).toBe(false)
    expect(applyTabSelection(group, 9)).toBe(false)
    expect(applyTabSelection(group, -1)).toBe(false)
    expect(visiblePanel(group)).toBe('1')
  })

  it('leaves a nested group’s own choice alone', () => {
    const root = surface([':::: tabs', '@tab Outer', '::::: tabs', '@tab Inner one', 'x', '@tab Inner two', 'y', ':::::', '@tab Second', 'z', '::::'].join('\n'))
    const outer = groups(root)[0]!
    const inner = groups(root)[1]!
    selectMarkdownTab(button(inner, 1))
    expect(visiblePanel(inner)).toBe('1')
    expect(visiblePanel(outer)).toBe('0')
  })
})

describe('a sync group', () => {
  it('switches every block in the surface to the same index', () => {
    const root = surface(TWO_GROUPS)
    const [first, second] = groups(root)
    selectMarkdownTab(button(first!, 1))
    expect(visiblePanel(first!)).toBe('1')
    expect(visiblePanel(second!)).toBe('1')
  })

  it('leaves a block that has no such index showing what it showed', () => {
    const root = surface(':::: tabs sync=g\n@tab One\na\n::::\n\n:::: tabs sync=g\n@tab X\nx\n@tab Y\ny\n::::')
    const [tiny, big] = groups(root)
    selectMarkdownTab(button(big!, 1))
    expect(visiblePanel(tiny!)).toBe('0')
    expect(visiblePanel(big!)).toBe('1')
  })

  it('remembers the choice for this account and note, and reads it back', () => {
    const root = surface(TWO_GROUPS)
    selectMarkdownTab(button(groups(root)[0]!, 1), SCOPE)
    expect(readSyncedTabChoice(SCOPE, 'lang')).toBe(1)
    expect(localStorage.getItem('inkstone:tabs-sync:v1:user-1:note-1:lang')).toBe('1')
  })

  it('keeps one account’s choice away from another’s', () => {
    const root = surface(TWO_GROUPS)
    selectMarkdownTab(button(groups(root)[1]!, 2), SCOPE)
    expect(readSyncedTabChoice({ noteId: 'note-1', userId: 'user-2' }, 'lang')).toBeNull()
    expect(readSyncedTabChoice({ noteId: 'note-2', userId: 'user-1' }, 'lang')).toBeNull()
  })

  it('writes nothing when the surface cannot say whose note it is', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    const root = surface(TWO_GROUPS)
    selectMarkdownTab(button(groups(root)[0]!, 1))
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('ignores a stored value that is not a panel number', () => {
    localStorage.setItem('inkstone:tabs-sync:v1:user-1:note-1:lang', 'not-a-number')
    expect(readSyncedTabChoice(SCOPE, 'lang')).toBeNull()
    localStorage.setItem('inkstone:tabs-sync:v1:user-1:note-1:lang', '-3')
    expect(readSyncedTabChoice(SCOPE, 'lang')).toBeNull()
  })
})

describe('moving focus along the strip', () => {
  it('wraps at either end and takes the panel with the focus', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\nb\n@tab Three\nc\n::::')
    const group = groups(root)[0]!
    moveMarkdownTabFocus(button(group, 0), 'ArrowLeft')
    expect(document.activeElement).toBe(button(group, 2))
    expect(visiblePanel(group)).toBe('2')
    moveMarkdownTabFocus(button(group, 2), 'ArrowRight')
    expect(visiblePanel(group)).toBe('0')
    moveMarkdownTabFocus(button(group, 1), 'Home')
    expect(visiblePanel(group)).toBe('0')
    moveMarkdownTabFocus(button(group, 0), 'End')
    expect(visiblePanel(group)).toBe('2')
  })

  it('leaves a key that is not a tab key alone', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\nb\n::::')
    const group = groups(root)[0]!
    const before = visiblePanel(group)
    moveMarkdownTabFocus(button(group, 0), 'Enter')
    expect(visiblePanel(group)).toBe(before)
  })
})

describe('revealing a target inside collapsed blocks', () => {
  it('opens the details and selects the panels down to the target', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\n<details><summary>s</summary><b id="deep">deep</b></details>\n::::')
    const group = groups(root)[0]!
    const deep = group.querySelector('#deep')!
    expect(visiblePanel(group)).toBe('0')
    revealPreviewTarget(deep)
    expect(visiblePanel(group)).toBe('1')
    expect((group.querySelector('details')! as HTMLDetailsElement).open).toBe(true)
  })
})

describe('the chart in a panel that was hidden', () => {
  it('tells the window the size changed when a panel with a chart appears', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\n```chart\nx\n```\n::::')
    const group = groups(root)[0]!
    const listener = vi.fn()
    window.addEventListener('resize', listener)
    applyTabSelection(group, 1)
    expect(listener).toHaveBeenCalled()
    window.removeEventListener('resize', listener)
  })

  it('says nothing when the panel holds nothing that measures itself', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab Two\nb\n::::')
    const group = groups(root)[0]!
    const listener = vi.fn()
    window.addEventListener('resize', listener)
    applyTabSelection(group, 1)
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('resize', listener)
  })
})

describe('the selected index', () => {
  it('is the one the markup says, and zero when nothing claims it', () => {
    const root = surface(':::: tabs\n@tab One\na\n@tab:active Two\nb\n::::')
    const group = groups(root)[0]!
    expect(selectedTabIndex(group)).toBe(1)
    groupTabButtons(group).forEach((candidate) => candidate.removeAttribute('aria-selected'))
    expect(selectedTabIndex(group)).toBe(0)
  })
})
