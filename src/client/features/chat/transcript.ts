/**
 * A selection of turns, written out as one Markdown document.
 *
 * Held apart from the panel that offers it because the text is the part worth pinning: a transcript that
 * drops a speaker's name, or the code fence inside an answer, is not a transcript. The speaker headings
 * are the interface's own words, so they come from the catalog like every other label.
 */

import { api } from '../../lib/api'
import type { AssistantMessage, ChatAttachment } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { fullTime } from '../../lib/time'
import { downloadTextFile, safeFileName } from '../../lib/export-note'

/** What the files a turn carried are called, by id — the metadata rows the thread view is given. */
export type TranscriptAttachments = Record<string, ChatAttachment>

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
 *
 * Exported because a single saved reply needs the same trail and its own bubble is not a document.
 */
export function sourcesMarkdown(message: AssistantMessage): string {
  const list = message.sources ?? []
  if (!list.length) return ''
  const lines = list.map((source, index) => {
    const label = source.title.trim() || source.url
    const target = source.kind === 'note' ? `[[${label}]]` : `[${label}](${source.url})`
    return `${index + 1}. ${target}${source.cited ? ` — ${source.cited}` : ''}`
  })
  return `${t('assistant.chat.sources')}:\n${lines.join('\n')}`
}

/**
 * The files a turn carried, as the links a note can still open.
 *
 * A turn can be all file and no words — a picture dropped in with nothing typed — and a transcript that
 * writes only the body turns that into an empty note with the file gone. So the files are named here,
 * through the same address the chip in the bubble opens: a picture embedded, anything else linked. An id
 * with no metadata row beside it says so rather than vanishing quietly, which is exactly the failure this
 * is here to close.
 *
 * Only drawn when the caller has metadata to give: a transcript written without it keeps saying nothing
 * about files instead of printing a row of bare ids.
 */
function attachmentsMarkdown(message: AssistantMessage, index: TranscriptAttachments): string {
  const ids = message.attachments ?? []
  if (!ids.length) return ''
  const lines = ids.map((id) => {
    const row = index[id]
    if (!row) return `- _${t('assistant.attach.unavailable')}_`
    // Brackets would close the link early, and a filename is whatever the reader's file was called.
    const name = row.filename.replace(/[[\]]/g, '').trim() || t('assistant.attach.unavailable')
    const url = api.assistant.chatFileUrl(id)
    return row.kind === 'image' ? `![${name}](${url})` : `[${name}](${url})`
  })
  return `${t('assistant.chat.attachments')}:\n${lines.join('\n')}`
}

export function transcriptMarkdown(
  messages: readonly AssistantMessage[],
  title: string,
  attachments?: TranscriptAttachments,
): string {
  const parts = messages.map((message) => {
    const text = turn(t(message.role === 'user' ? 'assistant.chat.you' : 'assistant.chat.assistant'), message)
    const cited = message.role === 'assistant' ? sourcesMarkdown(message) : ''
    const files = attachments ? attachmentsMarkdown(message, attachments) : ''
    return [text, cited, files].filter(Boolean).join('\n\n')
  })
  return [`# ${title}`, '', ...parts.flatMap((part) => [part, ''])].join('\n').trimEnd() + '\n'
}

/** Writes the selection to a file the reader can keep. */
export function downloadTranscript(messages: readonly AssistantMessage[], title: string): void {
  const body = transcriptMarkdown(messages, title)
  downloadTextFile(`${safeFileName(title || t('assistant.chat.untitled'))}.md`, body, 'text/markdown;charset=utf-8')
}
