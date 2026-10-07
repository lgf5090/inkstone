import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { preloadPinyin } from '../../lib/pinyin'
import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { LinkEditorPopover } from './LinkEditorPopover'
import { openLinkEditor, useLinkEditor } from './store'
import { findLinkAt } from './link-syntax'
import type { LinkEditorRequest } from './store'

let container: HTMLDivElement
let root: Root
let view: EditorView
let toast: ReturnType<typeof vi.spyOn>

const NOTE_ID = 'note-1'

function mount(doc: string, notes: Record<string, unknown> = {}, contents: Record<string, string> = {}): void {
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, addKeymap: false })] }),
    parent: host,
  })
  useNotes.setState({ notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Current', updatedAt: 10, deletedAt: null }, ...notes } as never, contents: { [NOTE_ID]: doc, ...contents } as never })
  container = host
  root = createRoot(document.createElement('div'))
}

function request(over: Partial<LinkEditorRequest> & { pos?: number } = {}): LinkEditorRequest {
  const doc = view.state.doc.toString()
  const pos = over.pos ?? doc.indexOf('[[') + 3
  const line = view.state.doc.lineAt(pos)
  const found = findLinkAt(line.text, pos - line.from)!
  const base: LinkEditorRequest = {
    anchor: new DOMRect(20, 40, 80, 18),
    noteId: NOTE_ID,
    match: found,
    from: line.from + found.start,
    to: line.from + found.end,
    view,
  }
  const { pos: _pos, ...rest } = over as Partial<LinkEditorRequest> & { pos?: number }
  return { ...base, ...rest }
}

function show(over: Partial<LinkEditorRequest> = {}): void {
  act(() => openLinkEditor(request(over)))
  act(() => root.render(createElement(LinkEditorPopover)))
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label]')!
}

function field(label: string): HTMLInputElement {
  return panel().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
}

