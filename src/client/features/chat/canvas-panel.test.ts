// @vitest-environment jsdom
/**
 * The side panel: the drafts a conversation keeps.
 *
 * What is pinned here is the shape of the contract rather than the editor inside it. The panel is the
 * drive — an empty conversation says so, a draft can be picked out of the list, and a rename is committed
 * once the typing settles rather than once per keystroke — and the menu is the door: a reply offers the
 * canvas only where there is a row to hang a draft on, which is why the live turn and the reader's own
 * messages do not.
 *
 * The real editor is CodeMirror and is not what this file is about; a textarea stands in for it so the
 * panel's own wiring is what is exercised.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBOUNCE } from '@shared/constants'
import type { AssistantArtifactVersion } from '@shared/assistant'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { CanvasPanel } from './CanvasPanel'
import { messageMenuItems } from './MessageMenu'
import { useAssistant } from './assistant-store'

/**
 * A body the stand-in renderer refuses.
 *
 * `MarkdownBody` is the notebook's own render path — sanitizer, enhancer, the lot — and the panel has no
 * way to make it fail on purpose without a source string the stub recognises. What is under test here is
 * what the *panel* does when the renderer throws, not what makes the renderer throw, so the refusal is
 * scripted at the boundary between the two. `seen` records the class the panel asked the prose to wear,
 * which is the only way the test can tell "handed to the notebook's renderer" from "a div of its own".
 */
const preview = vi.hoisted(() => ({ unrenderable: '[[[this draft cannot be rendered]]]', seen: { className: '' } }))

const {
  DRAFT, LINKED, updateConversationArtifact, removeConversationArtifact, conversationArtifacts,
  createConversation, createConversationArtifact, conversation,
  conversationArtifactVersions, conversationArtifactVersion, restoreConversationArtifact, getNote, gate,
} = vi.hoisted(() => {
  const noteId = '01hzzzzzzzzzzzzzzzzzzzzz20'
  const draft = {
    id: 'a1',
    conversationId: 'c1',
    title: 'A plan',
    content: '# A plan\n\nFirst, the thing.',
    noteId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 2,
  }
  // What the browser remembers is not what the note says now, so a linked draft opens on the note.
  const gate: { resolve: ((value: { content: string }) => void) | null } = { resolve: null }
  return {
    DRAFT: draft,
    LINKED: { ...draft, id: 'a2', noteId },
    getNote: vi.fn(() => new Promise<{ content: string }>((resolve) => { gate.resolve = resolve })),
    gate,
    updateConversationArtifact: vi.fn(async (_id: string, artifactId: string, patch: Record<string, unknown>) => ({
      // The row the server answers with is the same draft it was asked about: a reply that came back
      // looking like another, unlinked draft would move the panel off the document it is editing.
      artifact: {
        ...draft,
        ...patch,
        id: artifactId,
        noteId: patch.noteId === undefined ? (artifactId === 'a2' ? noteId : null) : patch.noteId,
      },
    })),
    removeConversationArtifact: vi.fn(async () => ({ ok: true })),
    conversationArtifacts: vi.fn(async () => ({ artifacts: [draft] })),
    createConversation: vi.fn(async () => ({ conversation: { id: 'c1' } })),
    createConversationArtifact: vi.fn(async (id: string) => ({
      artifact: { ...draft, id: 'a3', conversationId: id, title: '', content: '' },
    })),
    conversation: vi.fn(async (id: string) => ({
      conversation: { id, ephemeral: false },
      messages: [],
      attachments: [],
      streaming: false,
    })),
    conversationArtifactVersions: vi.fn(async (): Promise<{ versions: AssistantArtifactVersion[] }> => ({ versions: [] })),
    conversationArtifactVersion: vi.fn(async (_id: string, _artifactId: string, versionId: string) => ({
      version: { id: versionId, artifactId: 'a1', conversationId: 'c1', version: 1, title: 'A plan', content: DRAFT.content, source: 'user', messageId: null, createdAt: 1 },
    })),
    restoreConversationArtifact: vi.fn(async (_id: string, artifactId: string) => ({
      artifact: { ...draft, id: artifactId, version: 2 },
    })),
  }
})

