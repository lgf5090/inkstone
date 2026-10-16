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

export function transcriptMarkdown(messages: readonly AssistantMessage[], title: string): string {
  const parts = messages.map((message) => turn(t(message.role === 'user' ? 'assistant.chat.you' : 'assistant.chat.assistant'), message))
  return [`# ${title}`, '', ...parts.flatMap((part) => [part, ''])].join('\n').trimEnd() + '\n'
}

/** Writes the selection to a file the reader can keep. */
export function downloadTranscript(messages: readonly AssistantMessage[], title: string): void {
  const body = transcriptMarkdown(messages, title)
  downloadTextFile(`${safeFileName(title || t('assistant.chat.untitled'))}.md`, body, 'text/markdown;charset=utf-8')
}
