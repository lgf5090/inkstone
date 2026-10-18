// @vitest-environment jsdom
/**
 * What a draft looks like when the canvas draws it.
 *
 * The panel's other file mocks the renderer on purpose — it is about the panel's own wiring. This one
 * mounts the notebook's real Markdown pipeline behind the panel, because the things that matter about a
 * drawn draft are exactly the things a stand-in cannot answer: whether a fence comes out with a copy
 * button that copies *that fence*, whether a table keeps its cells inside the panel, whether a `![[note]]`
 * arrives or sits there saying "Loading" forever, and whether markup a model wrote can come back as
 * markup. None of those is visible from a mocked component, and all of them are the difference between a
 * draft that reads like a document and a draft that only looks like one.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { CanvasPanel } from './CanvasPanel'
import { useAssistant } from './assistant-store'

/** Payload a model writes as text, which must never come back as live markup. */
const MARKUP = '<img src=x onerror=alert(1)>'

const BODY = [
  '# Release plan',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  '| Stage | Owner |',
  '| --- | --- |',
  '| Draft | Ada |',
  '',
  '- [ ] Ping the editor',
  '',
  'Dates are in ![[Roadmap]].',
].join('\n')

const { updateArtifact, removeArtifact, noteRead } = vi.hoisted(() => ({
  updateArtifact: vi.fn(async (_conversation: string, artifactId: string, patch: Record<string, unknown>) => ({
    artifact: { id: artifactId, conversationId: 'c1', title: 'A plan', content: 'x', noteId: null, createdAt: 1, updatedAt: 2, ...patch },
  })),
  removeArtifact: vi.fn(async () => ({ ok: true })),
  noteRead: vi.fn(async () => { throw new Error('the notebook did not answer') }),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: { updateConversationArtifact: updateArtifact, removeConversationArtifact: removeArtifact },
    notes: { get: noteRead },
    files: { byName: vi.fn(async () => ({ files: [] })), upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

// CodeMirror is not what is under test here; the textarea says which mode is mounted and holds the body.
vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: ({ value, onChange, placeholder }: { value: string, onChange: (next: string) => void, placeholder?: string }) =>
    createElement('textarea', { value, placeholder, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }),
}))

let root: Root
let host: HTMLElement

const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]

/**
 * The panel behind the composer's toggle, the way the chat mounts it.
 *
 * Closing the canvas is what takes the panel down — the flag unmounts it rather than hiding it — so a case
 * about what a closed panel leaves behind has to mount it the same way, or it would be measuring a panel
 * that is still there.
 */
function CanvasHost() {
  const open = useAssistant((state) => state.canvasOpen)
  return open ? createElement(CanvasPanel) : null
}

/** Mounts the panel with one draft and asks for the drawn view of it. */
async function drawDraft(content: string): Promise<void> {
  useAssistant.setState({
    activeId: 'c1',
    artifacts: [{ id: 'a1', conversationId: 'c1', title: 'A plan', content, noteId: null, createdAt: 1, updatedAt: 2 }],
    artifactsReady: true,
    activeArtifactId: 'a1',
    canvasOpen: true,
  })
  await act(async () => { root.render(createElement(CanvasHost)) })
  const preview = tabs()[1]!
  await act(async () => { preview.click() })
}

/** Waits for an asynchronous pass of the renderer to land in the DOM the panel is showing. */
async function untilDrawn(selector: string): Promise<HTMLElement> {
  let node: HTMLElement | null = null
  await act(async () => {
    await vi.waitFor(() => {
      node = document.querySelector<HTMLElement>(selector)
      expect(node, `nothing matched ${selector} in the drawn draft`).toBeTruthy()
    }, { timeout: 8_000, interval: 10 })
  })
  return node!
}

