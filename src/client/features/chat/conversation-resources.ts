/**
 * What one conversation has accumulated, as lists a monitor can draw.
 *
 * The transcript is the source of truth: links are read from the words, notes from the tools that named
 * them, sources from the citations stored on answers, and attachments from the files the messages carry.
 * A resource that cannot be opened is left out — a link the reader cannot follow and a note id that does
 * not resolve are worse than an empty section.
 */
import type { AssistantMessage, AssistantSource, ChatAttachment, ToolActivity } from '@shared/assistant'
import { isSourceUrl } from '@shared/assistant'
import { isNoteId, noteRefsFromToolResult, type NoteRef } from './note-refs'

export interface ResourceLink {
  url: string
}

export interface ResourceTool {
  name: string
  count: number
  errors: number
  running: number
}

export interface ConversationResourceIndex {
  links: ResourceLink[]
  images: ChatAttachment[]
  documents: ChatAttachment[]
  notes: NoteRef[]
  sources: AssistantSource[]
  tools: ResourceTool[]
  tokens: { input: number, output: number }
  models: string[]
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi
const NOTE_MENTION = /\[\[([0-9a-hjkmnp-tv-z]{26})(?:\|([^\]]+))?\]\]/g
const TRIM_AFTER_URL = /[)\].,;:!?]+$/

function linksIn(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRIM_AFTER_URL, '')
    if (url.length > 2048) continue
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      out.push(url)
    } catch {
      // A shape that is not an address is not a link; the words remain as they were written.
    }
  }
  return out
}

/** The whole thread's resources, or an empty index when there is nothing to show. */
export function conversationResources(
  messages: readonly AssistantMessage[],
  attachments: readonly ChatAttachment[],
  liveTools: readonly ToolActivity[] = [],
  extraAttachmentIds: readonly string[] = [],
): ConversationResourceIndex {
  const links = new Map<string, ResourceLink>()
  const notes = new Map<string, NoteRef>()
  const sources = new Map<string, AssistantSource>()
  const tools = new Map<string, ResourceTool>()
  const seenTools = new Set<string>()
  const models: string[] = []
  let input = 0
  let output = 0

  const addNote = (note: NoteRef): void => {
    if (!note.id || !isNoteId(note.id)) return
    const existing = notes.get(note.id)
    if (!existing || (existing.title === 'Untitled' && note.title !== 'Untitled')) notes.set(note.id, note)
  }

  for (const message of messages) {
    if (message.modelLabel && !models.includes(message.modelLabel)) models.push(message.modelLabel)
    input += message.usage?.inputTokens ?? 0
    output += message.usage?.outputTokens ?? 0

    for (const source of message.sources ?? []) {
      if (source.kind === 'note' && source.id && isNoteId(source.id)) {
        addNote({ id: source.id, title: source.title || 'Untitled' })
        continue
      }
      if (!isSourceUrl(source.url)) continue
      if (!sources.has(source.url)) sources.set(source.url, source)
    }

    for (const match of message.content.matchAll(NOTE_MENTION)) {
      const id = match[1]
      if (!id) continue
      addNote({ id, title: match[2]?.trim() || 'Untitled' })
    }

    for (const url of linksIn(message.content)) {
      if (sources.has(url)) continue
      if (!links.has(url)) links.set(url, { url })
    }

    for (const tool of message.tools) {
      if (seenTools.has(tool.id)) continue
      seenTools.add(tool.id)
      for (const note of noteRefsFromToolResult(tool.name, tool.result)) addNote(note)
      const group = tools.get(tool.name) ?? { name: tool.name, count: 0, errors: 0, running: 0 }
      group.count++
      if (tool.status === 'error') group.errors++
      if (tool.status === 'running') group.running++
      tools.set(tool.name, group)
    }
  }

  // A live turn is not a message yet. Its calls share ids with the row that will replace them, so the
  // set above is what keeps a settled call from being counted twice while the transcript catches up.
  for (const tool of liveTools) {
    if (seenTools.has(tool.id)) continue
    seenTools.add(tool.id)
    const group = tools.get(tool.name) ?? { name: tool.name, count: 0, errors: 0, running: 0 }
    group.count++
    if (tool.status === 'error') group.errors++
    if (tool.status === 'running') group.running++
    tools.set(tool.name, group)
    for (const note of noteRefsFromToolResult(tool.name, tool.result)) addNote(note)
  }

  const referenced = new Set([...messages.flatMap((message) => message.attachments ?? []), ...extraAttachmentIds])
  const carried = attachments
    .filter((attachment) => referenced.has(attachment.id))
    .sort((left, right) => right.createdAt - left.createdAt)
  const uniqueAttachments = [...new Map(carried.map((attachment) => [attachment.id, attachment])).values()]

  return {
    // A URL that an answer also cited is a source rather than a second row in the links list, whichever
    // order the answer and its citation arrived in.
    links: [...links.values()].filter((link) => !sources.has(link.url)),
    images: uniqueAttachments.filter((attachment) => attachment.kind === 'image'),
    documents: uniqueAttachments.filter((attachment) => attachment.kind !== 'image'),
    notes: [...notes.values()],
    sources: [...sources.values()],
    tools: [...tools.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    tokens: { input, output },
    models,
  }
}
