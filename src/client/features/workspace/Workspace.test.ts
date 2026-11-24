import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import { NoteLockSession, sealNote } from '@shared/crypto'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { lockAll, unlockNote, useNoteLocks } from '../../store/note-locks'
import { Workspace } from './Workspace'

/**
 * The props the workspace hands the editor, from the stand-in that takes the real one's place.
 *
 * The editor itself is a CodeMirror surface the workspace tests have no business mounting; what is worth
 * pinning from here is the one decision the workspace makes about it, so the stand-in keeps the props it
 * was given. `live` and `value` stay read through the DOM, as the cases above already do.
 */
const editorProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))
const previewProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))

vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: (props: { live: boolean; value: string }) => {
    editorProps.last = props as unknown as Record<string, unknown>
    return createElement('div', { 'data-editor-live': String(props.live) }, props.value)
  },
}))
vi.mock('../preview/Preview', () => ({
  Preview: (props: { content: string; noteTitle: string }) => {
    previewProps.last = props as unknown as Record<string, unknown>
    return createElement('div', { 'data-test-preview': true }, props.content)
  },
}))

let root: Root
let container: HTMLDivElement
let mobile = false
let restoreSession: () => void
const note: NoteSummary = {
  id: 'render-toggle-note', title: 'Example', excerpt: '', folderId: null, tags: [],
  isPinned: false, isStarred: false, isArchived: false, wordCount: 2, charCount: 12,
  rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: !mobile && query.startsWith('(min-width:'),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
  await initI18n()
  mobile = false
  const previous = useSession.getState()
  restoreSession = () => useSession.setState(previous)
  useSession.setState({
    settings: mergeSettings({}),
    updateSettings: async (patch) => {
      useSession.setState({ settings: mergeSettingsPatch(useSession.getState().settings, patch) })
    },
  })
  useNotes.setState({ notes: { [note.id]: note }, contents: { [note.id]: '# Source\n\n**Markdown**' }, folders: [], tags: [] })
  useUi.setState({ activeNoteId: note.id, mobilePane: 'editor', outlineOpen: false, backlinksOpen: false })
  editorProps.last = null
  previewProps.last = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  restoreSession()
  lockAll()
  vi.unstubAllGlobals()
})

function toggle() {
  const button = container.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(button.getAttribute('aria-label')).toBe(t('workspace.live_preview'))
  return button
}

describe('workspace live rendering toggle', () => {
  it.each([false, true])('switches inline rendering and remembers the choice after remounting (mobile: %s)', async (isMobile) => {
    mobile = isMobile
    await act(() => root.render(createElement(Workspace)))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[data-editor-live="true"]')).not.toBeNull()
    await act(() => toggle().click())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[data-editor-live="false"]')?.textContent).toContain('**Markdown**')
    expect(container.querySelector('[data-test-preview]')).toBeNull()
    await act(() => root.render(null))
    await act(() => root.render(createElement(Workspace)))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await act(() => toggle().click())
    expect(container.querySelector('[data-editor-live="true"]')).not.toBeNull()
  })

  it.each([false, true])('keeps split preview and resizer without a rendering toggle (live preview setting: %s)', async (livePreview) => {
    useSession.setState({ settings: mergeSettings({ editor: { livePreview }, preview: { layout: 'split' } }) })
    await act(() => root.render(createElement(Workspace)))
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelector('[data-test-preview]')).not.toBeNull()
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
    expect(container.querySelector('[data-editor-live="false"]')).not.toBeNull()
    expect(container.querySelector<HTMLElement>('[data-editor-live]')?.parentElement?.style.width).not.toBe('100%')
  })

  it('preserves the editing opt-out when switching to split and back', async () => {
    await act(() => root.render(createElement(Workspace)))
    await act(() => toggle().click())
    await act(() => useSession.getState().updateSettings({ preview: { layout: 'split' } }))
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelector('[data-test-preview]')).not.toBeNull()
    await act(() => useSession.getState().updateSettings({ preview: { layout: 'live' } }))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[data-editor-live="false"]')).not.toBeNull()
    expect(container.querySelector('[data-test-preview]')).toBeNull()
  })

  it.each([false, true])('allows explicit reading with rendering disabled (mobile: %s)', async (isMobile) => {
    mobile = isMobile
    useSession.setState({ settings: mergeSettings({ editor: { livePreview: false }, preview: { layout: 'preview' } }) })
    useUi.setState({ mobilePane: 'preview' })
    await act(() => root.render(createElement(Workspace)))
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelector('[data-test-preview]')).not.toBeNull()
  })
})

