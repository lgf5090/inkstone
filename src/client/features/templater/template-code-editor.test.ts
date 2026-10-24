import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'
import { undoDepth } from '@codemirror/commands'
import type { NoteTemplate } from '@shared/types'
import { IS_MAC } from '../../lib/hotkeys'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNoteTemplates } from '../../store/note-templates'
import { describeTemplateBody } from './template-body-check'
import { TemplateCodeEditor } from './template-code-editor'
import { TemplateEditorModal } from '../templates/gallery-modals'

vi.mock('../../lib/api', () => ({
  CLIENT_ID: 'this-tab',
  api: {
    templateLibrary: {
      load: async () => ({ savedAt: 0, library: null }),
      save: async () => ({ savedAt: 1 }),
    },
  },
}))

vi.mock('../../lib/db', () => ({
  localDb: {
    loadTemplateLibrary: async () => null,
    saveTemplateLibrary: async () => {},
  },
  publishBroadcast: () => {},
  createBroadcast: () => ({ post: () => {}, close: () => {} }),
}))

const TAGGED = 'Title: <% tp.file.title %>'
const TEMPLATE: NoteTemplate = {
  id: 'tpl-1', categoryId: null, name: 'Weekly', description: '', content: '# Body',
  tags: [], builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
}

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  installTestGlobals()
})

beforeEach(async () => {
  localStorage.clear()
  // jsdom needs the flag before `act`, or React only warns and nothing is flushed.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useNoteTemplates.setState({ templates: [], categories: [] })
})

/** The editor's editable element: the one a reader, and a screen reader, lands on. */
function contentBox(): HTMLElement {
  const box = document.querySelector<HTMLElement>('.cm-content')
  expect(box, 'the surface should mount a CodeMirror editor').toBeTruthy()
  return box as HTMLElement
}

function editor(): EditorView {
  const view = EditorView.findFromDOM(contentBox())
  expect(view, 'the mounted editor should be reachable from its own DOM').toBeTruthy()
  return view as EditorView
}

/** A keystroke at the element the reader is typing in, going through the real DOM. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  contentBox().dispatchEvent(event)
  return event
}

/** An edit the editor itself makes: what a keystroke leaves behind once the browser is done with it. */
function insert(at: number, text: string) {
  act(() => {
    editor().dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' })
  })
}

/** The dialog's own control: it holds the text and records every change it is handed. */
function Controlled({ initial, seen }: { initial: string, seen: string[] }) {
  const [value, setValue] = useState(initial)
  return createElement(TemplateCodeEditor, {
    value,
    onChange: (next: string) => {
      seen.push(next)
      setValue(next)
    },
  })
}

async function render(node: Parameters<Root['render']>[0]) {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
}

async function openDialog(props: {
  template?: NoteTemplate | null
  initial?: { name: string, description: string, content: string, categoryId: string | null, tags: string[] } | null
  onClose?: () => void
} = {}) {
  await render(createElement(TemplateEditorModal, {
    template: props.template ?? null,
    initial: props.initial ?? null,
    categories: [],
    onClose: props.onClose ?? (() => {}),
  }))
}

function dialogButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  expect(found, `the dialog should hold a ${label} button`).toBeDefined()
  return found as HTMLButtonElement
}

