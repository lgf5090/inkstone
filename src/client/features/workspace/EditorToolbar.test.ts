import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { EditorToolbar } from './EditorToolbar'
import { editorCombo } from '../../editor/shortcuts'
import { prettyCombo } from '../../lib/hotkeys'

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function toolbarButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label)
  expect(button).toBeDefined()
  return button!
}

/** A row of whichever menu or submenu is currently open — a submenu is portalled, so it is not under the toolbar. */
function menuRow(label: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label)
  expect(row, `no menu row labelled ${label}`).not.toBeUndefined()
  return row!
}

describe('editor toolbar interactions', () => {
  it('shows the actual link binding on hover and omits invented shortcuts for unbound actions', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await act(() => root.render(createElement(EditorToolbar, { onPickImage: vi.fn() })))
    const link = toolbarButton(t('workspace.link'))
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28))
    await act(() => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(() => vi.advanceTimersByTime(500))
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain(t('workspace.link'))
    expect([...tooltip.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(prettyCombo(editorCombo('link')!))
    await act(() => link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    const highlight = toolbarButton(t('common.highlight'))
    vi.spyOn(highlight, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28))
    await act(() => highlight.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(t('common.highlight'))
    expect(document.querySelector('[role="tooltip"] kbd')).toBeNull()
  })
  it('keeps uploading one click away and inserts remote image syntax through the image menu', async () => {
    const pickImage = vi.fn()
    let state = EditorState.create({ doc: 'Alt text', selection: EditorSelection.range(0, 8) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: pickImage,
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    await act(() => toolbarButton(t('workspace.upload_image')).click())
    expect(pickImage).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await act(() => toolbarButton(t('workspace.insert_image')).click())
    const remote = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent === t('workspace.remote_image'))!
    await act(() => remote.click())
    expect(state.doc.toString()).toBe('![Alt text]()')
    expect(pickImage).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('formats the code block under the cursor from a toolbar button, not only from the insert menu', async () => {
    let state = EditorState.create({ doc: '```ts\nconst a=1\n```', selection: EditorSelection.cursor(8) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    const format = toolbarButton(t('command.format_code_block'))
    await act(() => format.click())
    expect(state.doc.toString()).toBe('```ts\nconst a = 1\n```')
  })

  it('offers each diagram family as a submenu of its own templates', async () => {
    let state = EditorState.create({ doc: '', selection: EditorSelection.cursor(0) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    await act(() => toolbarButton(t('workspace.code_and_diagrams')).click())
    const parents: Array<[string, number]> = [
      [t('workspace.mermaid_diagram'), 14],
      [t('workspace.chartjs_diagram'), 7],
      [t('workspace.mind_map'), 2],
      [t('workspace.kanban_board'), 2],
    ];
    for (const [label] of parents) {
      const row = menuRow(label)
      expect(row.getAttribute('aria-haspopup')).toBe('menu')
      expect(row.getAttribute('aria-expanded')).toBe('false')
    }
    for (const [label, leaves] of parents) {
      await act(() => menuRow(label).click())
      const panel = document.querySelector<HTMLElement>('[role="group"]')
      expect(panel, label).not.toBeNull()
      expect([...panel!.querySelectorAll('[role="menuitem"]')]).toHaveLength(leaves)
      expect(menuRow(label).getAttribute('aria-expanded')).toBe('true')
    }
    expect(state.doc.toString()).toBe('')
  })

  it('inserts the chosen chart template from the Chart.js submenu', async () => {
    let state = EditorState.create({ doc: '', selection: EditorSelection.cursor(0) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    await act(() => toolbarButton(t('workspace.code_and_diagrams')).click())
    await act(() => menuRow(t('workspace.chartjs_diagram')).click())
    await act(() => menuRow(t('workspace.chart_line')).click())
    expect(state.doc.toString()).toContain('```chart style=table\n| :line: | Jan | Feb | Mar | Apr |\n')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  // The two boards differ only in the body they start from, and which one a fence is stays the fence's
  // own business — so the pair is worth pinning: an outline board and a JSON board are different notes.
  it('inserts an outline board and a JSON board as two separate entries', async () => {
    let state = EditorState.create({ doc: '', selection: EditorSelection.cursor(0) })
    await act(() => root.render(createElement(EditorToolbar, {
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    await act(() => toolbarButton(t('workspace.code_and_diagrams')).click())
    await act(() => menuRow(t('workspace.kanban_board')).click())
    await act(() => menuRow(t('workspace.kanban_outline')).click())
    expect(state.doc.toString()).toBe('```kanban\n## To Do\n- [ ] Write the plan\n- [ ] Review the plan\n\n## Doing\n- [ ] Draft the columns\n\n## Done\n- [x] Pick the board format\n```\n')
    await act(() => toolbarButton(t('workspace.code_and_diagrams')).click())
    await act(() => menuRow(t('workspace.kanban_board')).click())
    await act(() => menuRow(t('workspace.kanban_json')).click())
    expect(state.doc.toString()).toContain('```kanban\n{\n  "title": "Kanban",')
  })

  it('lets keyboard users choose a block formula without losing their selected text', async () => {
    let state = EditorState.create({ doc: 'x^2', selection: EditorSelection.range(0, 3) })
    await act(() => root.render(createElement(EditorToolbar, {
      mobile: true,
      onPickImage: vi.fn(),
      runCommand: (command) => command({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state } } as never),
    })))
    const trigger = toolbarButton(t('workspace.math'))
    await act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
    expect(document.activeElement?.textContent).toBe(t('workspace.block_math'))
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })))
    expect(state.doc.toString()).toBe('$$\nx^2\n$$\n')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('x^2')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
