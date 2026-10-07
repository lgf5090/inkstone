import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { PromptHost } from '../../components/overlay'
import { EditorToolbar } from './EditorToolbar'
import { editorCombo } from '../../editor/shortcuts'
import { prettyCombo } from '../../lib/hotkeys'
import { FORMAT_COLOR_STORAGE_KEY } from '../../lib/format-colors'

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

/** Mount the toolbar over a document whose whole body is selected. */
function mountWith(doc: string, selection: { anchor: number; head: number }) {
  let state = EditorState.create({ doc, selection: EditorSelection.range(selection.anchor, selection.head) })
  const view = {
    get state() { return state },
    dispatch: (update: { state: EditorState }) => { state = update.state },
    focus: vi.fn(),
  }
  return {
    state: () => state,
    props: { onPickImage: vi.fn(), runCommand: (command: (target: never) => boolean) => command(view as never) },
  }
}

function paletteButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label)
  expect(button, `no control labelled ${label}`).not.toBeUndefined()
  return button!
}

function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('text formatting controls', () => {
  beforeEach(() => {
    localStorage.removeItem(FORMAT_COLOR_STORAGE_KEY)
  })

  it('underlines the selection from its own button', async () => {
    const editor = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('common.underline')).click())
    expect(editor.state().doc.toString()).toBe('<u>water</u>')
  })

  it('paints the selection with the colour picked from the palette and closes the panel', async () => {
    const editor = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    const trigger = toolbarButton(t('workspace.text_color'))
    await act(() => trigger.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(() => paletteButton(t('color.rose')).click())
    expect(editor.state().doc.toString()).toBe('<font color="#e11d48">water</font>')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps the highlight button on == and puts the wash behind its chevron', async () => {
    const plain = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, plain.props)))
    await act(() => toolbarButton(t('common.highlight')).click())
    expect(plain.state().doc.toString()).toBe('==water==')
  })

  it('paints a translucent wash so the theme text stays readable on it', async () => {
    const editor = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('workspace.highlight_color')).click())
    await act(() => paletteButton('#FACC15').click())
    expect(editor.state().doc.toString()).toBe('<mark style="background:#facc1559">water</mark>')
  })

  it('remembers the colour just picked and offers it again on the button', async () => {
    const editor = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('workspace.text_color')).click())
    await act(() => paletteButton(t('color.teal')).click())
    expect(editor.state().doc.toString()).toBe('<font color="#0d9488">water</font>')
    await act(() => toolbarButton(t('workspace.text_color')).click())
    expect(paletteButton(t('color.teal')).getAttribute('aria-pressed')).toBe('true')
    const stored = JSON.parse(localStorage.getItem(FORMAT_COLOR_STORAGE_KEY) ?? '{}') as { text?: string[] }
    expect(stored.text?.[0]).toBe('#0d9488')
  })

  it('carries the tag formats and the case list in the more-formats menu', async () => {
    const editor = mountWith('hello world', { anchor: 0, head: 11 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('workspace.more_formats')).click())
    await act(() => menuRow(t('workspace.superscript')).click())
    expect(editor.state().doc.toString()).toBe('<sup>hello world</sup>')

    await act(() => toolbarButton(t('workspace.more_formats')).click())
    await act(() => menuRow(t('workspace.case_change')).click())
    await act(() => menuRow(t('workspace.case_upper')).click())
    expect(editor.state().doc.toString()).toBe('<sup>HELLO WORLD</sup>')
  })

  it('lets the swatch a user aimed at win over a half-typed value', async () => {
    const editor = mountWith('water', { anchor: 0, head: 5 })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('workspace.text_color')).click())
    const field = document.querySelector<HTMLInputElement>('[role="menu"] input[type="text"]')!
    await act(() => { field.focus(); typeInto(field, '#123456') })
    await act(() => { paletteButton(t('color.red')).click() })
    expect(editor.state().doc.toString()).toBe('<font color="#dc2626">water</font>')
  })

  it('keeps the spacing a numbering template asked for', async () => {
    const editor = mountWith('one\ntwo\n', { anchor: 0, head: 8 })
    await act(() => root.render(createElement(Fragment, null,
      createElement(PromptHost),
      createElement(EditorToolbar, editor.props))))
    await act(() => toolbarButton(t('workspace.more_formats')).click())
    await act(() => menuRow(t('workspace.line_tidy')).click())
    await act(() => menuRow(t('workspace.number_lines')).click())
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(field, 'the numbering command never asked for a template').not.toBeNull()
    expect(field.value).toBe('{n}. ')
    await act(() => {
      typeInto(field, '{n}) ')
    })
    await act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find(button => button.textContent?.trim() === t('overlay.confirm'))!
        .click()
    })
    expect(editor.state().doc.toString()).toBe('1) one\n2) two\n')
  })

  it('clears the decoration the menu wrote, and tidies the lines it is pointed at', async () => {
    const doc = '<sup>hello</sup> and **bold**'
    const editor = mountWith(doc, { anchor: 0, head: doc.length })
    await act(() => root.render(createElement(EditorToolbar, editor.props)))
    await act(() => toolbarButton(t('workspace.more_formats')).click())
    await act(() => menuRow(t('workspace.clear_formatting')).click())
    expect(editor.state().doc.toString()).toBe('hello and bold')

    const second = mountWith('a  \nb  \n', { anchor: 0, head: 4 })
    await act(() => root.render(createElement(EditorToolbar, second.props)))
    await act(() => toolbarButton(t('workspace.more_formats')).click())
    await act(() => menuRow(t('workspace.line_tidy')).click())
    await act(() => menuRow(t('workspace.trim_line_ends')).click())
    expect(second.state().doc.toString()).toBe('a\nb  \n')
  })
})