describe('the template body editor keeps the contract the textarea had', () => {
  it('hands the dialog every change, and keeps it', async () => {
    const seen: string[] = []
    await render(createElement(Controlled, { initial: TAGGED, seen }))
    const view = editor()
    expect(view.state.doc.toString()).toBe(TAGGED)
    insert(view.state.doc.length, '\n<%+ tp.date.now() %>')
    expect(seen).toEqual([`${TAGGED}\n<%+ tp.date.now() %>`])
    // The text the dialog now holds is the text on screen: a controlled surface that handed back a value
    // and then replaced it would put the caret somewhere the reader left it.
    expect(editor().state.doc.toString()).toBe(`${TAGGED}\n<%+ tp.date.now() %>`)
  })

  it('follows a value set from outside without claiming it was typed', async () => {
    const seen: string[] = []
    await render(createElement(TemplateCodeEditor, { value: 'first', onChange: (value: string) => seen.push(value) }))
    insert(5, ' typed')
    expect(seen).toEqual(['first typed'])
    // A dialog that keeps its own text owns it: the editor goes back to what was handed in.
    await render(createElement(TemplateCodeEditor, { value: 'from the dialog', onChange: (value: string) => seen.push(value) }))
    expect(editor().state.doc.toString()).toBe('from the dialog')
    expect(seen).toEqual(['first typed'])
  })

  it('paints the tags the note editor paints, in the DOM the reader looks at', async () => {
    await render(createElement(Controlled, { initial: TAGGED, seen: [] }))
    expect(Array.from(contentBox().querySelectorAll('.cm-templater-delimiter')).map((node) => node.textContent))
      .toEqual(['<%', '%>'])
    expect(Array.from(contentBox().querySelectorAll('.cm-templater-body')).map((node) => node.textContent))
      .toEqual([' tp.file.title '])
    // The gutter is the editor's own layer beside the text, not a child of it, so it is read off the host.
    // It is `aria-hidden`, because a screen reader counts lines itself: what is asserted here is that the
    // number the reader navigates a parse error by is really painted.
    const gutter = document.querySelector('.cm-lineNumbers')
    expect(Array.from(gutter?.querySelectorAll('.cm-gutterElement') ?? []).map((node) => node.textContent))
      .toContain('1')
  })

  it('gives back what was typed, which is what the textarea gave for free', async () => {
    await render(createElement(Controlled, { initial: '', seen: [] }))
    const view = editor()
    insert(0, '# Heading\nbody\n')
    expect(undoDepth(view.state)).toBeGreaterThan(0)
    act(() => {
      press({ key: 'z', code: 'KeyZ', ...(IS_MAC ? { metaKey: true } : { ctrlKey: true }) })
    })
    expect(editor().state.doc.toString()).toBe('')
  })

  it('carries the name, the description and the rejection onto the editable element', async () => {
    const describedBy = 'body-hint-id'
    await render(createElement(TemplateCodeEditor, {
      value: TAGGED,
      onChange: () => {},
      id: 'body-editor-id',
      'aria-label': 'Template content',
      'aria-describedby': describedBy,
      invalid: true,
    }))
    expect(contentBox().getAttribute('aria-label')).toBe('Template content')
    expect(contentBox().getAttribute('aria-describedby')).toBe(describedBy)
    expect(contentBox().getAttribute('aria-invalid')).toBe('true')
    expect(contentBox().getAttribute('id')).toBe('body-editor-id')
    // A name is one thing an editor can be silent about and a reader cannot hear.
    expect(contentBox().getAttribute('role')).toBe('textbox')
  })
})

describe('what the body check says about a template', () => {
  it('lists the commands the engine read, as the reader wrote them', () => {
    const report = describeTemplateBody(`# ${'Plan'}\nTitle: <% tp.file.title %>\n<%* tR += 1 -%>\n<%+ tp.date.now() %>\n`)
    expect(report.parsed).toBe(true)
    expect(report.failure).toBeNull()
    expect(report.commands).toEqual([
      { line: 2, text: '<% tp.file.title %>' },
      { line: 3, text: '<%* tR += 1 -%>' },
      { line: 4, text: '<%+ tp.date.now() %>' },
    ])
    expect(report.total).toBe(3)
  })

  it('says where it stopped reading, in the numbers the reader navigates by', () => {
    const report = describeTemplateBody('one\ntwo\nthree <%* const unclosed = 1')
    expect(report.parsed).toBe(false)
    expect(report.failure?.code).toBe('parse-unclosed')
    expect([report.failure?.line, report.failure?.column]).toEqual([3, 7])
  })

  it('counts a body it refuses to catalogue whole', () => {
    const report = describeTemplateBody(Array.from({ length: 45 }, (_unused, index) => `<% a${index} %>`).join('\n'))
    expect(report.total).toBe(45)
    expect(report.commands).toHaveLength(40)
  })
})

