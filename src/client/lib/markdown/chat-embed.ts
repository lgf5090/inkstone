/**
 * `![[chat:<id>]]` — a conversation, read-only, inside a note.
 *
 * The other half of "a reply can be saved into a note" (P1-12's canvas, and the message menu): a note
 * that argues with a conversation should be able to show the conversation, not paraphrase it. The embed
 * is a *view*: the thread is not copied into the note, so it stays one thread — editing the note does not
 * fork it, and deleting the note does not delete it.
 *
 * What is shown is an excerpt, not the whole transcript. A note is read, not scrolled: the opening
 * messages are what the note is referring to, and a conversation of two hundred turns would bury the
 * reader's own paragraph. The head names the conversation and opens it.
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
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
}

function clip(text: string): string {
  const body = text.trim()
  return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…` : body
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
    payload = await api.assistant.conversation(id)
  } catch {
    return 'missing'
  }
  const messages: AssistantMessage[] = payload.messages.filter((message) => message.content.trim() !== '')
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
  for (const message of messages.slice(0, MAX_MESSAGES)) {
    const item = document.createElement('li')
    item.className = 'chat-embed-message'
    item.dataset.role = message.role
    const author = document.createElement('span')
    author.className = 'chat-embed-author'
    author.textContent = message.role === 'user' ? t('markdown.chat_embed_you') : t('markdown.chat_embed_assistant')
    const text = document.createElement('p')
    text.textContent = clip(message.content)
    item.append(author, text)
    list.append(item)
  }
  if (messages.length > MAX_MESSAGES) {
    const more = document.createElement('li')
    more.className = 'chat-embed-more'
    more.textContent = t('markdown.chat_embed_more', { count: messages.length - MAX_MESSAGES })
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
