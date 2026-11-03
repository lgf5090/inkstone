// @vitest-environment node
/**
 * The reading tools, and the reader's lookups.
 *
 * The tools read the account's synced shelf through the real `ReaderLibraryStore` over an in-memory
 * D1, because what is being pinned is that a question about "my books" is answered from stored rows —
 * a stub shelf would pass while the account scoping was missing. The second half pins the lookup path:
 * a selection's explanation now goes through the assistant's account model, and the drawing engine's
 * browser-local key is not read at all.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_TOOL_SPECS, DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation } from '../src/shared/assistant'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ToolExecutor, ToolError, type ToolContext } from '../src/worker/assistant/tools'
import { READING_TOOLS } from '../src/worker/assistant/reading-tools'
import { ReaderLibraryStore, type ShelfReplaceInput } from '../src/worker/reader/store'
import type { Env } from '../src/worker/env'
import { lookupSelection } from '../src/client/features/reading/lookup'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const { oneShot } = vi.hoisted(() => ({
  oneShot: vi.fn(async (_body: Record<string, unknown>) => ({ text: '这本书的解释' })),
}))

vi.mock('../src/client/lib/api', () => ({
  api: {
    assistant: {
      oneShot,
    },
  },
}))

vi.mock('../src/client/lib/i18n', () => ({ t: (key: string) => key }))

vi.mock('../src/client/features/excalidraw/excalidraw-settings-store', () => ({
  useExcalidrawSettingsStore: {
    getState: () => ({ aiEnabled: true, aiDefaultProvider: 'p', aiProviders: { p: { apiKey: 'sk-local-drawing-key' } } }),
  },
}))

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqt'
const ZONE = 'Asia/Shanghai'

let sqlite: DatabaseSync
let env: Env
let assistant: AssistantStore
let conversation: AssistantConversation
let otherAssistant: AssistantStore

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: assistant,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: ZONE },
    timezone: ZONE,
    dayEnd: 1_700_000_000_000,
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

function otherContext(): ToolContext {
  return context({ store: otherAssistant })
}

function executor(ctx: ToolContext = context()): ToolExecutor {
  return new ToolExecutor(ctx, { maxToolCalls: 20 })
}

const TOC = [
  { label: 'Chapter One', position: { kind: 'epub', chapter: 0 }, level: 0 },
  { label: 'Chapter Two', position: { kind: 'epub', chapter: 1 }, level: 0 },
  { label: 'Chapter Three', position: { kind: 'epub', chapter: 2 }, level: 0 },
]

/** One shelf, in the shape `PUT /library` validates into. */
function shelf(over: Partial<ShelfReplaceInput>): ShelfReplaceInput {
  return {
    books: [],
    progress: [],
    highlights: [],
    marks: [],
    stats: [],
    notes: [],
    vocabulary: null,
    groups: [],
    ...over,
  }
}

const BOOK_ONE = {
  id: 'book-tao',
  title: 'Tao Te Ching',
  author: 'Laozi',
  format: 'epub',
  filename: 'tao.epub',
  language: 'en',
  publisher: 'Test Press',
  size: 2048,
  unitCount: 3,
  wantsCover: false,
  tocJson: JSON.stringify(TOC),
  addedAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
  fallbackKey: 'reader/0123456789abcdefghjkmnpqrs/book-tao.epub',
}

