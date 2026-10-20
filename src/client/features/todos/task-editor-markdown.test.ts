// @vitest-environment jsdom
/**
 * The notes field's preview face: Markdown the reader typed, drawn through the note pipeline.
 *
 * The preview hands a string to `dangerouslySetInnerHTML`, and the only reason that is acceptable is
 * that the string comes back from `renderMarkdown`, which sanitizes before it returns. So the cases
 * below are not only about a heading appearing: a hostile note is typed in and the output is read
 * back for the handlers the sanitizer exists to remove. The toggle is a `Segmented` radiogroup, so
 * the state a screen reader hears is asserted on `aria-checked` rather than on a CSS class.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'

// The export helpers pull KaTeX's stylesheet in with `?inline`, which Vite refuses to read through
// this checkout's symlinked `node_modules`; nothing under test exports a note, so the module is a stub.
vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))
// This checkout's `node_modules` is a junction outside the Vite root, so any real module that inlines
// the KaTeX stylesheet is refused before a test can run. No export under test prints a note, and the
// markdown preview only needs the text pipeline, so the stylesheet is stubbed.
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

import { useTodos } from './store'
import { TaskEditor } from './TaskEditor'

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState(original, true)
  useTodos.setState({ editorOpen: true, draft: {}, lists: [], tags: [], tasks: [], completed: [], timezone: 'UTC', saving: false })
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

function notesTextarea(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('todo.task.notes_label')}"]`)
  if (!field) throw new Error('the editor offers no notes field')
  return field
}

function typeNotes(value: string): void {
  const field = notesTextarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function modeGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${t('todo.task.notes_view')}"]`)
  if (!group) throw new Error('the notes field offers no edit/preview switch')
  return group
}

function modeRadio(name: string): HTMLButtonElement {
  const radio = [...modeGroup().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((button) => (button.textContent ?? '').trim() === name)
  if (!radio) throw new Error(`the notes switch has no ${name} option`)
  return radio
}

function switchTo(name: string): void {
  act(() => { modeRadio(name).click() })
}

function previewRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(`[role="region"][aria-label="${t('todo.task.notes_preview')}"]`)
  if (!region) throw new Error('the preview state mounted no region')
  return region
}

function renderEditor(): void {
  view = renderElement(createElement(TaskEditor))
}

describe('the notes field preview', () => {
  it('draws the Markdown the reader typed, rather than the source', () => {
    renderEditor()
    typeNotes('## Plan\n\nShip **this week**')
    switchTo(t('common.preview'))

    const region = previewRegion()
    expect(region.querySelector('h2')?.textContent?.trim()).toBe('Plan')
    expect(region.querySelector('strong')?.textContent).toBe('this week')
    // The source markers are gone: a preview that still shows `**` is the edit face with a new class.
    expect(region.textContent).not.toContain('**')
  })

  it('sanitizes a hostile note before it reaches the region', () => {
    renderEditor()
    typeNotes('Still **readable**\n\n<img src=x onerror="window.__taskNotesPwned=1">')
    switchTo(t('common.preview'))

    const region = previewRegion()
    // The sanitizer may keep a bare image, but never the handler the note put on it: that attribute
    // is the difference between a broken picture and script execution.
    expect(region.querySelector('img')?.hasAttribute('onerror') ?? false, 'an onerror handler reached the region').toBe(false)
    expect(region.innerHTML).not.toContain('onerror')
    expect(region.querySelector('script')).toBeNull()
    const handlers = [...region.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].filter((attribute) => attribute.name.startsWith('on')).map((attribute) => attribute.name),
    )
    expect(handlers, 'an inline event handler survived the sanitizer').toEqual([])
    expect((window as unknown as { __taskNotesPwned?: number }).__taskNotesPwned).toBeUndefined()
    // The prose still renders: a region that dropped everything would pass every assertion above.
    expect(region.querySelector('strong')?.textContent).toBe('readable')
  })

  it('shows an empty state, not a blank block, when the note is empty', () => {
    renderEditor()
    switchTo(t('common.preview'))

    const region = previewRegion()
    expect(region.textContent?.trim()).toBe(t('todo.task.notes_preview_empty'))
    expect(region.querySelector('p')).toBeNull()
  })

  it('announces which face is active, and the preview is not editable', () => {
    renderEditor()
    expect(modeRadio(t('todo.action.edit')).getAttribute('aria-checked')).toBe('true')
    expect(modeRadio(t('common.preview')).getAttribute('aria-checked')).toBe('false')
    expect(previewRegionSafe()).toBeNull()
    expect(notesTextarea()).toBeTruthy()

    typeNotes('A note')
    switchTo(t('common.preview'))

    expect(modeRadio(t('todo.action.edit')).getAttribute('aria-checked')).toBe('false')
    expect(modeRadio(t('common.preview')).getAttribute('aria-checked')).toBe('true')
    const region = previewRegion()
    expect(region.getAttribute('aria-label')).toBe(t('todo.task.notes_preview'))
    // jsdom has no `isContentEditable`, so "not editable" is read from the absence of every editable
    // surface the region could carry.
    expect(region.getAttribute('contenteditable')).toBeNull()
    expect(region.querySelector('textarea, input, [contenteditable]')).toBeNull()
    expect(document.querySelector(`textarea[aria-label="${t('todo.task.notes_label')}"]`)).toBeNull()

    switchTo(t('todo.action.edit'))
    expect(modeRadio(t('todo.action.edit')).getAttribute('aria-checked')).toBe('true')
    expect(notesTextarea().value).toBe('A note')
  })
})

function previewRegionSafe(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="region"][aria-label="${t('todo.task.notes_preview')}"]`)
}
