// @vitest-environment jsdom
/**
 * A conversation embedded in a note.
 *
 * Two things are pinned. The id shape, because a note whose title merely begins with `chat:` must not
 * become a request for a conversation. And the excerpt: messages are rendered as text (never as HTML
 * from the model), the head names the thread, and a conversation longer than the cap says how much it
 * is not showing rather than silently stopping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../i18n'

const { conversation } = vi.hoisted(() => ({
  conversation: vi.fn(async (id: string) => ({
    conversation: { id, title: 'Hiring plan' },
    messages: [
      { id: 'm1', role: 'user', content: 'What did we decide about the loop?' },
      { id: 'm2', role: 'assistant', content: 'Two rounds, then a debrief.' },
    ],
    attachments: [],
    streaming: false,
  })),
}))

vi.mock('../api', () => ({ api: { assistant: { conversation } }, CLIENT_ID: 'test-client', ApiError: class ApiError extends Error {} }))

const { chatEmbedId, renderChatEmbed } = await import('./chat-embed')

function embedBox(): HTMLElement {
  const box = document.createElement('div')
  box.className = 'note-embed loading'
  box.innerHTML = '<span class="note-embed-head" data-embed-target="chat:abc">chat:abc</span><div class="note-embed-body" aria-busy="true">loading</div>'
  return box
}

beforeEach(async () => {
  await initI18n()
  conversation.mockClear()
})

afterEach(() => vi.clearAllMocks())

describe('chatEmbedId', () => {
  it('accepts a conversation id', () => {
    expect(chatEmbedId('chat:01hzzz')).toBe('01hzzz')
    expect(chatEmbedId('  CHAT:abc-123  ')).toBe('abc-123')
  })

  it('leaves anything that is not an id to the note resolver', () => {
    for (const target of ['chat:', 'chat:../../etc', 'chatroom:abc', 'Notes/chat:abc', 'chat:with space', 'Hiring plan'])
      expect(chatEmbedId(target)).toBeNull()
  })
})

describe('renderChatEmbed', () => {
  it('names the conversation in the head and lists its messages as text', async () => {
    const box = embedBox()
    expect(await renderChatEmbed(box, 'abc', null)).toBe('ok')
    expect(box.querySelector('.note-embed-head')!.textContent).toBe('Hiring plan')
    expect(box.querySelectorAll('.chat-embed-message')).toHaveLength(2)
    expect(box.querySelector('.chat-embed-message[data-role="assistant"]')!.textContent).toContain('Two rounds')
    expect(box.classList.contains('ready')).toBe(true)
    // The head opens the thread, but it is not a wikilink: that attribute means "a note by this title".
    expect(box.querySelector('.note-embed-head')!.hasAttribute('data-wikilink')).toBe(false)
    expect(box.querySelector('.note-embed-head')!.getAttribute('role')).toBe('link')
  })

  it('uses the alias when the embed was given one', async () => {
    const box = embedBox()
    await renderChatEmbed(box, 'abc', 'what we said')
    expect(box.querySelector('.note-embed-head')!.textContent).toBe('what we said')
  })

  it('says how much of a long conversation is not shown', async () => {
    conversation.mockResolvedValueOnce({
      conversation: { id: 'abc', title: 'Long' },
      messages: Array.from({ length: 15 }, (_, index) => ({ id: `m${index}`, role: 'user', content: `turn ${index}` })),
      attachments: [],
      streaming: false,
    } as never)
    const box = embedBox()
    await renderChatEmbed(box, 'abc', null)
    expect(box.querySelectorAll('.chat-embed-message')).toHaveLength(12)
    expect(box.querySelector('.chat-embed-more')!.textContent).toContain('3')
  })

  it('reports a conversation that is gone instead of throwing', async () => {
    conversation.mockRejectedValueOnce(new Error('404'))
    const box = embedBox()
    expect(await renderChatEmbed(box, 'abc', null)).toBe('missing')
  })

  it('says so when the thread has nothing in it', async () => {
    conversation.mockResolvedValueOnce({ conversation: { id: 'abc', title: 'Empty' }, messages: [], attachments: [], streaming: false } as never)
    const box = embedBox()
    await renderChatEmbed(box, 'abc', null)
    expect(box.querySelectorAll('.chat-embed-message')).toHaveLength(0)
    expect(box.querySelector('.chat-embed-more')).not.toBeNull()
  })
})