const BOOK_TWO = {
  id: 'book-comic',
  title: 'A Fixed Comic',
  author: 'Someone',
  format: 'pdf',
  filename: 'comic.pdf',
  language: 'en',
  publisher: '',
  size: 4096,
  unitCount: 5,
  wantsCover: false,
  tocJson: '[]',
  addedAt: 1_760_100_000_000,
  updatedAt: 1_760_100_000_000,
  fallbackKey: 'reader/0123456789abcdefghjkmnpqrs/book-comic.pdf',
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await initializeDatabase(env)
  assistant = new AssistantStore(env.DB, USER, env)
  conversation = await assistant.createConversation('Reading bench')
  otherAssistant = new AssistantStore(env.DB, OTHER, env)
  const library = new ReaderLibraryStore(env.DB, USER)
  await library.replace(shelf({
    books: [BOOK_ONE, BOOK_TWO],
    progress: [
      { bookId: BOOK_ONE.id, positionJson: JSON.stringify({ kind: 'epub', chapter: 1, offset: 40 }), fraction: 0.42, updatedAt: 1_760_200_000_000, finishedAt: null },
      { bookId: BOOK_TWO.id, positionJson: JSON.stringify({ kind: 'fixed', page: 2 }), fraction: 0.4, updatedAt: 1_760_300_000_000, finishedAt: 1_760_300_000_000 },
    ],
    highlights: [
      { id: 'hl-1', bookId: BOOK_ONE.id, chapter: 1, startOffset: 10, endOffset: 30, quote: 'The way that can be told', prefix: '', suffix: '', color: 'yellow', comment: '路的开头', createdAt: 1_760_210_000_000, updatedAt: 1_760_210_000_000 },
      { id: 'hl-2', bookId: BOOK_ONE.id, chapter: 0, startOffset: 0, endOffset: 12, quote: 'Name that can be named', prefix: '', suffix: '', color: 'blue', comment: '', createdAt: 1_760_205_000_000, updatedAt: 1_760_205_000_000 },
    ],
    stats: [{ bookId: BOOK_ONE.id, seconds: 3600, daysJson: JSON.stringify({ '2026-11-02': 3600 }) }],
    notes: [{ bookId: BOOK_ONE.id, noteId: 'note-reading-1' }],
    groups: [{ id: 'group-favourites', name: 'Favourites', bookIds: [BOOK_ONE.id], createdAt: 1_760_000_000_000, updatedAt: 1_760_000_000_000 }],
  }))
  const other = new ReaderLibraryStore(env.DB, OTHER)
  await other.replace(shelf({
    books: [{ ...BOOK_ONE, id: 'book-other', title: "Someone Else's Book", filename: 'other.epub', fallbackKey: `reader/${OTHER}/book-other.epub` }],
    progress: [{ bookId: 'book-other', positionJson: 'null', fraction: 0.1, updatedAt: 1_760_400_000_000, finishedAt: null }],
  }))
})