vi.mock('../../lib/api', () => ({
  // The shape the real class has: the status is what the panel reads to tell a version conflict from a
  // network failure.
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: unknown,
      readonly serverMessage?: string,
    ) {
      super(message)
      this.name = 'ApiError'
    }
  },
  api: {
    assistant: {
      updateConversationArtifact,
      removeConversationArtifact,
      conversationArtifacts,
      createConversation,
      createConversationArtifact,
      conversation,
      conversationArtifactVersions,
      conversationArtifactVersion,
      restoreConversationArtifact,
    },
    notes: { get: getNote },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: ({ value, onChange, placeholder }: { value: string, onChange: (next: string) => void, placeholder?: string }) =>
    createElement('textarea', { value, placeholder, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }),
}))

// The notebook's renderer stands in for a documented refusal: it records the prose class it was handed,
// and it throws for one body. Everything else about a draft is the panel's own contract.
vi.mock('../preview/MarkdownBody', () => ({
  MarkdownBody: ({ className, source }: { className?: string, source: string }) => {
    preview.seen.className = className ?? ''
    if (source.includes(preview.unrenderable)) throw new Error('the renderer refused this document')
    return createElement('div', { 'data-preview': '1' })
  },
}))

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]

async function show(state: Partial<ReturnType<typeof useAssistant.getState>>): Promise<void> {
  useAssistant.setState({ ...original, ...state })
  await act(async () => { root.render(createElement(CanvasPanel)) })
}

/**
 * Mounts the panel the way the chat mounts it: behind the composer's toggle, and only while a thread is
 * open. The toggle is what a closed drawer has to hand the focus back to, so it has to exist.
 */
function Harness() {
  const open = useAssistant((state) => state.canvasOpen)
  const setOpen = useAssistant((state) => state.setCanvasOpen)
  return createElement(Fragment, null,
    createElement('button', { type: 'button', 'data-canvas-toggle': '1', onClick: () => setOpen(!open) }, 'canvas'),
    open && useAssistant.getState().activeId ? createElement(CanvasPanel) : null)
}

async function showAt(breakpoint: 'phone' | 'wide'): Promise<void> {
  stubBreakpoint(breakpoint === 'wide')
  useAssistant.setState({ ...original, activeId: 'c1', artifacts: [], artifactsReady: true, activeArtifactId: null, canvasOpen: false })
  await act(async () => { root.render(createElement(Harness)) })
}

async function openDrawer(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  await act(async () => { useAssistant.setState({ canvasOpen: true }) })
}

const drawer = () => document.body.querySelector<HTMLElement>('[data-surface="drawer"]')

/** Presses Escape the way the browser does, on the window the overlay listens to. */
function pressEscape(): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
}