beforeEach(async () => {
  installTestGlobals()
  // The dock rather than the phone drawer: the same content, without the portal in the way.
  stubBreakpoint(true)
  await initI18n()
  useNotes.setState({
    notes: { n1: { id: 'n1', title: 'Roadmap', folderId: null, rev: 1, updatedAt: 0, createdAt: 0, deletedAt: null, isStarred: false, tags: [] } },
    contents: { n1: 'Ships in October.' },
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useNotes.setState({ notes: {}, contents: {} } as never, true)
  useUi.setState({ toasts: [] } as never)
  useAssistant.setState({ activeId: null, artifacts: [], artifactsReady: false, activeArtifactId: null, canvasOpen: false })
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a drawn draft', () => {
  it('gives a fenced block its own copy entry, and copies the block rather than the draft', async () => {
    await drawDraft(BODY)
    const block = await untilDrawn('.code-block')
    // The class that carries the panel's own code and table rules onto the document.
    expect(block.closest('.ink-chat-prose'), 'the draft was drawn outside the notebook prose').toBeTruthy()
    await untilDrawn('.code-block code.language-typescript .token')

    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const button = block.querySelector<HTMLElement>('[data-copy]')!
    expect(button.getAttribute('aria-label'), 'the copy entry has no name to read out').toBe(t('markdown.copy_code'))

    await act(async () => { button.click() })
    expect(writeText).toHaveBeenCalledWith('const answer = 42')
    expect(button.textContent).toBe(t('common.copied'))
  })

  it('keeps every cell of a table in the drawn draft, inside the wrapper that scrolls', async () => {
    await drawDraft(BODY)
    const table = await untilDrawn('.ink-chat-prose table')
    expect([...table.querySelectorAll('th')].map((head) => head.textContent)).toEqual(['Stage', 'Owner'])
    expect([...table.querySelectorAll('tbody td')].map((cell) => cell.textContent)).toEqual(['Draft', 'Ada'])
    // The narrow panel scrolls this wrapper (`chat.css`); the cells are what must never be dropped.
    expect(table.parentElement?.className, 'the table is not inside its scroll wrapper').toContain('table-wrap')
  })

  it('brings an embedded note into the draft instead of leaving its box saying Loading', async () => {
    await drawDraft('Dates are in ![[Roadmap]].')
    const embed = await untilDrawn('.note-embed.ready')
    expect(embed.textContent).toContain('Ships in October.')
    expect(embed.querySelector('[aria-busy="true"]'), 'the embed is still claiming to be at work').toBeNull()
    // Nothing on this panel may be left waiting on a pass that already answered — or never will.
    expect(document.querySelector('.note-embed.loading, .note-embed [aria-busy="true"]')).toBeNull()
  })

  it('names an embed it cannot bring in, rather than leaving the reader waiting on it', async () => {
    await drawDraft('See ![[Nowhere Note]] for the rest.')
    const embed = await untilDrawn('.note-embed.error')
    expect(embed.querySelector('.note-embed-body')?.textContent).toBe(t('markdown.embedded_note_not_found'))
    expect(embed.getAttribute('class'), 'a failed embed still wears the loading state').not.toContain('loading')
    expect(embed.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('keeps markup a model wrote out of the document it draws', async () => {
    await drawDraft([`Try ${MARKUP} here.`, '', '```html', MARKUP, '```'].join('\n'))
    const code = await untilDrawn('.code-block[data-lang="html"] code')
    // Inside a fence the payload is text the reader can copy, nothing else.
    expect(code.textContent).toContain(MARKUP)
    expect(code.querySelectorAll('img, script').length).toBe(0)
    // And nowhere in the drawn draft did a handler or a script survive the sanitizer.
    expect(document.querySelectorAll('script').length).toBe(0)
    expect(document.querySelector('[onerror], [onload], [onclick], [onmouseover]'), 'a live handler reached the DOM').toBeNull()
  })
})

describe('the read-only boundary', () => {
  it('draws the draft with no control that would edit it', async () => {
    await drawDraft(BODY)
    await untilDrawn('.code-block')
    // The body editor is the write mode's own: the preview must not leave one mounted beside the document.
    expect(document.querySelector('textarea'), 'the editor is mounted under the preview').toBeNull()

    const task = await untilDrawn('input[type="checkbox"]') as HTMLInputElement
    expect(task.disabled, 'a preview checkbox that writes nothing is a control that lies').toBe(true)
    expect(task.getAttribute('data-task-line'), 'the draft task is still addressed as a writable line').toBeNull()
    expect(task.getAttribute('aria-label')).toBe(t('assistant.canvas.tasks_read_only'))
  })

  it('swaps the document out when the reader goes back to writing, and keeps the body', async () => {
    await drawDraft(BODY)
    await untilDrawn('.code-block')
    await act(async () => { tabs()[0]!.click() })
    expect(document.querySelector('.ink-chat-prose'), 'the drawn draft outlived its own tab').toBeNull()
    const editor = document.querySelector<HTMLTextAreaElement>('textarea')!
    expect(editor.value).toBe(BODY)
  })

  it('leaves nothing of the draft on screen once the panel closes', async () => {
    await drawDraft(BODY)
    await untilDrawn('.note-embed.ready')
    await act(async () => { useAssistant.getState().setCanvasOpen(false) })
    expect(document.querySelector('.ink-chat-prose, .code-block, textarea, [aria-busy="true"]'),
      'the closed panel still holds a piece of the draft').toBeNull()
  })
})

describe('the draft copy entry', () => {
  /** The panel's own entry, which copies the whole draft — not a drawn block's copy button. */
  function copyButton(): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => !node.hasAttribute('data-copy') && node.textContent?.includes(t('assistant.canvas.copy')))!
  }

  it('says copied only when the clipboard took the draft', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await drawDraft(BODY)
    const button = copyButton()
    await act(async () => { button.click() })
    expect(writeText).toHaveBeenCalledWith(BODY)
    expect(button.textContent).toBe(t('assistant.canvas.copied'))
    expect(useUi.getState().toasts).toEqual([])
  })

  it('says the copy failed when the clipboard refused it', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('not allowed') }) },
      configurable: true,
    })
    await drawDraft(BODY)
    const button = copyButton()
    await act(async () => { button.click() })
    await act(async () => { await Promise.resolve() })
    expect(button.textContent, 'the panel claimed a copy that never happened').toBe(t('assistant.canvas.copy'))
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain(t('preview.could_not_copy'))
  })

  it('cancels its countdown when the panel goes away', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (_text: string) => undefined) }, configurable: true })
    await drawDraft(BODY)
    const countdown = vi.spyOn(window, 'setTimeout')
    const cancelled = vi.spyOn(window, 'clearTimeout')
    const button = copyButton()
    await act(async () => { button.click() })
    expect(button.textContent).toBe(t('assistant.canvas.copied'))
    const id = countdown.mock.results.at(-1)!.value as unknown as number
    act(() => root.unmount())
    // A countdown outliving the panel it was drawn in is state the reader closed and the app did not.
    expect(cancelled).toHaveBeenCalledWith(id)
  })
})
