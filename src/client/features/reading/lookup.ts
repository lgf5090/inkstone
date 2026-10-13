/**
 * Looking a word or a passage up without leaving the page.
 *
 * Two engines, in the order the reader asked for them: the deployment's own translation route, which
 * needs no setup and answers in a few hundred milliseconds; and the AI service the reader already
 * configured, which is slower but reads the sentence and the book title and so can pick the sense that
 * actually fits. When the AI is not configured, or fails, the request falls through to the first one —
 * a translation button that does nothing because a key was never entered is worse than a plain one.
 */
import { streamChatCompletion } from '../../lib/ai/stream-client'
import { useExcalidrawSettingsStore } from '../excalidraw/excalidraw-settings-store'
import { t } from '../../lib/i18n'

export type LookupKind = 'word' | 'passage'

export interface LookupOutcome {
  kind: LookupKind
  source: string
  target: string
  engine: 'google' | 'ai'
  /** A word card has more than one line; a passage is just the translation. */
  notes?: string
}

/** A single word or short phrase, which is what a dictionary answer is for. */
export function classifySelection(text: string): LookupKind {
  const trimmed = text.trim()
  if (!trimmed) return 'passage'
  if (trimmed.length > 64) return 'passage'
  // Full-width stop and sentence punctuation is written as an escape rather than a literal so the
  // language gate, which forbids Han copy in components, still lets this classifier see it.
  if (/[\n.!?\u3002\uFF01\uFF1F,;:]/.test(trimmed)) return 'passage'
  const words = trimmed.split(/\s+/).length
  if (words > 3) return 'passage'
  return 'word'
}

/** How long the card waits for the relay before it says so. The worker's own upstream has no deadline. */
const TRANSLATE_TIMEOUT_MS = 12_000

export async function translateViaDeployment(text: string, to: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch('/api/reading/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Inkstone-Client': '1' },
      body: JSON.stringify({ text, to }),
      signal: combined,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(t('reading.translate_timeout'))
  }
  if (!response.ok) {
    let message = t('reading.translate_failed')
    try {
      const body = await response.json() as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // A non-JSON failure still means "no translation", which is what the card shows.
    }
    throw new Error(message)
  }
  const body = await response.json() as { translated?: string }
  return (body.translated ?? '').trim()
}

/**
 * The reader's configured AI service, if there is one.
 *
 * This is the app's existing provider configuration rather than a second copy of it: a key stored twice
 * is a key that can be revoked in one place and still live in the other.
 */
function aiModel(): string | null {
  const settings = useExcalidrawSettingsStore.getState()
  if (!settings.aiEnabled) return null
  const config = settings.aiDefaultProvider ? settings.aiProviders[settings.aiDefaultProvider] : undefined
  if (!config?.apiKey) return null
  return settings.aiDefaultTextModel || 'deepseek-flash'
}

export async function lookupSelection(
  text: string,
  options: { to: string; engine: 'google' | 'ai'; bookTitle: string; sentence?: string; signal?: AbortSignal },
): Promise<LookupOutcome> {
  const kind = classifySelection(text)
  const model = options.engine === 'ai' ? aiModel() : null
  if (model) {
    const settings = useExcalidrawSettingsStore.getState()
    const providerConfig = settings.aiDefaultProvider ? settings.aiProviders[settings.aiDefaultProvider] : undefined
    if (providerConfig) {
      const system = kind === 'word'
        ? 'You are a dictionary for a reader. Given one word or phrase, answer in at most five short lines: '
          + 'the pronunciation if it is not the reader\'s language, the meaning in this sentence, the common '
          + 'meanings, one usage note, and one example. Reply in the language code '
          + `${options.to}. No markdown headings, no preamble.`
        : `Translate the reader's text into ${options.to}. Reply with the translation only.`
      const context = kind === 'word' && options.sentence
        ? `Book: ${options.bookTitle}\nSentence: ${options.sentence}\nWord: ${text}`
        : text
      try {
        const result = await streamChatCompletion(
          [{ id: 'lookup', role: 'user', content: context }],
          providerConfig,
          {
            systemPrompt: system,
            model,
            maxTokens: 512,
            temperature: 0.2,
            signal: options.signal,
          },
        )
        const answer = result.content.trim()
        if (answer) {
          const [first, ...rest] = answer.split('\n')
          return {
            kind,
            source: text,
            target: first ?? '',
            notes: rest.join('\n').trim() || undefined,
            engine: 'ai',
          }
        }
      } catch {
        // Fall through to the deployment's own route rather than failing the button.
      }
    }
  }
  const translated = await translateViaDeployment(text, options.to, options.signal)
  return { kind, source: text, target: translated, engine: 'google' }
}

/**
 * One entry in the reader's word list.
 *
 * Written as a definition-list style block so a spaced-repetition tool can read it later without this
 * app having to own a reviewer.
 */
export function vocabularyEntry(input: {
  word: string
  translation: string
  sentence: string
  bookTitle: string
  link: string
}): string {
  const lines = [`### ${input.word}`, '', input.translation, '']
  if (input.sentence) lines.push(`> ${input.sentence.replace(/\n+/g, ' ')}`)
  lines.push(`> — [${input.bookTitle}](${input.link})`, '')
  return lines.join('\n')
}

/** The note title the vocabulary list is filed under. */
export function vocabularyTitle(): string {
  return t('reading.vocabulary_note_title')
}
