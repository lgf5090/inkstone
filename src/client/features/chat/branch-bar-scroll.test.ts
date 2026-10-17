// @vitest-environment jsdom
/**
 * Reaching a branch that is off the edge of the bar.
 *
 * The row is one line tall and each chip is capped, so a thread with a few forks hides the rest behind its
 * edge with nothing on screen to say so — and a scroll box nobody can focus has no keyboard route to the
 * chips inside it either. What is pinned here is the shape of the fix rather than any measured pixel:
 * jsdom has no layout engine, so the overflow state cannot be observed, and these assertions read the
 * roles, the accessible names and the scroll call a press makes.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { BranchBar } from './BranchBar'

const { conversationBranches, openConversationInChat } = vi.hoisted(() => ({
  conversationBranches: vi.fn(),
  openConversationInChat: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { assistant: { conversationBranches: (id: string) => conversationBranches(id) } },
}))

vi.mock('./start-chat', () => ({ openConversationInChat: (id: string) => openConversationInChat(id) }))

let root: Root
let host: HTMLElement
let scrollBy: ReturnType<typeof vi.fn>

const chips = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byName = (name: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const region = () => document.body.querySelector<HTMLElement>('[role="region"]')

async function show(conversationId: string | null): Promise<void> {
  await act(async () => {
    root.render(createElement(BranchBar, { conversationId }))
  })
  await act(async () => {})
}

/**
 * The measurements a layout engine would have taken.
 *
 * jsdom reports every box as zero, so an overflow the row could not know about would leave the arrows
 * parked and the press unanswered — which is a property of the test browser, not of the bar.
 */
function readEdges(box: { scrollWidth: number, clientWidth: number, scrollLeft: number }): void {
  const node = region()
  expect(node, 'the scrollable row is missing').toBeTruthy()
  for (const [name, value] of Object.entries(box)) {
    Object.defineProperty(node!, name, { value, configurable: true, writable: true })
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  conversationBranches.mockReset()
  openConversationInChat.mockReset()
  // jsdom implements no scrolling at all, so the call the arrows make is the thing a stub can prove.
  scrollBy = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', { value: scrollBy, configurable: true })
  conversationBranches.mockResolvedValue({
    parent: { id: 'main', title: 'Main thread' },
    siblings: [
      { id: 'b1', title: 'Branch one', updatedAt: 1 },
      { id: 'b2', title: 'Branch two', updatedAt: 2 },
    ],
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('the branch row as a place a keyboard can stop', () => {
  it('hands the scroll box a focus stop and an accessible name', async () => {
    await show('b2')
    const box = region()
    expect(box, 'the scrollable row is not a focusable region').toBeTruthy()
    expect(box!.getAttribute('tabindex')).toBe('0')
    expect(box!.getAttribute('aria-label')).toBe(t('assistant.branch.label'))
    // The chips live inside it, so the keyboard reaches them by the same route as the row itself.
    expect(box!.querySelectorAll('button').length).toBeGreaterThan(0)
  })

  it('keeps every chip a button, and the thread being read marked and shut', async () => {
    await show('b2')
    const current = chips().find((node) => node.textContent === 'Branch two')!
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.disabled).toBe(true)
    expect(current.tagName).toBe('BUTTON')
  })
})

describe('the edges of a row that overflows', () => {
  it('names both edges, and stops them at the ends it cannot leave', async () => {
    await show('b2')
    const back = byName(t('assistant.branch.scroll_back'))
    const forward = byName(t('assistant.branch.scroll_forward'))
    expect(back, 'no affordance for the start of the row').toBeTruthy()
    expect(forward, 'no affordance for the end of the row').toBeTruthy()
    // Nothing overflows in a browser without a layout engine, which is the state these read as parked:
    // the arrows are there for the press, and hidden until there is somewhere to press towards.
    expect(back!.hasAttribute('hidden')).toBe(true)
    expect(back!.disabled).toBe(true)
    expect(forward!.disabled).toBe(true)
  })

  it('scrolls the row towards the edge the reader asked for', async () => {
    await show('b2')
    // A box with room to move, told to the element the way a layout engine would: jsdom measures nothing,
    // so the overflow state has to be written before the row will answer a press.
    readEdges({ scrollWidth: 500, clientWidth: 60, scrollLeft: 0 })
    await act(async () => { region()!.dispatchEvent(new Event('scroll')) })
    const forward = byName(t('assistant.branch.scroll_forward'))
    const back = byName(t('assistant.branch.scroll_back'))
    expect(back?.hasAttribute('hidden'), 'the arrows stay hidden while the row overflows').toBe(false)
    expect(forward?.disabled).toBe(false)
    expect(back?.disabled, 'the row is already at its start').toBe(true)
    act(() => { forward!.click() })
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }))
    expect((scrollBy.mock.calls.at(-1)?.[0] as { left: number }).left).toBeGreaterThan(0)
    // Parked at the far end now: the same pair answers the other way round.
    readEdges({ scrollWidth: 500, clientWidth: 60, scrollLeft: 440 })
    await act(async () => { region()!.dispatchEvent(new Event('scroll')) })
    expect(byName(t('assistant.branch.scroll_forward'))?.disabled).toBe(true)
    act(() => { byName(t('assistant.branch.scroll_back'))!.click() })
    expect((scrollBy.mock.calls.at(-1)?.[0] as { left: number }).left).toBeLessThan(0)
  })

  it('opens the branch that is pressed rather than only naming it', async () => {
    await show('b2')
    act(() => { chips().find((node) => node.textContent === 'Branch one')!.click() })
    expect(openConversationInChat).toHaveBeenCalledWith('b1')
  })
})
