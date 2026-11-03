// @vitest-environment node
/**
 * The RSS tools the assistant reaches through the executor.
 *
 * Two stores meet here: the subscription library the account owns, and the bounded reading snapshot
 * the device uploads. The cases pin what the model depends on — unread is derived from the library's
 * marks, a local day covers the whole day, one feed narrows the list, and a mark is a real row the
 * reader's next load will see — and the honesty rule: with no snapshot the tool refuses rather than
 * inventing an article.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation } from '../src/shared/assistant'
import { emptyLibrary, newFeed, type RssLibrary } from '../src/shared/rss/model'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ToolExecutor, ToolError, type ToolContext } from '../src/worker/assistant/tools'
import { loadRssLibrary, saveRssReadingFeed, storeRssLibrary } from '../src/worker/lib/rss-store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const ZONE = 'Asia/Shanghai'
const TODAY = '2026-11-03'

let sqlite: DatabaseSync
let env: Env
let assistant: AssistantStore
let conversation: AssistantConversation

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: assistant,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: ZONE },
    timezone: ZONE,
    dayEnd: Date.parse('2026-11-03T16:00:00Z'),
    mode: 'chat',
    conversationId: conversation.id,
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    writeContext: {} as ToolContext['writeContext'],
    ...over,
  }
}

function executor(): ToolExecutor {
  return new ToolExecutor(context(), { maxToolCalls: 20 })
}

function libraryWith(feeds: RssLibrary['feeds']): RssLibrary {
  return { ...emptyLibrary(), feeds }
}

const aiFeed = newFeed('feed-ai', 'https://ai.test/feed.xml', 'AI Weekly', 0)
const designFeed = newFeed('feed-design', 'https://design.test/feed.xml', 'Design Notes', 1)

const AI_ENTRY = {
  id: 'entry-ai-today',
  feedId: aiFeed.id,
  title: 'A smaller model that still writes',
  link: 'https://ai.test/posts/smaller-model',
  author: 'Rae',
  content: 'The model keeps most of the quality at half the size. The benchmarks say so plainly.',
  summary: 'Half the size, most of the quality.',
  publishedTs: Date.parse('2026-11-03T02:00:00Z'),
  imageUrl: '',
  audioUrl: '',
}

const OLD_ENTRY = {
  id: 'entry-ai-old',
  feedId: aiFeed.id,
  title: 'An older AI post',
  link: 'https://ai.test/posts/older',
  author: 'Rae',
  content: 'This one shipped last month and should stay out of today.',
  summary: 'From last month.',
  publishedTs: Date.parse('2026-10-20T02:00:00Z'),
  imageUrl: '',
  audioUrl: '',
}

const DESIGN_ENTRY = {
  id: 'entry-design-today',
  feedId: designFeed.id,
  title: 'Grids that breathe',
  link: 'https://design.test/posts/grids',
  author: 'Kai',
  content: 'A layout study with no model in it at all.',
  summary: 'Whitespace, mostly.',
  publishedTs: Date.parse('2026-11-03T03:00:00Z'),
  imageUrl: '',
  audioUrl: '',
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await initializeDatabase(env)
  assistant = new AssistantStore(env.DB, USER, env)
  conversation = await assistant.createConversation('RSS bench')
  await storeRssLibrary(env.DB, USER, libraryWith([aiFeed, designFeed]), Date.now())
  await saveRssReadingFeed(env.DB, USER, aiFeed.id, [AI_ENTRY, OLD_ENTRY])
  await saveRssReadingFeed(env.DB, USER, designFeed.id, [DESIGN_ENTRY])
})

describe('listing feeds', () => {
  it('names each subscription with its unread count from the synced articles', async () => {
    const answer = await executor().execute('rss_list_feeds', {}, 'feeds') as {
      feeds: Array<{ id: string, title: string, unread: number }>
      synced: boolean
    }
    expect(answer.synced).toBe(true)
    expect(answer.feeds).toMatchObject([
      { id: aiFeed.id, title: 'AI Weekly', unread: 2 },
      { id: designFeed.id, title: 'Design Notes', unread: 1 },
    ])
  })
})

describe('listing articles for one day', () => {
  it('keeps only the articles published inside the local day', async () => {
    const answer = await executor().execute('rss_list_entries', {
      filter: 'unread',
      from: TODAY,
      to: TODAY,
    }, 'today') as { entries: Array<{ id: string, published: string, feed: string }>, total: number }

    expect(answer.total).toBe(2)
    expect(answer.entries.map((entry) => entry.id)).toEqual(['entry-design-today', 'entry-ai-today'])
    expect(answer.entries[0]).toMatchObject({ feed: 'Design Notes', published: '2026-11-03T11:00' })
    expect(answer.entries.some((entry) => entry.id === OLD_ENTRY.id)).toBe(false)
  })

  it('narrows to one feed and to words in the text', async () => {
    const answer = await executor().execute('rss_list_entries', {
      feedId: aiFeed.id,
      query: 'benchmarks',
    }, 'query') as { entries: Array<{ id: string }> }
    expect(answer.entries.map((entry) => entry.id)).toEqual([AI_ENTRY.id])
  })

  it('carries the article text in the same call when asked', async () => {
    const answer = await executor().execute('rss_list_entries', {
      filter: 'unread',
      from: TODAY,
      to: TODAY,
      withText: true,
    }, 'with-text') as { entries: Array<{ id: string, content: string }> }
    expect(answer.entries.find((entry) => entry.id === AI_ENTRY.id)?.content).toContain('half the size')
  })

  it('refuses a feed this account does not subscribe to', async () => {
    await expect(executor().execute('rss_list_entries', { feedId: 'feed-missing' }, 'missing'))
      .rejects.toBeInstanceOf(ToolError)
  })
})

describe('reading one article', () => {
  it('returns the synced text and the marks it carries', async () => {
    const answer = await executor().execute('rss_read_entry', { id: AI_ENTRY.id }, 'read') as {
      content: string
      title: string
      feed: string
      unread: boolean
      link: string
    }
    expect(answer).toMatchObject({ title: AI_ENTRY.title, feed: 'AI Weekly', unread: true, link: AI_ENTRY.link })
    expect(answer.content).toContain('half the size')
  })

  it('names the ids it does hold instead of inventing one', async () => {
    await expect(executor().execute('rss_read_entry', { id: 'entry-invented' }, 'invented'))
      .rejects.toBeInstanceOf(ToolError)
  })
})

describe('marking an article', () => {
  it('writes the read mark into the account library and the list follows', async () => {
    const marked = await executor().execute('rss_mark', { id: AI_ENTRY.id, state: 'read' }, 'mark-read') as {
      marked: boolean
      unread: boolean
    }
    expect(marked).toMatchObject({ marked: true, unread: false })

    const stored = await loadRssLibrary(env.DB, USER)
    expect(stored.library?.readIds).toContain(AI_ENTRY.id)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM rss_mark WHERE user_id = ? AND kind = ?')
      .get(USER, 'read')).toMatchObject({ count: 1 })

    const unread = await executor().execute('rss_list_entries', { filter: 'unread' }, 'unread') as {
      entries: Array<{ id: string }>
    }
    expect(unread.entries.map((entry) => entry.id)).not.toContain(AI_ENTRY.id)
  })

  it('stars and unstars through the same library rows', async () => {
    await executor().execute('rss_mark', { id: DESIGN_ENTRY.id, state: 'star' }, 'star')
    const starred = await executor().execute('rss_list_entries', { filter: 'starred' }, 'starred') as {
      entries: Array<{ id: string }>
    }
    expect(starred.entries.map((entry) => entry.id)).toEqual([DESIGN_ENTRY.id])

    await executor().execute('rss_mark', { id: DESIGN_ENTRY.id, state: 'unstar' }, 'unstar')
    const after = await loadRssLibrary(env.DB, USER)
    expect(after.library?.favorites).not.toContain(DESIGN_ENTRY.id)
  })
})

describe('a device that never uploaded', () => {
  it('refuses to list or read an article it never received', async () => {
    sqlite.exec('DELETE FROM rss_reading')
    await expect(executor().execute('rss_list_entries', {}, 'no-snapshot')).rejects.toBeInstanceOf(ToolError)
    await expect(executor().execute('rss_read_entry', { id: AI_ENTRY.id }, 'no-snapshot-read')).rejects.toBeInstanceOf(ToolError)
  })
})
