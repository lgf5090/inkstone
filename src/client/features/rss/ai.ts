/**
 * Asking a model about an article, through the account's assistant.
 *
 * These two affordances — a summary, and a translation into the reader's language — used to be
 * answered by whatever endpoint the reader configured, with the key kept in this browser. That made
 * the reader pay for a second model and left "summarise this article in the chat" unable to use it.
 * They now run on the assistant's account model: the same `chat_providers` / `chat_models` rows
 * every chat turn resolves, the same key handling, the same daily ceiling and the same usage meter.
 *
 * Two things stay as they were. The article is sent as text a sanitizer already stripped, not as
 * HTML, because a body full of markup is both more tokens and more ways for a feed to say something
 * to the model than the reader meant; and a reader who typed a key into the old build is told so
 * rather than silently forgotten — the local copy is shown in settings and cleared only on request.
 */

import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { getLocale } from '../../lib/i18n'
import { htmlToText } from './sanitize'
import type { RssEntry, RssFeed } from '@shared/rss/model'

export type RssAiKind = 'summary' | 'translation'

/** How much of an article a request carries. Beyond this the tail is dropped, not summarised badly. */
const ARTICLE_TEXT_CHARS = 12_000
/** What one answer may spend: a translation is longer than a five-bullet summary. */
const SUMMARY_OUTPUT_TOKENS = 900
const TRANSLATION_OUTPUT_TOKENS = 3000
const EXCERPT_OUTPUT_TOKENS = 600
/** The route's own ceiling is a minute, and a long translation has to fit inside it. */
const ONE_SHOT_TIMEOUT_MS = 60_000

/**
 * A key the reader typed into the old build, still on this device.
 *
 * Read only to tell them it exists. Nothing is taken from it, and nothing is deleted without the
 * reader pressing the button in settings.
 */
export interface LegacyRssAi {
  baseURL: string
  model: string
  apiKey: string
}

export async function loadLegacyAiKey(): Promise<LegacyRssAi | null> {
  const stored = await localDb.loadRssAi()
  if (!stored || typeof stored !== 'object') return null
  const value = stored as { baseURL?: unknown; model?: unknown; apiKey?: unknown }
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  if (!apiKey) return null
  return {
    baseURL: typeof value.baseURL === 'string' ? value.baseURL.slice(0, 200) : '',
    model: typeof value.model === 'string' ? value.model.slice(0, 120) : '',
    apiKey,
  }
}

/** Forget the local copy of the old key, on the reader's explicit request. */
export async function clearLegacyAiKey(): Promise<void> {
  await localDb.saveRssAi({ provider: 'deepseek', baseURL: '', apiKey: '', model: '' })
}

/** What the model is asked, in the language the reader's interface is in. */
export function buildPrompts(entry: RssEntry, feed: RssFeed | undefined, kind: RssAiKind, language: 'source' | 'interface'): string[] {
  const text = htmlToText(entry.content || entry.summary, ARTICLE_TEXT_CHARS)
  const target = language === 'interface' ? interfaceLanguageName() : 'the language the article is written in'
  const header = [feed?.title, entry.author, entry.title].filter(Boolean).join(' / ')
  const body = `${header}\n\n${text}`
  if (kind === 'translation') {
    return [
      'You translate articles for a reader who wants to finish them in their own language. Keep every heading, list and code block. Output Markdown only, with no preamble.',
      `Translate the article below into ${target}. Keep code, links and numbers exactly as they are.\n\n${body}`,
    ]
  }
  return [
    'You summarise articles for a reader deciding whether to read them. Output Markdown only: one short paragraph, then three to five bullet points. No preamble, no praise.',
    `Summarise the article below in ${target}.\n\n${body}`,
  ]
}

function interfaceLanguageName(): string {
  return getLocale() === 'zh-CN' ? 'Simplified Chinese' : 'English'
}

/**
 * A question about the passage the reader just marked.
 *
 * The passage comes first and the article around it second, because the reader selected the passage
 * for a reason and the rest of the article is only context. The instruction to say so when the
 * passage does not answer is the whole point: an ungrounded answer to a question about a text is how
 * a reader ends up believing something the author never wrote.
 */
export function buildExcerptPrompts(question: string, excerpt: string, entry: RssEntry, feed: RssFeed | undefined, language: 'source' | 'interface'): string[] {
  const target = language === 'interface' ? interfaceLanguageName() : 'the language the passage is written in'
  const header = [feed?.title, entry.title].filter(Boolean).join(' / ')
  const context = htmlToText(entry.content || entry.summary, 6000)
  return [
    'You answer one question about a passage a reader selected out of an article. Use only the passage and, when it helps, the article around it. If the passage does not answer the question, say so in one sentence and stop. Answer in Markdown with no preamble.',
    `Answer in ${target}.\n\nQuestion: ${question.slice(0, 500)}\n\nPassage:\n${excerpt.slice(0, 4000)}\n\n${header}\n${context}`,
  ]
}

export interface AiRun {
  promise: Promise<string>
  abort: () => void
}

/**
 * One answer through the assistant's one-shot route.
 *
 * The route resolves the reader's active model on the Worker, so this device never holds a provider
 * key for RSS. `onChunk` is kept because every caller already shows a fixed-size pane: the answer
 * arrives in one piece and the pane is told once, which is still better than an unexplained wait.
 */
function askAssistant(system: string, user: string, maxOutputTokens: number, onChunk: (text: string) => void): AiRun {
  const controller = new AbortController()
  const promise = api.assistant.oneShot(
    { system, user, maxOutputTokens, timeoutMs: ONE_SHOT_TIMEOUT_MS },
    { signal: controller.signal },
  ).then((result) => {
    const text = result.text.trim()
    onChunk(text)
    return text
  })
  return { promise, abort: () => controller.abort() }
}

export function runArticleAi(
  entry: RssEntry,
  feed: RssFeed | undefined,
  kind: RssAiKind,
  language: 'source' | 'interface',
  onChunk: (text: string) => void,
): AiRun {
  const [system, user] = buildPrompts(entry, feed, kind, language)
  return askAssistant(system, user, kind === 'translation' ? TRANSLATION_OUTPUT_TOKENS : SUMMARY_OUTPUT_TOKENS, onChunk)
}

export function runExcerptAi(
  entry: RssEntry,
  feed: RssFeed | undefined,
  question: string,
  excerpt: string,
  language: 'source' | 'interface',
  onChunk: (text: string) => void,
): AiRun {
  const [system, user] = buildExcerptPrompts(question, excerpt, entry, feed, language)
  return askAssistant(system, user, EXCERPT_OUTPUT_TOKENS, onChunk)
}
