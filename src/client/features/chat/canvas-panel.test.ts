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
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render'
import { CanvasPanel } from './CanvasPanel'
import { messageMenuItems } from './MessageMenu'
import { useAssistant } from './assistant-store'

const { DRAFT, updateConversationArtifact, removeConversationArtifact } = vi.hoisted(() => {
  const draft = {
    id: 'a1',
    conversationId: 'c1',
    title: 'A plan',
    content: '# A plan\n\nFirst, the thing.',
    noteId: null,
    createdAt: 1,
    updatedAt: 2,
  }
  return {
    DRAFT: draft,
    updateConversationArtifact: vi.fn(async (_id: string, _artifactId: string, patch: Record<string, unknown>) => ({ artifact: { ...draft, ...patch } })),
    removeConversationArtifact: vi.fn(async () => ({ ok: true })),
  }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      updateConversationArtifact,
      removeConversationArtifact,
    },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: ({ value, onChange, placeholder }: { value: string, onChange: (next: string) => void, placeholder?: string }) =>
    createElement('textarea', { value, placeholder, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }),
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
  it('says so when the conversation has no drafts', async () => {
    await show({ activeId: 'c1', artifacts: [], artifactsReady: true, activeArtifactId: null })
    expect(document.body.textContent).toContain(t('assistant.canvas.empty'))
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
    expect(updateConversationArtifact).toHaveBeenCalledWith('c1', 'a1', { title: 'A better plan', content: DRAFT.content })
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
    const dock = [...document.querySelectorAll<HTMLElement>('aside')].find((node) => node.className.includes('42vw'))
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
    expect([...document.querySelectorAll<HTMLElement>('aside')].some((node) => node.className.includes('42vw'))).toBe(false)
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

describe('the reply menu', () => {
  it('offers the canvas only where a draft can be kept', () => {
    const withRow = messageMenuItems({ role: 'assistant', text: 'An answer', onOpenCanvas: () => undefined })
    expect(withRow.map((item) => item.id)).toContain('canvas')
    // A live turn has no row, and a draft hangs off a row; the reader's own message is not an answer.
    expect(messageMenuItems({ role: 'assistant', text: 'An answer' }).map((item) => item.id)).not.toContain('canvas')
    expect(messageMenuItems({ role: 'user', text: 'A question', onOpenCanvas: () => undefined }).map((item) => item.id)).not.toContain('canvas')
  })
})
