/**
 * A selection of turns, written out as one Markdown document.
 *
 * Held apart from the panel that offers it because the text is the part worth pinning: a transcript that
 * drops a speaker's name, or the code fence inside an answer, is not a transcript. The speaker headings
 * are the interface's own words, so they come from the catalog like every other label.
 */

import type { AssistantMessage } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { fullTime } from '../../lib/time'
import { downloadTextFile, safeFileName } from '../../lib/export-note'

/** One speaker's turn, in the shape a reader would write it down. */
function turn(label: string, message: AssistantMessage): string {
  const when = fullTime(message.createdAt)
  const body = message.content.trim() || (message.error ? `_${message.error}_` : '')
  return `**${label}** · ${when}\n\n${body}`
}

/**
 * What an answer was built on, written out under it.
 *
 * A transcript without them is a document that makes claims and drops the evidence: the reader who
 * saves a conversation as a note gets the words but not the pages or notes they came from. A note
 * citation becomes a wikilink, because the vault resolves titles and a note in the same vault is one
 * click away; a web citation stays a link, because it leaves the app.
 */
function sources(message: AssistantMessage): string {
  const list = message.sources ?? []
  if (!list.length) return ''
  const lines = list.map((source, index) => {
    const label = source.title.trim() || source.url
    const target = source.kind === 'note' ? `[[${label}]]` : `[${label}](${source.url})`
    return `${index + 1}. ${target}${source.cited ? ` — ${source.cited}` : ''}`
  })
  return `${t('assistant.chat.sources')}:\n${lines.join('\n')}`
}

export function transcriptMarkdown(messages: readonly AssistantMessage[], title: string): string {
  const parts = messages.map((message) => {
    const text = turn(t(message.role === 'user' ? 'assistant.chat.you' : 'assistant.chat.assistant'), message)
    const cited = message.role === 'assistant' ? sources(message) : ''
    return cited ? `${text}\n\n${cited}` : text
  })
  return [`# ${title}`, '', ...parts.flatMap((part) => [part, ''])].join('\n').trimEnd() + '\n'
}

/** Writes the selection to a file the reader can keep. */
export function downloadTranscript(messages: readonly AssistantMessage[], title: string): void {
  const body = transcriptMarkdown(messages, title)
  downloadTextFile(`${safeFileName(title || t('assistant.chat.untitled'))}.md`, body, 'text/markdown;charset=utf-8')
}