function press(target: HTMLElement, init: Partial<KeyboardEvent>): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...init }))
  })
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function clickOutside(): void {
  act(() => {
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  return [...panel().querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === label)!
}

function doc(): string {
  return view.state.doc.toString()
}

beforeAll(async () => {
  await initI18n()
  await preloadPinyin()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  toast = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => 'id')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  view.destroy()
  useLinkEditor.getState().close()
  useSession.setState({ settings: DEFAULT_SETTINGS })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the link editor panel', () => {
  it('opens with the link as written, and names what kind it is', () => {
    mount('Read [[folder/Deep Notes|the write-up]] now')
    show()
    expect(field(t('links.placeholder_text')).value).toBe('the write-up')
    expect(field(t('links.placeholder_target')).value).toBe('folder/Deep Notes')
    expect(panel().textContent).toContain(t('links.kind_wiki'))
  })

  it('rewrites the note when Enter commits a new target', () => {
    mount('Read [[Deep Notes]] now')
    show()
    type(field(t('links.placeholder_target')), 'Other Note')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('Read [[Other Note|Deep Notes]] now')
    expect(useLinkEditor.getState().request).toBeNull()
  })

  it('drops the alias once it merely repeats the new name', () => {
    mount('Read [[Deep Notes|the note]] now')
    show()
    type(field(t('links.placeholder_target')), 'the note')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('Read [[the note]] now')
  })

  it('leaves the note alone when Escape discards the edit', () => {
    mount('Read [[Deep Notes]] now')
    show()
    type(field(t('links.placeholder_text')), 'half typed')
    press(panel(), { key: 'Escape' })
    expect(doc()).toBe('Read [[Deep Notes]] now')
    expect(useLinkEditor.getState().request).toBeNull()
  })

  it('saves what was typed when the reader clicks away', () => {
    mount('Read [[Deep Notes]] now')
    show()
    type(field(t('links.placeholder_text')), 'kept')
    clickOutside()
    expect(doc()).toBe('Read [[Deep Notes|kept]] now')
  })

  it('offers notes and headings as the target is typed, and fills both fields on a pick', () => {
    mount('See [[#]] for details', { other: { id: 'other', title: 'Deep Notes', updatedAt: 5, deletedAt: null } })
    show({ match: { kind: 'wiki', embed: false, image: false, raw: '[[#]]', start: 4, end: 7, text: '', target: '#', hasText: false } })
    const rows = () => [...panel().querySelectorAll<HTMLElement>('[role="option"]')]
    type(field(t('links.placeholder_target')), 'deep')
    expect(rows().map((row) => row.textContent)).toContain('Deep Notes')
    act(() => rows()[0]!.querySelector('button')!.click())
    expect(field(t('links.placeholder_target')).value).toBe('Deep Notes')
    expect(field(t('links.placeholder_text')).value).toBe('Deep Notes')
  })

  it('moves the highlighted suggestion with the arrow keys and commits it with Enter', () => {
    mount('See [[#]] for details', {
      a: { id: 'a', title: 'Alpha', updatedAt: 5, deletedAt: null },
      b: { id: 'b', title: 'Beta Note', updatedAt: 4, deletedAt: null },
    })
    show({ match: { kind: 'wiki', embed: false, image: false, raw: '[[#]]', start: 4, end: 7, text: '', target: '', hasText: false } })
    const target = field(t('links.placeholder_target'))
    type(target, 'a')
    expect([...panel().querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.textContent)).toEqual(['Alpha', 'Beta Note'])
    press(panel(), { key: 'ArrowDown' })
    expect(panel().querySelector('[role="option"]')!.getAttribute('aria-selected')).toBe('true')
    press(panel(), { key: 'ArrowDown' })
    expect(panel().querySelectorAll('[role="option"]')[1]!.getAttribute('aria-selected')).toBe('true')
    press(panel(), { key: 'ArrowUp' })
    press(target, { key: 'Enter' })
    expect(field(t('links.placeholder_target')).value).toBe('Alpha')
    expect(field(t('links.placeholder_text')).value).toBe('Alpha')
    expect(doc()).toBe('See [[#]] for details')
  })

  it('deletes the link and keeps its words', () => {
    mount('Read [[Deep Notes|the note]] now')
    show()
    act(() => button(t('links.action_delete')).click())
    expect(doc()).toBe('Read the note now')
  })

  it('deletes the words too when the setting says so', () => {
    mount('Read [[Deep Notes|the note]] now')
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, linkEditorKeepsText: false } } })
    show()
    act(() => button(t('links.action_delete')).click())
    expect(doc()).toBe('Read  now')
  })

  it('switches a link to an embed and back without closing', () => {
    mount('Read [[Deep Notes]] now')
    show()
    act(() => button(t('links.action_embed')).click())
    expect(doc()).toBe('Read ![[Deep Notes]] now')
    expect(useLinkEditor.getState().request).not.toBeNull()
    act(() => button(t('links.action_embed')).click())
    expect(doc()).toBe('Read [[Deep Notes]] now')
  })

  it('warns and offers to create the note when the target is not there', () => {
    mount('Read [[Nowhere]] now')
    show()
    expect(panel().textContent).toContain(t('links.create_note'))
    expect(field(t('links.placeholder_target')).getAttribute('aria-invalid')).toBe('true')
  })

  it('stays quiet about a target that names a real note', () => {
    mount('Read [[Deep Notes]] now', { d: { id: 'd', title: 'Deep Notes', updatedAt: 1, deletedAt: null } })
    show()
    expect(panel().textContent).not.toContain(t('links.create_note'))
    expect(field(t('links.placeholder_target')).getAttribute('aria-invalid')).toBeNull()
  })

  it('refuses to write when the note moved underneath the panel', () => {
    mount('Read [[Deep Notes]] now')
    show()
    act(() => view.dispatch({ changes: { from: 0, to: 0, insert: 'x ' } }))
    type(field(t('links.placeholder_target')), 'Other')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('x Read [[Deep Notes]] now')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('links.moved') }))
  })

  it('copies the two link shapes separately', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount('Read [[Deep Notes]] now')
    show()
    act(() => button(t('links.action_copy_wiki')).click())
    expect(writeText).toHaveBeenLastCalledWith('[[Deep Notes]]')
    act(() => button(t('links.action_copy_markdown')).click())
    expect(writeText).toHaveBeenLastCalledWith('[Deep Notes](<Deep Notes>)')
    act(() => button(t('links.action_copy_target')).click())
    expect(writeText).toHaveBeenLastCalledWith('Deep Notes')
  })

  it('opens the note a link points at and closes', () => {
    const openNote = vi.fn()
    mount('Read [[Deep Notes]] now', { d: { id: 'd', title: 'Deep Notes', updatedAt: 1, deletedAt: null } })
    useNotes.setState({ openNote })
    show()
    act(() => button(t('links.action_open')).click())
    expect(openNote).toHaveBeenCalledWith('d')
    expect(useLinkEditor.getState().request).toBeNull()
  })

  it('creates the note a missing target names', () => {
    const createNote = vi.fn()
    mount('Read [[Nowhere]] now')
    useNotes.setState({ createNote })
    show()
    act(() => button(t('links.action_open')).click())
    expect(createNote).toHaveBeenCalledWith({ title: 'Nowhere', open: true })
  })

  it('never hands the browser a script url', () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    mount('Read [[javascript:alert(1)]] now')
    show()
    act(() => button(t('links.action_open')).click())
    expect(opened).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('links.unsafe_target') }))
  })

  it('pads a link written at the cursor so it does not touch the word beside it', () => {
    mount('Read now')
    act(() => view.dispatch({ selection: { anchor: 4 } }))
    act(() => openLinkEditor({
      anchor: new DOMRect(20, 40, 1, 18),
      noteId: NOTE_ID,
      match: { kind: 'url', embed: false, image: false, raw: '', start: 4, end: 4, text: '', target: '', hasText: false },
      from: 4,
      to: 4,
      view,
      creating: true,
    }))
    act(() => root.render(createElement(LinkEditorPopover)))
    type(field(t('links.placeholder_target')), 'Deep Notes')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('Read [[Deep Notes]] now')
  })

  it('leaves a selected phrase alone when the new link is abandoned', () => {
    mount('Read the note now')
    act(() => view.dispatch({ selection: { anchor: 5, head: 13 } }))
    act(() => openLinkEditor({
      anchor: new DOMRect(20, 40, 1, 18),
      noteId: NOTE_ID,
      match: { kind: 'markdown', embed: false, image: false, raw: 'the note', start: 5, end: 13, text: 'the note', target: '', hasText: true },
      from: 5,
      to: 13,
      view,
      creating: true,
      replaces: 'the note',
    }))
    act(() => root.render(createElement(LinkEditorPopover)))
    expect(field(t('links.placeholder_text')).value).toBe('the note')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('Read the note now')
    expect(useLinkEditor.getState().request).toBeNull()
  })

  it('wraps a selected phrase when the new link gets a target', () => {
    mount('Read the note now')
    act(() => openLinkEditor({
      anchor: new DOMRect(20, 40, 1, 18),
      noteId: NOTE_ID,
      match: { kind: 'markdown', embed: false, image: false, raw: 'the note', start: 5, end: 13, text: 'the note', target: '', hasText: true },
      from: 5,
      to: 13,
      view,
      creating: true,
      replaces: 'the note',
    }))
    act(() => root.render(createElement(LinkEditorPopover)))
    type(field(t('links.placeholder_target')), 'Deep Notes')
    press(field(t('links.placeholder_target')), { key: 'Enter' })
    expect(doc()).toBe('Read [[Deep Notes|the note]] now')
  })
})
