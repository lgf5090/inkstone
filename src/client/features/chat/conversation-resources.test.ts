/**
 * The resource index behind the session panel.
 *
 * The cases that matter are the boundaries between sections: a cited URL is a source, not a second link;
 * a note named by a tool or a mention is a note the reader can open; a file the messages never reference
 * is not this conversation's file; and a live tool is not counted twice once its row lands.
 */
import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ChatAttachment } from '@shared/assistant'
import { conversationResources } from './conversation-resources'

const NOTE_A = '01hzzzzzzzzzzzzzzzzzzzzz20'
const NOTE_B = '01hzzzzzzzzzzzzzzzzzzzzz21'
const NOTE_C = '01hzzzzzzzzzzzzzzzzzzzzz22'

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1', conversationId: 'c1', role: 'user', content: '', tools: [], status: 'complete', error: null,
    createdAt: 1, source: 'chat', ...over,
  }
}

function attachment(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'a1', kind: 'image', filename: 'plot.png', mime: 'image/png', size: 2048, key: 'chat/images/a1.png',
    createdAt: 1, ...over,
  }
}

describe('the conversation resource index', () => {
  it('separates links from cited sources, and notes from mentions and tool results', () => {
    const messages = [
      message({
        content: `See https://example.com/a, https://deepseek.com/x. Also [[${NOTE_A}|Plan]] and https://cited.test/page.`,
        attachments: ['a1', 'a2'],
      }),
      message({
        id: 'm2', role: 'assistant', modelLabel: 'deepseek-chat', usage: { inputTokens: 20, outputTokens: 6 },
        content: 'Answer',
        sources: [
          { url: 'https://cited.test/page', title: 'Cited page', cited: 'a passage' },
          { kind: 'note', id: NOTE_B, title: 'Source note', url: '' },
        ],
        tools: [
          { id: 't1', name: 'search_notes', status: 'success', result: JSON.stringify({ notes: [{ id: NOTE_C, title: 'Found note' }] }) },
          { id: 't2', name: 'web_search', status: 'error', error: 'denied' },
        ],
      }),
    ]
    const index = conversationResources(messages, [
      attachment(),
      attachment({ id: 'a2', kind: 'file', filename: 'brief.pdf', mime: 'application/pdf' }),
      attachment({ id: 'orphan', filename: 'unused.png' }),
    ])

    expect(index.links.map((link) => link.url).sort()).toEqual(['https://deepseek.com/x', 'https://example.com/a'])
    expect(index.sources.map((source) => source.url)).toEqual(['https://cited.test/page'])
    expect(index.notes.map((note) => note.id).sort()).toEqual([NOTE_A, NOTE_B, NOTE_C].sort())
    expect(index.images.map((entry) => entry.id)).toEqual(['a1'])
    expect(index.documents.map((entry) => entry.filename)).toEqual(['brief.pdf'])
    expect(index.tokens).toEqual({ input: 20, output: 6 })
    expect(index.models).toEqual(['deepseek-chat'])
    expect(index.tools).toEqual([
      { name: 'search_notes', count: 1, errors: 0, running: 0 },
      { name: 'web_search', count: 1, errors: 1, running: 0 },
    ])
  })

  it('counts a live tool once, and includes a live attachment that has no message yet', () => {
    const messages = [message({ attachments: ['a1'] })]
    const live = [{ id: 't1', name: 'read_note', status: 'running' as const, result: JSON.stringify({ note_id: NOTE_C, title: 'Live note' }) }]
    const index = conversationResources(messages, [attachment(), attachment({ id: 'live', kind: 'file', filename: 'live.txt' })], live, ['live'])

    expect(index.tools).toEqual([{ name: 'read_note', count: 1, errors: 0, running: 1 }])
    expect(index.notes.map((note) => note.id)).toEqual([NOTE_C])
    expect(index.documents.map((entry) => entry.id)).toEqual(['live'])
  })

  it('leaves out a source with no address and a link that is not an address', () => {
    const index = conversationResources([
      message({
        content: 'not a link: ftp://example.com and https://',
        sources: [{ url: 'ftp://example.com', title: 'Bad' }],
      }),
    ], [])
    expect(index.links).toEqual([])
    expect(index.sources).toEqual([])
  })
})
