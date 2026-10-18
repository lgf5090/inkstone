// @vitest-environment jsdom
/**
 * Keeping one answer from the thread, and what a refused keep says about itself.
 *
 * Three promises pinned here, all of them about the order of events rather than the markup:
 *
 *  - the row does not move before the route answers. A keep is a column on a stored row, so a bubble that
 *    stars itself first is showing a mark the account may have refused — and unlike a verdict, a keep is
 *    read back somewhere else (the shelf), where the reader will notice the difference;
 *  - what the row shows afterwards is what the route reported, not what the press intended. The toggle lives
 *    on the server precisely so that two surfaces cannot each decide the answer;
 *  - a refusal reaches the reader with the route's own line about the field it disliked, through the same
 *    `ApiError.serverMessage` channel the settings forms print inside themselves. The press has no dialog to
 *    keep open, so the reason goes where a failure can still be read: into the caller's reporter when it has
 *    one, and into a toast when it has nothing.
 *
 * `aria-pressed` is asserted because the star is a toggle, and a toggle that does not say which way it is
 * pressed is a button the reader has to click to understand.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { AssistantBubble } from './MessageParts'
import { messageMenuItems } from './MessageMenu'

/** The route's answer, deferred so "nothing has moved yet" is a moment a test can stand in. */
interface SavedAnswer {
  conversationId: string
  messageId: string
  saved: boolean
  savedAt: number | null
}

const savedMock = vi.hoisted(() => vi.fn())
const deferreds: { promise: Promise<SavedAnswer>, resolve: (value: SavedAnswer) => void, reject: (error: unknown) => void }[] = []

vi.mock('../../lib/api', () => ({
  // The store's `describeFailure` reads `serverMessage` off this class, so the double has to carry it the
  // way the real one does — otherwise the test would pass on an error shape the product never produces.
  ApiError: class ApiError extends Error {
    readonly status: number
    readonly code: string
    readonly details?: unknown
    readonly serverMessage?: string
    constructor(status: number, code: string, message: string, details?: unknown, serverMessage?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
      this.details = details
      this.serverMessage = serverMessage
    }
  },
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      setMessageSaved: (conversationId: string, messageId: string) => savedMock(conversationId, messageId),
      rateAnswer: vi.fn(async () => ({ message: {} })),
      skills: vi.fn(async () => ({ skills: [] })),
    },
  },
}))

function defer(): { promise: Promise<SavedAnswer>, resolve: (value: SavedAnswer) => void, reject: (error: unknown) => void } {
  let resolve: (value: SavedAnswer) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<SavedAnswer>((done, fail) => {
    resolve = done
    reject = fail
  })
  const slot = { promise, resolve, reject }
  deferreds.push(slot)
  return slot
}

function row(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'the answer',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

const KEEP = () => t('assistant.chat.keep')
const UNKEEP = () => t('assistant.chat.unkeep')
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byName = (name: string) => buttons()
  .find((node) => ((node.getAttribute('aria-label') ?? node.textContent ?? '').trim() === name))

let root: Root
let host: HTMLElement

/** Mounted from the store, the way `ChatView` hands the bubble the row it holds. */
function mount(): void {
  const message = useAssistant.getState().messages[0]
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'The answer.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      messageId: 'm1',
      savedAt: message?.savedAt ?? null,
      onRate: () => {},
    }))
  })
}

const originalAssistant = useAssistant.getState()
const originalUi = useUi.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  savedMock.mockClear()
  deferreds.length = 0
  savedMock.mockImplementation(() => defer().promise)
  useAssistant.setState({ ...originalAssistant, activeId: 'c1', messages: [row()] })
  useUi.setState({ ...originalUi })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mount()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
})

