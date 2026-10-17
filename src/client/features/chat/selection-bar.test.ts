// @vitest-environment jsdom
/**
 * A selection written out as a document.
 *
 * The text is the part worth pinning: a transcript that loses a speaker, or the fence around an answer's
 * code, is not the thing the reader asked to keep.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { selectedMessages } from './SelectionBar'
import { transcriptMarkdown } from './transcript'

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: over.id ?? 'm1',
    conversationId: 'c1',
    role: over.role ?? 'user',
    content: over.content ?? 'hello',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: over.createdAt ?? 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

beforeEach(async () => {
  await initI18n()
})

describe('the turns a reader picked', () => {
  it('comes back in thread order, not in the order they were ticked', () => {
    const rows = [message({ id: 'a' }), message({ id: 'b' }), message({ id: 'c' })]
    expect(selectedMessages(rows, new Set(['c', 'a'])).map((row) => row.id)).toEqual(['a', 'c'])
  })
})

describe('the transcript', () => {
  it('names the speaker of every turn and keeps the body verbatim', () => {
    const body = ['```ts', 'const answer = 42', '```'].join('\n')
    const text = transcriptMarkdown([
      message({ id: 'a', role: 'user', content: 'what is it' }),
      message({ id: 'b', role: 'assistant', content: body }),
    ], '季度计划')
    expect(text).toContain('# 季度计划')
    expect(text).toContain(`**${t('assistant.chat.you')}**`)
    expect(text).toContain(`**${t('assistant.chat.assistant')}**`)
    // The fence has to survive: an answer whose code arrives as prose is not the answer.
    expect(text).toContain('```ts')
    expect(text).toContain('const answer = 42')
  })

  it('says a failed turn failed rather than writing it as empty', () => {
    const text = transcriptMarkdown([message({ role: 'assistant', content: '', status: 'error', error: 'upstream refused' })], 'x')
    expect(text).toContain('upstream refused')
  })

  it('keeps what the answer was built on, as links a note can follow', () => {
    const text = transcriptMarkdown([message({
      role: 'assistant',
      content: 'It is in the plan.',
      sources: [
        { url: 'https://example.com/a', title: 'A page', cited: 'the hiring paragraph' },
        { url: '/n/note1', title: 'Quarterly plan', kind: 'note', id: 'note1' },
      ],
    })], 'x')
    expect(text).toContain(t('assistant.chat.sources'))
    expect(text).toContain('[A page](https://example.com/a)')
    expect(text).toContain('the hiring paragraph')
    // A note citation is a wikilink: the vault resolves it, and a plain URL would send the reader out of
    // the app for something already in it.
    expect(text).toContain('[[Quarterly plan]]')
  })
})