/**
 * Which of the two highlighting switches reaches the note editor.
 *
 * The reader sets one for the desktop and one for a phone, because painting every `<% %>` tag costs work
 * on a small screen they may not want paid; `editor/templater.test.ts` proves the editor obeys the switch
 * it is handed, and `settings/TemplaterSettings.test.ts` proves the rows store both. Only the workspace
 * decides which of the two the editor is handed, and a wrong reading there is invisible on the screen it
 * was set from — the marks just never appear, or always do, on the other one.
 */
describe('the templater highlighting switch the workspace hands down', () => {
  it.each([
    { phone: false, desktop: true, touch: false, expected: true },
    { phone: false, desktop: false, touch: true, expected: false },
    { phone: true, desktop: true, touch: false, expected: false },
    { phone: true, desktop: false, touch: true, expected: true },
  ])('paints according to the form factor it is on (phone: $phone, desktop: $desktop, touch: $touch)', async ({
    phone, desktop, touch, expected,
  }) => {
    mobile = phone
    useSession.setState({ settings: mergeSettings({ templater: { syntaxHighlighting: desktop, syntaxHighlightingMobile: touch } }) })
    await act(() => root.render(createElement(Workspace)))
    expect(editorProps.last?.templaterHighlight, 'the editor is handed one boolean, not the whole settings block').toBe(expected)
  })
})

async function sealActiveNote(): Promise<{ title: string; content: string }> {
  const sealed = await sealNote(await NoteLockSession.create('workspace password', { iterations: 100_000 }), note.id, {
    title: 'Decrypted title',
    content: 'Decrypted body',
  })
  useNotes.setState({
    notes: { [note.id]: { ...note, isEncrypted: true, title: sealed.title } },
    contents: { [note.id]: sealed.content },
  })
  return sealed
}

describe('encrypted note editing surface', () => {
  it('keeps a fully locked note in LockedNoteView', async () => {
    await sealActiveNote()
    await act(() => root.render(createElement(Workspace)))

    expect(container.textContent).toContain(t('notelock.locked_panel_title'))
    expect(editorProps.last).toBeNull()
    expect(previewProps.last).toBeNull()
  })

  it('finishes the encrypted save state when the saved envelope updates the note record', async () => {
    await sealActiveNote()
    await unlockNote(note.id, 'workspace password')
    useSession.setState({ settings: mergeSettings({ editor: { autoSaveDelay: 200 } }) })
    const patch = vi.spyOn(api.notes, 'patch').mockImplementation(async (_id, body) => ({
      ...note,
      isEncrypted: true,
      title: body.title!,
      content: body.content!,
      rev: 2,
      updatedAt: 2,
    }))
    const dropBodies = vi.spyOn(localDb, 'dropOmnisearchBodies').mockResolvedValue()
    const clearCache = vi.spyOn(localDb, 'clearOmnisearchCache').mockResolvedValue()
    try {
      await act(() => root.render(createElement(Workspace)))
      act(() => (editorProps.last!.onChange as (next: string) => void)('Autosaved encrypted body'))
      expect(useNoteLocks.getState().drafts[note.id]?.content).toBe('Autosaved encrypted body')
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 700)) })

      expect(patch).toHaveBeenCalledOnce()
      expect(patch).toHaveBeenCalledWith(note.id, expect.objectContaining({ isEncrypted: true, quiet: true }))
      expect(container.querySelector('[role="status"]')?.textContent).toBe(t('notelock.saved'))
      expect(useNoteLocks.getState().drafts[note.id]).toBeUndefined()
    } finally {
      patch.mockRestore()
      dropBodies.mockRestore()
      clearCache.mockRestore()
    }
  })

  it('renders editor and preview from the decrypted draft and stages edits outside notes.contents', async () => {
    const sealed = await sealActiveNote()
    await unlockNote(note.id, 'workspace password')
    useSession.setState({ settings: mergeSettings({ preview: { layout: 'split' } }) })
    await act(() => root.render(createElement(Workspace)))

    expect(editorProps.last?.value).toBe('Decrypted body')
    expect(editorProps.last?.noteTitle).toBe('Decrypted title')
    expect(previewProps.last?.content).toBe('Decrypted body')
    expect(previewProps.last?.noteTitle).toBe('Decrypted title')

    act(() => (editorProps.last!.onChange as (next: string) => void)('Edited decrypted body'))

    expect(useNoteLocks.getState().drafts[note.id]?.content).toBe('Edited decrypted body')
    expect(useNotes.getState().contents[note.id]).toBe(sealed.content)
    expect(useNotes.getState().notes[note.id]?.title).toBe(sealed.title)
    expect(container.querySelector('[data-editor-live]')?.textContent).toContain('Edited decrypted body')
    expect(container.querySelector('[data-test-preview]')?.textContent).toContain('Edited decrypted body')
  })
})