/** Types into a controlled input the way a browser does, which is the only way React sees a keystroke. */
function type(node: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the canvas panel', () => {
  /** Types into the textarea the editor stands in for, the way a browser does. */
  function typeIn(value: string): void {
    const area = document.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(area, value)
      area.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  it('says so when the conversation has no drafts', async () => {
    await show({ activeId: 'c1', artifacts: [], artifactsReady: true, activeArtifactId: null })
    expect(document.body.textContent).toContain(t('assistant.canvas.empty'))
  })

  it('starts an empty draft, and the conversation it needs, from an empty panel', async () => {
    await show({ activeId: null, artifacts: [], artifactsReady: true, activeArtifactId: null })
    const start = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.new')))
    expect(start, 'an empty panel offers no way to start').toBeTruthy()
    await act(async () => { start!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(createConversation).toHaveBeenCalled()
    expect(createConversationArtifact).toHaveBeenCalledWith('c1', { title: '', content: '' })
    expect(useAssistant.getState().activeId).toBe('c1')
    expect(useAssistant.getState().activeArtifactId).toBe('a3')
    expect(useAssistant.getState().canvasOpen).toBe(true)
  })

  it('lists the drafts and opens the one that is picked', async () => {
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: null })
    const row = buttons().find((node) => node.textContent?.includes('A plan'))
    expect(row, 'the draft is not listed').toBeTruthy()
    act(() => { row!.click() })
    expect(useAssistant.getState().activeArtifactId).toBe('a1')
  })

  it('shows the open draft in the editor, and commits a rename once the typing settles', async () => {
    vi.useFakeTimers()
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    const title = document.querySelector<HTMLInputElement>('input')!
    expect(title.value).toBe('A plan')
    expect(document.querySelector('textarea')?.value).toBe(DRAFT.content)

    type(title, 'A better plan')
    // Nothing leaves on the keystroke itself: a paragraph would otherwise be one request per character.
    expect(updateConversationArtifact).not.toHaveBeenCalled()
    // The settled value commits, and the store's own write lands as a re-render of the panel.
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE.persist) })
    expect(updateConversationArtifact).toHaveBeenCalledWith(
      'c1', 'a1',
      expect.objectContaining({ title: 'A better plan', content: DRAFT.content, baseVersion: 1, source: 'user' }),
    )
  })

  it('keeps the text on screen when a save fails, and retries on demand', async () => {
    vi.useFakeTimers()
    updateConversationArtifact.mockRejectedValueOnce(new Error('offline'))
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    typeIn('my paragraph')
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE.persist) })
    expect(document.body.textContent).toContain(t('assistant.canvas.unsaved'))
    expect(document.querySelector('textarea')?.value).toBe('my paragraph')
    // Nothing retries behind the reader's back: a failing server would otherwise be hammered by the debounce.
    expect(updateConversationArtifact).toHaveBeenCalledTimes(1)

    const retry = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.retry_save')))
    expect(retry, 'a failed save offers no way to ask again').toBeTruthy()
    await act(async () => {
      retry!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateConversationArtifact).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('assistant.canvas.saved'))
  })

  it('keeps the reader\'s words when a new version arrives mid-edit, and offers the choice', async () => {
    vi.useFakeTimers()
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    typeIn('my paragraph')
    await act(async () => {
      useAssistant.setState({ artifacts: [{ ...DRAFT, content: 'Assistant rewrote this.', version: 2 }] })
    })
    expect(document.body.textContent).toContain(t('assistant.canvas.conflict_title'))
    expect(document.querySelector('textarea')?.value).toBe('my paragraph')

    const adopt = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.adopt')))
    expect(adopt, 'the conflict offers no way to take the new version').toBeTruthy()
    act(() => { adopt!.click() })
    expect(document.querySelector('textarea')?.value).toBe('Assistant rewrote this.')
    expect(document.body.textContent).not.toContain(t('assistant.canvas.conflict_title'))
  })

  it('turns a version conflict into a choice rather than a dead save', async () => {
    vi.useFakeTimers()
    updateConversationArtifact.mockRejectedValueOnce(new ApiError(409, 'conflict', 'The draft changed while it was being edited.'))
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    typeIn('my paragraph')
    // The reload that follows the 409 sees the version that landed while this editor was typing.
    conversationArtifacts.mockResolvedValueOnce({ artifacts: [{ ...DRAFT, content: 'Incoming body', version: 2 }] })
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE.persist) })
    expect(document.body.textContent).toContain(t('assistant.canvas.conflict_title'))
    expect(document.querySelector('textarea')?.value).toBe('my paragraph')

    const keep = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.overwrite')))
    expect(keep, 'the conflict offers no way to keep the reader\'s text').toBeTruthy()
    await act(async () => {
      keep!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const last = updateConversationArtifact.mock.calls.at(-1)!
    expect(last[2]).toMatchObject({ content: 'my paragraph', baseVersion: 2 })
  })

  it('opens the version history and reads the stored snapshots', async () => {
    conversationArtifactVersions.mockResolvedValueOnce({
      versions: [
        { id: 'v2', artifactId: 'a1', conversationId: 'c1', version: 2, title: 'A plan', source: 'assistant', messageId: null, createdAt: 2 },
        { id: 'v1', artifactId: 'a1', conversationId: 'c1', version: 1, title: 'A plan', source: 'user', messageId: null, createdAt: 1 },
      ],
    })
    conversationArtifactVersion.mockResolvedValueOnce({
      version: { id: 'v2', artifactId: 'a1', conversationId: 'c1', version: 2, title: 'A plan', content: DRAFT.content, source: 'assistant', messageId: null, createdAt: 2 },
    })
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    const history = buttons().find((node) => node.getAttribute('aria-label') === t('assistant.canvas.history'))
    expect(history, 'the editor has no history control').toBeTruthy()
    await act(async () => {
      history!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(conversationArtifactVersions).toHaveBeenCalledWith('c1', 'a1')
    expect(document.body.textContent).toContain('v2')
    expect(document.body.textContent).toContain('v1')
    expect(document.body.textContent).toContain(t('assistant.canvas.source_assistant'))
  })

  it('drops a deleted draft, and falls back to the list', async () => {
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: 'a1' })
    await act(async () => { await useAssistant.getState().removeArtifact('a1') })
    expect(removeConversationArtifact).toHaveBeenCalledWith('c1', 'a1')
    expect(useAssistant.getState().artifacts).toEqual([])
    expect(useAssistant.getState().activeArtifactId).toBeNull()
    expect(document.body.textContent).toContain(t('assistant.canvas.empty'))
  })
})

