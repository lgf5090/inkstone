// @vitest-environment jsdom
/**
 * The share panel, narrowed to some of a thread.
 *
 * The panel is the one place the scope could be dropped between the ticks and the request: the reader
 * picks two turns, and if the panel asks the worker for the thread's own link instead, the link they send
 * shows everything. So what is pinned is the scope on the wire — what the panel reads, what it writes, and
 * what it says out loud before the link exists.
 *
 * The rest of the panel — the passcode ladder, the expiry, the copy — is the notes side's and is not
 * exercised again here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ConversationSharePanel } from './ConversationSharePanel'

const { conversationShare, createConversationShare, removeConversationShare } = vi.hoisted(() => ({
  conversationShare: vi.fn(async () => ({ share: null })),
  createConversationShare: vi.fn(async () => ({
    share: { slug: 'slug', url: 'https://notes.test/c/slug', hasPassword: false, expiresAt: null, views: 0, createdAt: 1 },
  })),
  removeConversationShare: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { assistant: { conversationShare, createConversationShare, removeConversationShare } },
}))

let root: Root
let host: HTMLElement

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  conversationShare.mockClear()
  createConversationShare.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function show(messageIds: string[] = []): Promise<void> {
  await act(async () => {
    root.render(createElement(ConversationSharePanel, {
      conversationId: 'c1',
      title: 'Planning',
      messageIds,
      onClose: () => {},
    }))
  })
}

const button = (label: string) => [...document.body.querySelectorAll('button')]
  .find((node) => node.textContent?.includes(label))

describe('the panel a narrowed link is made in', () => {
  it('asks about the thread\'s own link when nothing was picked', async () => {
    await show()
    // No scope on the wire at all, so the everyday entry makes the request it always made.
    expect(conversationShare).toHaveBeenCalledWith('c1', [])
    expect(document.body.textContent).toContain(t('assistant.share.title'))
    expect(document.body.textContent).not.toContain(t('assistant.share.title_picked'))
  })

  it('asks about the picked turns, and says which ones are in the link', async () => {
    await show(['m1', 'm2'])
    expect(conversationShare).toHaveBeenCalledWith('c1', ['m1', 'm2'])
    expect(document.body.textContent).toContain(t('assistant.share.title_picked'))
    // Said before the link exists: a reader who thinks this is the whole thread has sent more than they
    // meant to, and finding out afterwards is too late.
    expect(document.body.textContent).toContain(t('assistant.share.picked_scope', { count: 2 }))
  })

  it('creates the link for exactly the turns it is showing', async () => {
    await show(['m1', 'm2'])
    const create = button(t('share.generate_public_link'))
    expect(create).toBeTruthy()
    await act(async () => { create!.click() })
    expect(createConversationShare).toHaveBeenCalledWith('c1', expect.objectContaining({ messageIds: ['m1', 'm2'] }))
  })
})
