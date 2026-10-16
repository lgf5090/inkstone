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
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBOUNCE } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
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

describe('the reply menu', () => {
  it('offers the canvas only where a draft can be kept', () => {
    const withRow = messageMenuItems({ role: 'assistant', text: 'An answer', onOpenCanvas: () => undefined })
    expect(withRow.map((item) => item.id)).toContain('canvas')
    // A live turn has no row, and a draft hangs off a row; the reader's own message is not an answer.
    expect(messageMenuItems({ role: 'assistant', text: 'An answer' }).map((item) => item.id)).not.toContain('canvas')
    expect(messageMenuItems({ role: 'user', text: 'A question', onOpenCanvas: () => undefined }).map((item) => item.id)).not.toContain('canvas')
  })
})
