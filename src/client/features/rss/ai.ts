/**
 * Asking a model about an article, on the reader's own key.
 *
 * The reference reader this port follows got its Chinese rewrites from the service that publishes
 * the feeds, which is a reasonable design for a hosted product and an impossible one for a notebook
 * that must work without an account. Here the same two affordances — a summary, and a translation
 * into the reader's language — are offered against whatever endpoint the reader configures, so the
 * feature is off until they ask for it and costs nothing they did not choose.
 *
 * Two things are deliberate. The key is stored in this browser and never in the account row, so it
 * does not ride along in a backup or appear on another device the reader did not type it into; and
 * the article is sent as text a sanitizer already stripped, not as HTML, because a body full of
 * markup is both more tokens and more ways to say something to the model than the reader meant.
 */
import type { AIProvider } from '../../lib/ai'
import { streamChatCompletion } from '../../lib/ai'
import { localDb } from '../../lib/db'
import { getLocale } from '../../lib/i18n'
import { htmlToText } from './sanitize'
import type { RssEntry, RssFeed } from '@shared/rss/model'

export interface RssAiConfig {
  provider: AIProvider
  baseURL: string
  apiKey: string
  model: string
}

export type RssAiKind = 'summary' | 'translation'

const EMPTY: RssAiConfig = { provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' }

/** How much of an article a request carries. Beyond this the tail is dropped, not summarised badly. */
const ARTICLE_TEXT_CHARS = 12_000

export async function loadAiConfig(): Promise<RssAiConfig> {
  const stored = await localDb.loadRssAi()
  if (!stored || typeof stored !== 'object') return { ...EMPTY }
  const value = stored as Partial<RssAiConfig>
  return {
    provider: typeof value.provider === 'string' ? (value.provider as AIProvider) : EMPTY.provider,
    baseURL: typeof value.baseURL === 'string' ? value.baseURL.slice(0, 200) : EMPTY.baseURL,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 300) : '',
    model: typeof value.model === 'string' ? value.model.slice(0, 120) : EMPTY.model,
  }
}

export async function saveAiConfig(config: RssAiConfig): Promise<void> {
  await localDb.saveRssAi({
    provider: config.provider,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
  })
}

/** The provider a base URL belongs to, read from the address rather than asked for. */
export function providerForBaseUrl(baseUrl: string): AIProvider {
  const host = baseUrl.toLowerCase()
  if (host.includes('anthropic')) return 'anthropic'
  if (host.includes('openai')) return 'openai'
  if (host.includes('deepseek')) return 'deepseek'
  if (host.includes('generativelanguage')) return 'google'
  if (host.includes('x.ai')) return 'xai'
  return 'openai-compatible'
}

export function aiReady(config: RssAiConfig): boolean {
  return Boolean(config.apiKey.trim() && config.model.trim() && config.baseURL.trim())
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

/** One answer about a passage. Same relay, same key, same abort as the whole-article asks. */
export function runExcerptAi(
  entry: RssEntry,
  feed: RssFeed | undefined,
  question: string,
  excerpt: string,
  config: RssAiConfig,
  language: 'source' | 'interface',
  onChunk: (text: string) => void,
): AiRun {
  const controller = new AbortController()
  const [system, user] = buildExcerptPrompts(question, excerpt, entry, feed, language)
  const promise = streamChatCompletion(
    [{ id: 'system', role: 'system', content: system }, { id: 'user', role: 'user', content: user }],
    config,
    { model: config.model, systemPrompt: undefined, signal: controller.signal, onChunk: (_chunk, full) => onChunk(full) },
  ).then(result => result.content.trim())
  return { promise, abort: () => controller.abort() }
}

export interface AiRun {
  promise: Promise<string>
  abort: () => void
}

/**
 * Stream one answer.
 *
 * `onChunk` is what keeps a twenty-second summary from reading as a hang, and the abort signal is
 * what lets the reader stop one they no longer want — both go through the same relay the editor's
 * AI features use, so the key never leaves for the provider by a second path.
 */
export function runArticleAi(
  entry: RssEntry,
  feed: RssFeed | undefined,
  kind: RssAiKind,
  config: RssAiConfig,
  language: 'source' | 'interface',
  onChunk: (text: string) => void,
): AiRun {
  const controller = new AbortController()
  const [system, user] = buildPrompts(entry, feed, kind, language)
  const promise = streamChatCompletion(
    [{ id: 'system', role: 'system', content: system }, { id: 'user', role: 'user', content: user }],
    config,
    {
      model: config.model,
      systemPrompt: undefined,
      signal: controller.signal,
      onChunk: (_chunk, full) => onChunk(full),
    },
  ).then(result => result.content.trim())
  return { promise, abort: () => controller.abort() }
}