/**
 * A draft that is also a note.
 *
 * Two surfaces, one document, and a read that takes a request: the note is fetched on mount while the
 * reader is already typing. Committing whatever settled before that read landed either reported a note
 * nobody had touched as a conflict, or wrote the draft's stale copy over the notebook's body — and a read
 * that lands after they typed would have replaced their paragraph with what the note said before.
 */
describe('a draft linked to a note', () => {
  /** Types into the textarea the editor stands in for, the way a browser does. */
  function typeArea(value: string): void {
    const area = document.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(area, value)
      area.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }

  it('writes nothing until the note has been read, and keeps what the reader typed meanwhile', async () => {
    vi.useFakeTimers()
    const notesOriginal = useNotes.getState()
    const editRemoteContent = vi.fn(async (_id: string, transform: (server: string) => string | null) =>
      (transform('the note body') === null ? 'conflict' : 'written'))
    useNotes.setState({ notes: {}, contents: {}, editRemoteContent })
    try {
      await show({ activeId: 'c1', artifacts: [LINKED], artifactsReady: true, activeArtifactId: LINKED.id })
      typeArea('my own paragraph')
      await act(async () => { vi.advanceTimersByTime(DEBOUNCE.persist * 2) })
      expect(updateConversationArtifact).not.toHaveBeenCalled()
      expect(editRemoteContent).not.toHaveBeenCalled()

      await act(async () => {
        gate.resolve?.({ content: 'the note body' })
        await vi.advanceTimersByTimeAsync(DEBOUNCE.persist * 2)
      })

      expect(updateConversationArtifact).toHaveBeenCalledWith(
        'c1', LINKED.id, expect.objectContaining({ content: expect.stringContaining('my own paragraph') }),
      )
      // The note is written against the body that was just read, with the reader's words on top of it.
      const transform = editRemoteContent.mock.calls.at(-1)![1] as (server: string) => string | null
      expect(transform('the note body')).toContain('my own paragraph')
      expect(transform('edited in the notebook')).toBeNull()
      expect(document.querySelector('textarea')?.value).toContain('my own paragraph')
    } finally {
      useNotes.setState(notesOriginal, true)
    }
  })

  /**
   * The read that did not answer.
   *
   * Nothing arrived, which is not the same fact as “the note is no longer in the notebook”. The panel that
   * says the second one tells a reader their document was deleted, and leaves them with no way back except
   * reopening the draft — so this branch has to be a stated failure with a retry on it.
   */
  it('says the note could not be read, rather than that it is gone, and asks again', async () => {
    const notesOriginal = useNotes.getState()
    const editRemoteContent = vi.fn(async (_id: string, transform: (server: string) => string | null) =>
      (transform('the note body') === null ? 'conflict' : 'written'))
    useNotes.setState({ notes: {}, contents: {}, editRemoteContent })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    try {
      getNote.mockRejectedValueOnce(new Error('Failed to fetch'))
      await show({ activeId: 'c1', artifacts: [LINKED], artifactsReady: true, activeArtifactId: LINKED.id })
      await act(async () => { await Promise.resolve() })
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.canvas.note_missing') }))
      const alert = document.querySelector('[role="alert"]')
      expect(alert?.textContent, 'the failed read went unreported').toContain(t('assistant.canvas.note_read_failed'))
      const retry = [...alert!.querySelectorAll('button')].find((node) => node.textContent?.includes(t('common.retry')))
      expect(retry, 'a failed read offers no way to ask again').toBeTruthy()

      // The retry is the same read, and the note is still where it was. The draft is not overwritten by
      // it: the two documents differ, and the panel says so instead of choosing a side.
      await act(async () => { retry!.click() })
      await act(async () => { gate.resolve?.({ content: 'the note body' }) })
      expect(document.querySelector('textarea')?.value).toBe(LINKED.content)
      expect(document.body.textContent).toContain(t('assistant.canvas.diverged'))
      expect(document.querySelector('[role="alert"]')).toBeNull()
    } finally {
      useNotes.setState(notesOriginal, true)
      toast.mockRestore()
    }
  })
})

/**
 * The panel at each end of the breakpoint.
 *
 * jsdom has no layout engine, so this asserts on roles and classes rather than on measured widths: what
 * `w-[min(420px,42vw)]` costs a 390px phone is arithmetic, and the defect is that the panel asked for that
 * arithmetic to hold. What can be proven here is which container the panel renders into, and that the phone
 * container behaves like the modal it has to be — focus in on open, focus back on close, Escape and the
 * backdrop both close it.
 */
