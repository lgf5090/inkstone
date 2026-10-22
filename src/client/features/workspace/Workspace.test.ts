import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { NoteSummary } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Workspace } from './Workspace'

/**
 * The props the workspace hands the editor, from the stand-in that takes the real one's place.
 *
 * The editor itself is a CodeMirror surface the workspace tests have no business mounting; what is worth
 * pinning from here is the one decision the workspace makes about it, so the stand-in keeps the props it
 * was given. `live` and `value` stay read through the DOM, as the cases above already do.
 */
const editorProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))

vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: (props: { live: boolean; value: string }) => {
    editorProps.last = props as unknown as Record<string, unknown>
    return createElement('div', { 'data-editor-live': String(props.live) }, props.value)
  },
}))
vi.mock('../preview/Preview', () => ({
  Preview: () => createElement('div', { 'data-test-preview': true }),
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  restoreSession()
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