describe('the star on an answer', () => {
  it('says which way it is pressed, and asks for the opposite of that', () => {
    const off = byName(KEEP())
    expect(off, 'an unkept answer offers no keep').toBeTruthy()
    expect(off!.getAttribute('aria-pressed')).toBe('false')
    expect(byName(UNKEEP())).toBeUndefined()

    useAssistant.setState({ messages: [row({ savedAt: 1_700_000_000_500 })] })
    mount()
    const on = byName(UNKEEP())
    expect(on, 'a kept answer offers no way back').toBeTruthy()
    expect(on!.getAttribute('aria-pressed')).toBe('true')
  })

  it('moves the row only once the route has answered, and only to what it answered', async () => {
    await act(async () => {
      byName(KEEP())!.click()
    })
    expect(savedMock).toHaveBeenCalledWith('c1', 'm1')
    const gate = deferreds[0]!
    // Still pending: the mark belongs to the server, and nothing has been given yet.
    expect(useAssistant.getState().messages[0]!.savedAt ?? null).toBeNull()
    expect(byName(KEEP())!.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      gate.resolve({ conversationId: 'c1', messageId: 'm1', saved: true, savedAt: 1_700_000_000_900 })
      await gate.promise
    })
    mount()
    expect(useAssistant.getState().messages[0]!.savedAt).toBe(1_700_000_000_900)
    expect(byName(UNKEEP())!.getAttribute('aria-pressed')).toBe('true')
  })

  it('takes the server\'s state even when it is not the one the press asked for', async () => {
    useAssistant.setState({ messages: [row({ savedAt: 1_700_000_000_500 })] })
    mount()
    const gate = defer()
    savedMock.mockReturnValueOnce(gate.promise)
    await act(async () => {
      byName(UNKEEP())!.click()
    })
    // A second press elsewhere, or a row that was taken out between the two: the answer says "kept", and
    // the bubble has to believe the answer rather than its own last intent.
    await act(async () => {
      gate.resolve({ conversationId: 'c1', messageId: 'm1', saved: true, savedAt: 1_700_000_000_700 })
      await gate.promise
    })
    mount()
    expect(useAssistant.getState().messages[0]!.savedAt).toBe(1_700_000_000_700)
    expect(byName(UNKEEP())!.getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves the row alone and prints the route\'s reason when the write is refused', async () => {
    const gate = defer()
    savedMock.mockReturnValueOnce(gate.promise)
    const report = vi.fn()
    const refused = new ApiError(404, 'not_found', 'Not found', undefined, 'Message not found')
    const result = useAssistant.getState().toggleMessageSaved('m1', report)
    await act(async () => {
      gate.reject(refused)
      await expect(result).resolves.toBe(false)
    })
    expect(useAssistant.getState().messages[0]!.savedAt ?? null).toBeNull()
    expect(report).toHaveBeenCalledOnce()
    // The field-level line, not only the app's own headline: this is the half a reader cannot guess.
    expect(report.mock.calls[0]![0]).toEqual({ headline: 'Not found', detail: 'Message not found' })
    mount()
    expect(byName(KEEP())!.getAttribute('aria-pressed')).toBe('false')
  })

  it('falls back to a toast carrying the same line when the caller has no surface of its own', async () => {
    const gate = defer()
    savedMock.mockReturnValueOnce(gate.promise)
    await act(async () => {
      byName(KEEP())!.click()
      gate.reject(new Error('The backup is being restored right now.'))
      await gate.promise.catch(() => {})
    })
    mount()
    const toasts = useUi.getState().toasts
    expect(toasts.at(-1)?.title).toContain('The backup is being restored right now.')
    expect(useAssistant.getState().messages[0]!.savedAt ?? null).toBeNull()
  })

  it('names the thread the row is on rather than the one that happens to be open', async () => {
    // The shelf takes a keep off a turn in another conversation; `activeId` there is the wrong thread.
    useAssistant.setState({ activeId: 'elsewhere', messages: [row({ conversationId: 'c1' })] })
    mount()
    const gate = defer()
    savedMock.mockReturnValueOnce(gate.promise)
    await act(async () => {
      byName(KEEP())!.click()
    })
    expect(savedMock).toHaveBeenCalledWith('c1', 'm1')
    await act(async () => {
      gate.resolve({ conversationId: 'c1', messageId: 'm1', saved: true, savedAt: 1_700_000_000_000 })
      await gate.promise
    })
    mount()
    expect(useAssistant.getState().messages[0]!.savedAt).toBe(1_700_000_000_000)
  })
})

describe('the menu row', () => {
  const ids = (target: Parameters<typeof messageMenuItems>[0]) => messageMenuItems(target).map((item) => item.id)

  it('is offered only where the turn is stored, and says which way it acts', () => {
    expect(ids({ role: 'assistant', text: 'answer' })).not.toContain('keep')
    expect(ids({ role: 'assistant', text: 'answer', onToggleSaved: () => {} })).toContain('keep')
    const unkept = messageMenuItems({ role: 'assistant', text: 'answer', onToggleSaved: () => {} })
      .find((item) => item.id === 'keep')
    expect(unkept?.label).toBe(KEEP())
    expect(unkept?.checked).toBeUndefined()
    const kept = messageMenuItems({ role: 'assistant', text: 'answer', onToggleSaved: () => {}, saved: true })
      .find((item) => item.id === 'keep')
    expect(kept?.label).toBe(UNKEEP())
    expect(kept?.checked).toBe(true)
  })

  it('does not disturb the rows beside it when it is absent', () => {
    // The separators are drawn from which rows are there, so a hidden keep must not leave a menu with two
    // rules in a row or with the verdicts cut off from everything above them.
    const withoutKeep = messageMenuItems({ role: 'assistant', text: 'answer', onRate: () => {} })
    expect(withoutKeep.find((item) => item.id === 'rate-up')?.separatorBefore).toBe(true)
    const withKeep = messageMenuItems({ role: 'assistant', text: 'answer', onRate: () => {}, onToggleSaved: () => {} })
    expect(withKeep.find((item) => item.id === 'keep')?.separatorBefore).toBe(true)
    expect(withKeep.find((item) => item.id === 'rate-up')?.separatorBefore).toBeUndefined()
    expect(ids({ role: 'assistant', text: 'answer', onToggleSaved: () => {} })).toEqual(
      ['copy-md', 'copy-text', 'quote', 'save', 'download', 'keep'],
    )
  })
})