describe('the reading tools', () => {
  it('are read-only, and each one is in the shared spec list', () => {
    for (const definition of READING_TOOLS) {
      expect(definition.permission, definition.name).toBe('read')
      const spec = ASSISTANT_TOOL_SPECS.find((entry) => entry.name === definition.name)
      expect(spec, definition.name).toBeTruthy()
      expect(spec!.permission).toBe('read')
    }
  })

  it('lists the account shelf with progress, and never another account\'s books', async () => {
    const listed = await executor().execute('reading_list_books', {}, 'list-all') as {
      total: number
      books: Array<{ id: string, title: string, progress_percent: number, finished: boolean, stopped_at: string | null }>
    }
    expect(listed.total).toBe(2)
    expect(listed.books.map((book) => book.id)).toEqual([BOOK_TWO.id, BOOK_ONE.id])
    expect(listed.books.find((book) => book.id === BOOK_ONE.id)).toMatchObject({
      title: 'Tao Te Ching',
      progress_percent: 42,
      finished: false,
      stopped_at: 'chapter 2 · Chapter Two',
    })

    const theirs = await executor(otherContext()).execute('reading_list_books', {}, 'list-other') as { books: Array<{ id: string }> }
    expect(theirs.books.map((book) => book.id)).toEqual(['book-other'])
  })

  it('filters the shelf by what the reader is doing', async () => {
    const reading = await executor().execute('reading_list_books', { status: 'reading' }, 'list-reading') as { books: Array<{ id: string }> }
    expect(reading.books.map((book) => book.id)).toEqual([BOOK_ONE.id])
    const finished = await executor().execute('reading_list_books', { status: 'finished' }, 'list-finished') as { books: Array<{ id: string }> }
    expect(finished.books.map((book) => book.id)).toEqual([BOOK_TWO.id])
    const marked = await executor().execute('reading_list_books', { status: 'marked' }, 'list-marked') as { books: Array<{ id: string }> }
    expect(marked.books.map((book) => book.id)).toEqual([BOOK_ONE.id])
    const grouped = await executor().execute('reading_list_books', { group: 'favourites' }, 'list-group') as { books: Array<{ id: string }> }
    expect(grouped.books.map((book) => book.id)).toEqual([BOOK_ONE.id])
  })

  it('describes one book from its stored row', async () => {
    const info = await executor().execute('reading_book_info', { query: 'Tao Te' }, 'info-tao') as Record<string, unknown>
    expect(info).toMatchObject({
      id: BOOK_ONE.id,
      title: 'Tao Te Ching',
      author: 'Laozi',
      format: 'epub',
      chapter_count: 3,
      page_count: 0,
      toc_entries: 3,
      note_id: 'note-reading-1',
      groups: ['Favourites'],
    })
    expect(info.progress).toMatchObject({ percent: 42, stopped_at: 'chapter 2 · Chapter Two' })
    expect((info.reading as Record<string, unknown>).seconds).toBe(3600)

    await expect(executor().execute('reading_book_info', { id: 'book-nope' }, 'info-missing')).rejects.toBeInstanceOf(ToolError)
    await expect(executor().execute('reading_book_info', { id: 'book-other' }, 'info-cross-account')).rejects.toBeInstanceOf(ToolError)
    await expect(executor().execute('reading_book_info', {}, 'info-unnamed')).rejects.toBeInstanceOf(ToolError)
  })

  it('reads the reader\'s marks with their own notes, numbered the way a reader counts', async () => {
    const marks = await executor().execute('reading_list_highlights', { id: BOOK_ONE.id }, 'marks-all') as {
      total: number
      highlights: Array<{ id: string, chapter: number, chapter_title: string | null, quote: string, comment: string }>
    }
    expect(marks.total).toBe(2)
    expect(marks.highlights[0]).toMatchObject({
      id: 'hl-1',
      chapter: 2,
      chapter_title: 'Chapter Two',
      quote: 'The way that can be told',
      comment: '路的开头',
    })
    const first = await executor().execute('reading_list_highlights', { id: BOOK_ONE.id, chapter: 1 }, 'marks-chapter') as {
      highlights: Array<{ id: string }>
    }
    expect(first.highlights.map((one) => one.id)).toEqual(['hl-2'])
  })

  it('answers the table of contents and the reader\'s place in it, without pretending to have the body', async () => {
    const info = await executor().execute('reading_chapter_info', { id: BOOK_ONE.id }, 'chapter-epub') as {
      kind: string
      current: { number: number, title: string | null, offset: number | null } | null
      chapters: Array<{ number: number, title: string }>
      note: string
    }
    expect(info.kind).toBe('epub')
    expect(info.current).toEqual({ number: 2, title: 'Chapter Two', offset: 40 })
    expect(info.chapters.map((chapter) => chapter.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])
    expect(info.note).toContain('not available')

    const fixed = await executor().execute('reading_chapter_info', { id: BOOK_TWO.id }, 'chapter-fixed') as {
      kind: string
      page_count: number
      current_page: number
      note: string
    }
    expect(fixed).toMatchObject({ kind: 'fixed', page_count: 5, current_page: 2 })
    expect(fixed.note).toContain('pages')
  })
})

describe('a selection explained by the account model', () => {
  it('goes through the assistant one-shot route instead of the browser-local key', async () => {
    const outcome = await lookupSelection('The way that can be told', {
      to: 'zh-CN',
      engine: 'ai',
      bookTitle: 'Tao Te Ching',
    })
    expect(outcome.engine).toBe('ai')
    expect(outcome.target).toBe('这本书的解释')
    const call = oneShot.mock.calls.at(-1)?.[0]
    expect(String(call?.user)).toContain('The way that can be told')
    expect(String(call?.system)).toContain('zh-CN')
    // The drawing engine's key is present on this device, and it must not travel with the call.
    expect(JSON.stringify(call)).not.toContain('sk-local-drawing-key')
  })

  it('falls back to the deployment translation when no account model answers', async () => {
    oneShot.mockRejectedValueOnce(new Error('no model'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ translated: '道的开头' }), {
      headers: { 'content-type': 'application/json' },
    })))
    const outcome = await lookupSelection('The way', { to: 'zh-CN', engine: 'ai', bookTitle: 'Tao Te Ching' })
    expect(outcome.engine).toBe('google')
    expect(outcome.target).toBe('道的开头')
  })
})