describe('the canvas beside the thread on a wide window', () => {
  it('is the dock it always was', async () => {
    await showAt('wide')
    await openDrawer(document.querySelector<HTMLElement>('[data-canvas-toggle]')!)
    expect(drawer(), 'a wide window should not get a drawer').toBeNull()
    const dock = [...document.querySelectorAll<HTMLElement>('aside')].find((node) => node.hasAttribute('data-canvas-dock'))
    expect(dock, 'the panel no longer docks beside the thread').toBeTruthy()
  })
})

describe('the canvas on a phone', () => {
  it('opens as a modal drawer instead of taking 42vw off the thread', async () => {
    await showAt('phone')
    await openDrawer(document.querySelector<HTMLElement>('[data-canvas-toggle]')!)
    const panel = drawer()
    expect(panel, 'the panel is not in a drawer').toBeTruthy()
    expect(panel!.getAttribute('role')).toBe('dialog')
    expect(panel!.getAttribute('aria-modal')).toBe('true')
    expect(panel!.getAttribute('aria-label')).toBe(t('assistant.canvas.title'))
    // The dock's viewport-relative width belongs to the wide layout only.
    expect([...document.querySelectorAll<HTMLElement>('aside')].some((node) => node.hasAttribute('data-canvas-dock'))).toBe(false)
    // And the thread's own toggle is not left holding the focus.
    expect(document.activeElement?.closest('[data-surface="drawer"]')).toBe(panel)
  })

  it('gives the focus back to the toggle when Escape closes it', async () => {
    await showAt('phone')
    const trigger = document.querySelector<HTMLElement>('[data-canvas-toggle]')!
    await openDrawer(trigger)
    pressEscape()
    expect(useAssistant.getState().canvasOpen).toBe(false)
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on the backdrop, and returns the focus with it', async () => {
    await showAt('phone')
    const trigger = document.querySelector<HTMLElement>('[data-canvas-toggle]')!
    await openDrawer(trigger)
    const scrim = [...document.body.querySelectorAll<HTMLElement>('div')].find((node) => node.className.includes('scrim'))
    expect(scrim, 'the drawer has no backdrop').toBeTruthy()
    act(() => { scrim!.click() })
    expect(useAssistant.getState().canvasOpen).toBe(false)
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('still lists the drafts inside the drawer', async () => {
    await showAt('phone')
    await openDrawer(document.querySelector<HTMLElement>('[data-canvas-toggle]')!)
    expect(drawer()!.textContent).toContain(t('assistant.canvas.empty'))
  })
})

/**
 * The draft's two modes.
 *
 * A draft is the assistant's answer handed over as a document, and the document is the thing that has to
 * read well: code with its highlight and its copy button, a table that stays inside the panel, and — when
 * the render cannot be had at all — the text itself with a sentence saying why the picture is missing. The
 * blank panel is the failure this guards, because a blank looks exactly like an empty draft.
 */
describe('the draft preview', () => {
  async function showDraft(content: string): Promise<void> {
    // Cleared first: the stand-in records what it was last handed, and a record left over from the render
    // before this one would answer for a document the panel never drew.
    preview.seen.className = ''
    await show({ activeId: 'c1', artifacts: [{ ...DRAFT, content }], artifactsReady: true, activeArtifactId: DRAFT.id })
    const tab = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.preview')))!
    act(() => { tab.click() })
  }

  /** Switches modes with a key rather than a click, the way a keyboard reader does. */
  function pressKey(node: Element, key: string): void {
    act(() => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  it('draws the draft through the notebook\'s own prose surface', async () => {
    await showDraft(DRAFT.content)
    // `ink-chat-prose` is what carries the code-block and table rules of `prose.css` into the narrow panel.
    expect(preview.seen.className).toContain('ink-chat-prose')
  })

  it('says the draft could not be rendered and shows its text rather than an empty panel', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await showDraft(`# Heading\n\n${preview.unrenderable}\n\nthe paragraph under it`)
      const alert = document.querySelector('[role="alert"]')
      expect(alert?.textContent, 'a draft that failed to render said nothing').toContain(t('assistant.canvas.render_failed'))
      // The text is the deliverable: a notice alone still leaves the reader with no document.
      expect(document.body.textContent).toContain('the paragraph under it')
      const raw = document.querySelector<HTMLPreElement>('pre[role="region"]')
      expect(raw, 'the unreadable draft has no text shown').toBeTruthy()
      expect(raw!.getAttribute('aria-label')).toBe(t('assistant.canvas.raw_text'))
      // A region the reader scrolls with the mouse has to scroll with the keyboard too.
      expect(raw!.tabIndex).toBe(0)
      expect(raw!.className).toContain('font-mono')
    } finally {
      errors.mockRestore()
    }
  })

  it('names the panel each mode shows', async () => {
    await showDraft(DRAFT.content)
    const panel = document.querySelector('[role="tabpanel"]')
    expect(panel, 'a mode is not marked as a panel').toBeTruthy()
    const activeTab = document.getElementById(panel!.getAttribute('aria-labelledby')!)
    expect(activeTab?.textContent).toContain(t('assistant.canvas.preview'))
    expect(activeTab?.getAttribute('aria-controls')).toBe(panel!.id)
  })

  /**
   * The notice has to leave when the document it is standing in for changes.
   *
   * The reader cannot type while the preview is up — the editor is not mounted — but the body can still
   * move under them: a draft linked to a note opens on what the notebook says, and that answer arrives
   * after the first paint. A panel that kept failing over a body it was never asked to re-render would
   * tell the reader their document is unreadable when it is sitting there, fixed.
   */
  it('draws the draft once the body it failed on has been replaced', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const notesOriginal = useNotes.getState()
    useNotes.setState({ notes: {}, contents: {}, editRemoteContent: vi.fn(async () => 'written' as const) })
    try {
      preview.seen.className = ''
      useAssistant.setState({
        ...original,
        activeId: 'c1',
        artifacts: [{ ...LINKED, content: preview.unrenderable }],
        artifactsReady: true,
        activeArtifactId: LINKED.id,
      })
      await act(async () => { root.render(createElement(CanvasPanel)) })
      const tab = buttons().find((node) => node.textContent?.includes(t('assistant.canvas.preview')))!
      act(() => { tab.click() })
      expect(document.querySelector('[role="alert"]'), 'a draft that failed to render said nothing').toBeTruthy()

      // A new version from elsewhere — an assistant write, or the same draft in another tab — replaces the
      // body the preview failed on. The panel adopts it while the editor is clean, so the notice goes with
      // the document it was about.
      await act(async () => {
        useAssistant.setState({
          artifacts: [{ ...LINKED, content: DRAFT.content, version: 2 }],
        })
        await Promise.resolve()
      })
      expect(preview.seen.className, 'the panel stayed on its notice over a body it never re-rendered').toContain('ink-chat-prose')
      expect(document.querySelector('[role="alert"]'), 'the notice outlived the document it was about').toBeNull()
    } finally {
      useNotes.setState(notesOriginal, true)
      errors.mockRestore()
    }
  })

  it('moves between the two modes with the arrow keys', async () => {
    await show({ activeId: 'c1', artifacts: [DRAFT], artifactsReady: true, activeArtifactId: DRAFT.id })
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.length).toBe(2)
    const [write, previewTab] = tabs as [HTMLElement, HTMLElement]
    // One stop in the tab sequence, the one that is showing.
    expect(write.tabIndex).toBe(0)
    expect(previewTab.tabIndex).toBe(-1)

    write.focus()
    pressKey(write, 'ArrowRight')
    expect(document.activeElement, 'the arrow keys do not move between the modes').toBe(previewTab)
    expect(previewTab.getAttribute('aria-selected')).toBe('true')

    pressKey(previewTab, 'ArrowRight')
    expect(document.activeElement).toBe(write)
    pressKey(write, 'End')
    expect(document.activeElement).toBe(previewTab)
    pressKey(previewTab, 'Home')
    expect(document.activeElement).toBe(write)
  })
})

describe('the reply menu', () => {
  it('offers the canvas only where a draft can be kept', () => {
    const withRow = messageMenuItems({ role: 'assistant', text: 'An answer', onOpenCanvas: () => undefined })
    expect(withRow.map((item) => item.id)).toContain('canvas')
    // A live turn has no row, and a draft hangs off a row; the reader's own message is not an answer.
    expect(messageMenuItems({ role: 'assistant', text: 'An answer' }).map((item) => item.id)).not.toContain('canvas')
    expect(messageMenuItems({ role: 'user', text: 'A question', onOpenCanvas: () => undefined }).map((item) => item.id)).not.toContain('canvas')
  })
})
