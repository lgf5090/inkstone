// @vitest-environment jsdom
/**
 * The branch bar.
 *
 * A fork copies its turns, so nothing else on screen connects the two threads. What is pinned is that the
 * bar appears exactly when there is something to say — a thread with a parent, or one of several threads
 * forked off the same point — and that each chip is a way into the other thread rather than a label.
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

async function show(conversationId: string | null): Promise<void> {
  await act(async () => {
    root.render(createElement(BranchBar, { conversationId }))
  })
  // The bar reads the tree after it mounts.
  await act(async () => {})
}

const chips = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  conversationBranches.mockReset()
  openConversationInChat.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('the branch bar', () => {
  it('names the thread it came from and offers the other branches', async () => {
    conversationBranches.mockResolvedValue({
      parent: { id: 'main', title: 'Main thread' },
      siblings: [
        { id: 'b1', title: 'Branch one', updatedAt: 1 },
        { id: 'b2', title: 'Branch two', updatedAt: 2 },
      ],
    })
    await show('b2')
    expect(document.body.textContent).toContain(t('assistant.branch.from', { title: 'Main thread' }))
    expect(document.body.textContent).toContain('Branch one')
    // The one being read is marked and cannot be opened again.
    const current = chips().find((node) => node.textContent === 'Branch two')!
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.disabled).toBe(true)
  })

  it('opens the branch that is pressed', async () => {
    conversationBranches.mockResolvedValue({
      parent: null,
      siblings: [
        { id: 'b1', title: 'Branch one', updatedAt: 1 },
        { id: 'b2', title: 'Branch two', updatedAt: 2 },
      ],
    })
    await show('b2')
    act(() => {
      chips().find((node) => node.textContent === 'Branch one')!.click()
    })
    expect(openConversationInChat).toHaveBeenCalledWith('b1')
  })

  it('stays out of the way when there is nothing to say', async () => {
    conversationBranches.mockResolvedValue({ parent: null, siblings: [{ id: 'only', title: 'Only', updatedAt: 1 }] })
    await show('only')
    expect(chips()).toHaveLength(0)
  })

  it('says nothing at all when the tree cannot be read', async () => {
    conversationBranches.mockRejectedValue(new Error('offline'))
    await show('b1')
    expect(document.body.textContent).toBe('')
  })
})
