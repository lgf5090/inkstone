// @vitest-environment jsdom
/**
 * A conversation embedded in a note.
 *
 * Two things are pinned. The id shape, because a note whose title merely begins with `chat:` must not
 * become a request for a conversation. And the excerpt: the rule for which turns a note shows is the
 * last completed answer plus the turns that led to it, so a long thread is quoted from the end the note
 * is arguing with rather than from its opening question — and a window that would begin mid-dialogue
 * begins on the question instead. Messages are rendered as text (never as HTML from the model), the head
 * names the thread, and a conversation longer than the window says how much it is not showing rather
 * than silently stopping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
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

const { chatEmbedId, embedExcerpt, renderChatEmbed } = await import('./chat-embed')

/** One turn of a thread, in the shape the route answers with. */
function row(role: 'user' | 'assistant', content: string, status: 'complete' | 'error' | 'cancelled' = 'complete'): AssistantMessage {
  return {
    id: `${role}-${content}`,
    conversationId: 'abc',
    role,
    content,
    tools: [],
    attachments: [],
    status,
    error: null,
    createdAt: 1,
    source: 'chat',
  }
}

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

/**
 * Which turns of a thread a note gets to see.
 *
 * A two-hundred-turn thread arrives as its *newest* page, oldest first, so slicing from the head of what
 * came back showed the opening question of a run whose point was its conclusion. The rule these cases
 * pin is the other end: the last completed answer, with the exchange that led to it.
 */
describe('embedExcerpt', () => {
  it('ends on the last completed answer, and leaves a question the thread has not answered out of it', () => {
    const turns = [row('user', 'Q1'), row('assistant', 'A1'), row('user', 'Q2'), row('assistant', 'A2'), row('user', 'and then they asked again')]
    const excerpt = embedExcerpt(turns)
    expect(excerpt.turns.map((message) => message.content)).toEqual(['Q1', 'A1', 'Q2', 'A2'])
    expect(excerpt.startsAt).toBe(1)
  })

  it('does not quote a turn that errored as if it were the answer', () => {
    const turns = [row('user', 'Q1'), row('assistant', 'A1'), row('user', 'Q2'), row('assistant', 'the model refused', 'error')]
    expect(embedExcerpt(turns).turns.map((message) => message.content)).toEqual(['Q1', 'A1'])
  })

  it('takes the window from the end of a long thread', () => {
    const turns = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? row('user', `q${index}`) : row('assistant', `a${index}`)))
    const excerpt = embedExcerpt(turns, 6)
    expect(excerpt.turns.map((message) => message.content)).toEqual(['q54', 'a55', 'q56', 'a57', 'q58', 'a59'])
    expect(excerpt.startsAt).toBe(55)
  })

  it('opens the window on a question, never on an answer whose question fell outside it', () => {
    const turns = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? row('user', `q${index}`) : row('assistant', `a${index}`)))
    // Three turns ending at `a59` would have to begin at `a57`; it is dropped with its question.
    const excerpt = embedExcerpt(turns, 3)
    expect(excerpt.turns.map((message) => message.content)).toEqual(['q58', 'a59'])
    expect(excerpt.startsAt).toBe(59)
  })

  it('falls back to the last turns when the thread has no completed answer in it', () => {
    const turns = Array.from({ length: 15 }, (_, index) => row('user', `turn ${index}`))
    const excerpt = embedExcerpt(turns, 12)
    expect(excerpt.turns).toHaveLength(12)
    expect(excerpt.startsAt).toBe(4)
    expect(excerpt.turns[0]?.content).toBe('turn 3')
  })
})

describe('a long conversation in a note', () => {
  it('shows the answer the note is quoting, and numbers its turns where they really are', async () => {
    const turns = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? row('user', `question ${index}`) : row('assistant', `answer ${index}`)))
    conversation.mockResolvedValueOnce({ conversation: { id: 'abc', title: 'Long' }, messages: turns, attachments: [], streaming: false } as never)
    const box = embedBox()
    await renderChatEmbed(box, 'abc', null)

    const items = [...box.querySelectorAll('.chat-embed-message')]
    expect(items).toHaveLength(12)
    // The head of what the route returned is a hundred turns before the answer; it is not what the note
    // is showing, and the reader should not be able to mistake it for that.
    expect(items[0]?.textContent).toContain('question 48')
    expect(items[0]?.textContent).not.toContain('question 1')
    expect(items.at(-1)?.textContent).toContain('answer 59')
    // The turn the row opens is the turn in the thread, not the row in the window.
    expect(items[0]?.querySelector('.chat-embed-author')?.getAttribute('aria-label')).toBe('Open message 49 in the conversation')
    expect(box.querySelector('.chat-embed-more')?.textContent).toContain('48')
  })
})