describe('the template dialog with the editor in it', () => {
  it('leaves the opening focus where the dialog put it, not in the editor', async () => {
    await openDialog({ template: TEMPLATE })
    expect(document.activeElement).toBe(document.querySelector('input[maxlength]'))
  })

  it('closes on Escape from inside the editor', async () => {
    const closed = vi.fn()
    await openDialog({ template: TEMPLATE, onClose: closed })
    act(() => {
      editor().focus()
      press({ key: 'Escape' })
    })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an input method that is still building a word', async () => {
    const closed = vi.fn()
    await openDialog({ template: TEMPLATE, onClose: closed })
    act(() => {
      editor().focus()
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(event, 'isComposing', { value: true })
      contentBox().dispatchEvent(event)
    })
    expect(closed, 'an Escape that cancels a composition must not close the dialog with the draft in it')
      .not.toHaveBeenCalled()
  })

  it('lets Tab leave the editor when no suggestion is offered', async () => {
    await openDialog({ template: TEMPLATE })
    act(() => { editor().focus() })
    let event!: KeyboardEvent
    act(() => {
      event = press({ key: 'Tab', code: 'Tab' })
    })
    // Two halves of the same promise: the keystroke stays the browser's (nothing bound Tab), and the
    // editor is one of the elements the dialog walks through, not the last of them.
    expect(event.defaultPrevented, 'a bound Tab would swallow the keystroke that leaves the editor')
      .toBe(false)
    const focusable = [...document.querySelectorAll<HTMLElement>([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"]):not([disabled])',
    ].join(','))]
    expect(focusable.indexOf(contentBox()), 'the trap has to know the editor is a stop on the way out')
      .toBeGreaterThan(-1)
    expect(focusable.indexOf(contentBox())).toBeLessThan(focusable.length - 1)
  })

  it('offers the registry inside a tag and lets Escape put that away first', async () => {
    const closed = vi.fn()
    await openDialog({
      template: { ...TEMPLATE, content: 'Title: <% tp.' },
      onClose: closed,
    })
    act(() => {
      const view = editor()
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
    })
    // `Ctrl-Space` asks for a list at the caret, which is the request that does not depend on the reader
    // having typed a trigger character — and the caret is inside the `<% tp.` the template was saved with.
    act(() => {
      press({ key: ' ', code: 'Space', ctrlKey: true })
    })
    // A completion source is asked, then its answer is put into the state on a later frame; waiting once
    // only ever catches the request itself.
    await act(async () => {
      for (let attempt = 0; attempt < 20 && completionStatus(editor().state) !== 'active'; attempt++) {
        await new Promise((resolve) => { setTimeout(resolve, 0) })
      }
    })
    expect(completionStatus(editor().state)).toBe('active')
    expect(contentBox().hasAttribute('data-owns-escape'), 'a list on screen owns the next Escape').toBe(true)
    act(() => {
      press({ key: 'Escape' })
    })
    expect(closed, 'Escape hid the list; it must not also have thrown the draft away').not.toHaveBeenCalled()
    expect(completionStatus(editor().state)).toBeNull()
    act(() => {
      press({ key: 'Escape' })
    })
    expect(closed, 'with nothing left to hide, Escape is the dialog\'s again').toHaveBeenCalledTimes(1)
  })

  it('blames the body on the editor, not on a textarea that is no longer there', async () => {
    let closed = 0
    await openDialog({
      initial: { name: 'Weekly review', description: '', content: '', categoryId: null, tags: [] },
      onClose: () => { closed += 1 },
    })
    await act(async () => {
      dialogButton(t('templates.create_template')).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('.cm-content')?.getAttribute('aria-invalid')).toBe('true')
    expect([...document.querySelectorAll('p')].map((node) => node.textContent?.trim()))
      .toContain(t('templates.content_required'))
    expect(closed, 'a rejected draft must not be saved').toBe(0)
  })

  it('saves what was typed into the editor', async () => {
    useNoteTemplates.setState({ templates: [TEMPLATE] })
    await openDialog({ template: TEMPLATE })
    const view = editor()
    insert(view.state.doc.length, '\n<% tp.date.now() %>')
    await act(async () => {
      dialogButton(t('common.save')).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const saved = useNoteTemplates.getState().templates.find((item) => item.id === TEMPLATE.id)
    expect(saved?.content).toBe(`# Body\n<% tp.date.now() %>`)
  })

  it('reports the parse position where the check is asked for it', async () => {
    await openDialog({ template: { ...TEMPLATE, content: 'one\ntwo\nthree <%* const unclosed = 1' } })
    await act(async () => {
      dialogButton(t('templater.editor.check_label')).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const panel = document.querySelector('[role="status"]')
    expect(panel?.textContent).toContain(t('templater.error.parse_unclosed'))
    expect(panel?.textContent).toContain('3:7')
    expect(document.querySelector('.cm-templater-body'), 'a tag that never closed is painted no further')
      .toBeNull()
  })

  it('retires a report the moment the text it described changes', async () => {
    await openDialog({ template: { ...TEMPLATE, content: TAGGED } })
    await act(async () => {
      dialogButton(t('templater.editor.check_label')).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('<% tp.file.title %>')
    insert(editor().state.doc.length, ' more')
    expect(document.querySelector('[role="status"]'), 'an answer about words that have since changed is not an answer')
      .toBeNull()
  })
})
