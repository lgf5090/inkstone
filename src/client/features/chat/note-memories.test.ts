// @vitest-environment jsdom
/**
 * What the note's backlink panel asks the memory route for.
 *
 * `chat_memories.note_id` names the page a fact was written out as, and the route has always narrowed on it —
 * an id that is not an id narrows to nothing rather than to the reader's whole library. What the client's
 * public signature did not carry for a while was that fourth key: the note panel widened the query type
 * locally instead, which is a second, unreviewed copy of a contract that lives in one place.
 *
 * So this pins the one thing that has to stay true after the widening goes away: the filter is asked for over
 * the wire by the note's own read, and a read that does not name a note does not invent one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@shared/assistant'
import { api } from '../../lib/api'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { noteMemories } from './note-memories'

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz55'

const MEMORY: AssistantMemory = {
  id: 'm1',
  content: 'The budget review is monthly',
  category: 'fact',
  source: 'assistant',
  status: 'active',
  supersededBy: null,
  validFrom: null,
  validUntil: null,
  projectId: null,
  noteId: NOTE_ID,
  createdAt: 1,
  updatedAt: 2,
}

let requested: string[] = []

async function answer(): Promise<Response> {
  const path = requested.at(-1) ?? ''
  // The route answers a note's question with the facts filed under it, and everything else with the library.
  const rows = path.includes('noteId=') ? [MEMORY] : []
  return new Response(JSON.stringify({
    memories: rows,
    total: rows.length,
    counts: { active: rows.length, historical: 0, review: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  requested = []
  vi.stubGlobal('fetch', vi.fn(async (path: string | URL) => {
    requested.push(String(path))
    return answer()
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the note’s own memory read', () => {
  it('asks the published signature for the facts filed under this page', async () => {
    const rows = await noteMemories(NOTE_ID)

    expect(requested).toHaveLength(1)
    expect(requested[0]).toContain('/api/assistant/memories?')
    expect(requested[0]).toContain(`noteId=${NOTE_ID}`)
    expect(requested[0]).toContain('status=current')
    expect(rows).toEqual([MEMORY])
  })

  it('sends the id encoded rather than as a bare path the query would misread', async () => {
    await noteMemories('a note id/with?punctuation')

    expect(requested[0]).toContain('noteId=a%20note%20id%2Fwith%3Fpunctuation')
  })

  it('does not invent the note filter for the memory page’s own read', async () => {
    await api.assistant.memories({ status: 'all' })

    expect(requested[0]).not.toContain('noteId=')
  })
})
