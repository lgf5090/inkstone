/**
 * `![[chat:<id>]]` — a conversation, read-only, inside a note.
 *
 * The other half of "a reply can be saved into a note" (P1-12's canvas, and the message menu): a note
 * that argues with a conversation should be able to show the conversation, not paraphrase it. The embed
 * is a *view*: the thread is not copied into the note, so it stays one thread — editing the note does not
 * fork it, and deleting the note does not delete it.
 *
 * What is shown is an excerpt, not the whole transcript, and the rule for picking it is
 * {@link embedExcerpt}: the last completed answer and the turns that led to it. The head names the
 * conversation and opens it.
 */
import type { AssistantMessage } from '@shared/assistant'
import { api } from '../api'
import { t } from '../i18n'

/** The scheme is lowercase and fixed, so a note that merely starts with "Chat:" is still a note. */
const PREFIX = 'chat:'

/** How much of a conversation a note shows, and how much of each message. */
const MAX_MESSAGES = 12
const MAX_CHARS = 1_200

/**
 * The conversation id an embed target names, or null when it is not a conversation embed.
 *
 * Ids reach the DOM and then a URL, so the shape is checked here rather than trusted: anything that is
 * not the id alphabet is a note whose title happens to start with `chat:`, and is left to the note
 * resolver.
 */
export function chatEmbedId(target: string): string | null {
  const value = target.trim()
  if (!value.toLowerCase().startsWith(PREFIX)) return null
  const id = value.slice(PREFIX.length).trim()
  return isChatEmbedId(id) ? id : null
}

/**
 * Whether a value is shaped like a conversation id.
 *
 * The embed resolves ids out of note text, and the chat's own actions build `![[chat:<id>]]` from the
 * id they hold; one alphabet for both is what keeps a stored note from pointing at an embed the
 * renderer would draw as broken.
 */
export function isChatEmbedId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function clip(text: string): string {
  const body = text.trim()
  return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…` : body
}

/** The window a note shows, and where it sits in the thread it came from. */
export interface EmbedExcerpt {
  turns: AssistantMessage[]
  /** The 1-based number of the first turn shown, so a row's label can name its real place. */
  startsAt: number
}

/**
 * Which turns of a conversation an embed shows.
 *
 * The rule, because "which part of a two-hundred-turn thread is this note showing" must not be a guess:
 * the **last completed answer**, taken together with the turns that led up to it. Two things make that
 * end the defensible one. The server hands back the newest page of the thread oldest-first, so the head
 * of what arrives can be a hundred turns before the answer — slicing from it showed the opening question
 * of a run whose point was its conclusion. And a note that embeds a conversation quotes what the
 * conversation settled on, not how it started.
 *
 * The window is then trimmed so it never *opens* on an answer whose question fell outside it, and turns
 * after the chosen answer are left out: an excerpt beginning mid-dialogue is a floating fragment, and a
 * question the thread has not answered yet says nothing about what the note is referring to. A thread
 * with no completed answer in it — every row failed, or only the reader has spoken — falls back to its
 * last turns rather than showing nothing.
 */
export function embedExcerpt(messages: readonly AssistantMessage[], limit = MAX_MESSAGES): EmbedExcerpt {
  let end = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    // Anything that is not a refusal or a stopped turn counts as an answer — including a row written
    // before the status column existed. An error the model raised is not what a note means to quote.
    const answered = message.status !== 'error' && message.status !== 'cancelled'
    if (message.role === 'assistant' && message.content.trim() !== '' && answered) {
      end = index + 1
      break
    }
  }
  let start = Math.max(0, end - limit)
  if (start > 0 && messages[start]!.role === 'assistant') start += 1
  return { turns: messages.slice(start, end), startsAt: start + 1 }
}

/**
 * Fill one embed box with the conversation it names.
 *
 * `missing` rather than an exception when the thread is gone: a deleted conversation is a thing the
 * reader can be told about, and a note that pointed at it is not broken — it is out of date.
 */
export async function renderChatEmbed(embed: HTMLElement, id: string, alias: string | null): Promise<'ok' | 'missing'> {
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  const head = embed.querySelector<HTMLElement>('.note-embed-head')
  if (!body) return 'missing'
  let payload: Awaited<ReturnType<typeof api.assistant.conversation>>
  try {
    // The embed draws the conversation, so it reads the whole of it rather than the newest page: a
    // box that silently stopped at sixty turns would misrepresent the thread it claims to show.
    payload = await api.assistant.conversation(id, { limit: '200' })
  } catch {
    return 'missing'
  }
  const turns: AssistantMessage[] = payload.messages.filter((message) => message.content.trim() !== '')
  const excerpt = embedExcerpt(turns)
  const messages = excerpt.turns
  if (head) {
    head.textContent = alias || payload.conversation.title || t('markdown.chat_embed_label')
    // Not `data-wikilink`: that attribute means "open a note by this title", and the title here is a
    // conversation id. The click is handled here instead.
    head.setAttribute('role', 'link')
    head.setAttribute('tabindex', '0')
    head.setAttribute('aria-label', t('markdown.chat_embed_open', { title: payload.conversation.title || t('markdown.chat_embed_label') }))
    const open = () => {
      void import('../../features/chat/start-chat').then((module) => module.openConversationInChat(id))
    }
    head.addEventListener('click', (event) => {
      event.stopPropagation()
      open()
    })
    head.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      open()
    })
  }
  const list = document.createElement('ol')
  list.className = 'chat-embed'
  const openAt = (messageId: string) => {
    void import('../../features/chat/start-chat').then((module) => module.openConversationInChat(id, messageId))
  }
  // The window is what {@link embedExcerpt} picked: the last completed answer and the turns before it, so
  // a long thread is quoted from the end the note is arguing with rather than from its opening question.
  for (const [index, message] of messages.entries()) {
    const item = document.createElement('li')
    item.className = 'chat-embed-message'
    item.dataset.role = message.role
    const author = document.createElement('span')
    author.className = 'chat-embed-author'
    // The head opens the thread; the label opens the turn. A note quoting one exchange is usually
    // arguing with that exchange, and landing at the top of a two-hundred-turn thread makes the reader
    // hunt for the sentence the note was about. The number is the turn's own place in the thread, not
    // its place in the window, or a row three turns from the end would open the third.
    author.setAttribute('role', 'link')
    author.setAttribute('tabindex', '0')
    author.setAttribute('aria-label', t('markdown.chat_embed_open_at', { index: excerpt.startsAt + index }))
    author.textContent = `${message.role === 'user' ? t('markdown.chat_embed_you') : t('markdown.chat_embed_assistant')} ↗`
    author.addEventListener('click', (event) => {
      event.stopPropagation()
      openAt(message.id)
    })
    author.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      openAt(message.id)
    })
    const text = document.createElement('p')
    text.textContent = clip(message.content)
    item.append(author, text)
    list.append(item)
  }
  const hidden = turns.length - messages.length
  if (hidden > 0) {
    const more = document.createElement('li')
    more.className = 'chat-embed-more'
    more.textContent = t('markdown.chat_embed_more', { count: hidden })
    list.append(more)
  }
  if (messages.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'chat-embed-more'
    empty.textContent = t('markdown.chat_embed_empty')
    body.replaceChildren(empty)
  } else {
    body.replaceChildren(list)
  }
  body.removeAttribute('aria-busy')
  embed.classList.remove('loading', 'error')
  embed.classList.add('ready')
  return 'ok'
}
