// @vitest-environment node
/**
 * The three ways a note and a chat turn stop agreeing with each other.
 *
 * A chat table points at a note in four places, and the note purge cleaned none of them: delete a note
 * for good and every artifact, thread, backlink row and memory that named it kept an id that will never
 * resolve again. The UI hid it — the canvas says "note missing" and the transcript falls back to a
 * generic label — so the state looked handled rather than leaked.
 *
 * The second half is the other direction. Forking a conversation did not carry the note the thread
 * started from, nor what its answers cited, nor what each turn was allowed to read, so a branch showed
 * the same words with their provenance quietly gone.
 *
 * The third is a privacy hole rather than an integrity one: a published conversation sent a stranger the
 * note citations, and a note citation is the private note's id in its url and its title in its label.
 *
 * Nulling and deleting are decided per column, and the tests below hold that line: an artifact or a
 * memory that merely mentioned a note keeps existing, while a backlink row whose only purpose was that
 * mention does not.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { NotesStore, trashPurgeStatements } from '../src/worker/notes/store'
import { AssistantStore } from '../src/worker/assistant/store'
import { ChatShareStore } from '../src/worker/assistant/share'
import { shareRoutes } from '../src/worker/routes/share'
import type { AppBindings, Env } from '../src/worker/env'
import type { PublicConversation } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const MINE = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const NOTE_ID = 'note-1'
/** A note id of the shape the app mints, so a share payload is caught by the real reader path. */
const SHARED_NOTE_ID = '01jqz0000000000000000000aa'

let sqlite: DatabaseSync
let db: D1Database
let env: Env

const count = (sql: string, ...args: Array<string | number | null>) => Number(
  (sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n,
)
const get = (sql: string, ...args: Array<string | number | null>) =>
  sqlite.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined

function note(id: string, user: string, trashed: boolean): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, rev, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'body', 1, 1, 1, ?)`,
  ).run(id, user, `Title ${id}`, `title ${id}`, trashed ? 999 : null)
}

/** One row in each of the four places the chat side points at a note. */
function chatPointingAtNote(user: string, noteId: string, suffix: string): void {
  sqlite.prepare(
    `INSERT INTO chat_conversations (user_id, id, title, note_id, created_at, updated_at)
     VALUES (?, ?, 'Thread', ?, 1, 1)`,
  ).run(user, `conv-${suffix}`, noteId)
  sqlite.prepare(
    `INSERT INTO chat_artifacts (user_id, id, conversation_id, title, content, note_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Draft', 'the draft text', ?, 1, 1)`,
  ).run(user, `art-${suffix}`, `conv-${suffix}`, noteId)
  sqlite.prepare(
    `INSERT INTO chat_note_writes (user_id, note_id, conversation_id, created_at) VALUES (?, ?, ?, 1)`,
  ).run(user, noteId, `conv-${suffix}`)
  sqlite.prepare(
    `INSERT INTO chat_memories (user_id, id, content, note_id, created_at, updated_at)
     VALUES (?, ?, 'A kept fact', ?, 1, 1)`,
  ).run(user, `mem-${suffix}`, noteId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = testBindings(db)
})

describe('purging a note releases the chat references to it', () => {
  /** The four assertions both purge paths share: three pointers nulled, one row deleted, nothing lost. */
  function expectReleased(suffix: string, user = MINE): void {
    // The rows that hold writing of their own survive, only pointing at nothing now.
    expect(get('SELECT note_id, content FROM chat_artifacts WHERE user_id = ? AND id = ?', user, `art-${suffix}`))
      .toMatchObject({ note_id: null, content: 'the draft text' })
    expect(get('SELECT note_id, title FROM chat_conversations WHERE user_id = ? AND id = ?', user, `conv-${suffix}`))
      .toMatchObject({ note_id: null, title: 'Thread' })
    expect(get('SELECT note_id, content FROM chat_memories WHERE user_id = ? AND id = ?', user, `mem-${suffix}`))
      .toMatchObject({ note_id: null, content: 'A kept fact' })
    // A backlink row means only "this note came from that thread"; with the note gone it means nothing.
    expect(count('SELECT COUNT(*) AS n FROM chat_note_writes WHERE user_id = ? AND note_id = ?', user, NOTE_ID)).toBe(0)
  }

  it('through the single-note purge, for every chat column and nobody else\'s rows', async () => {
    note(NOTE_ID, MINE, true)
    chatPointingAtNote(MINE, NOTE_ID, 'a')
    // A second account holding the same note id in its own chat rows is the case `user_id` exists for.
    chatPointingAtNote(OTHER, NOTE_ID, 'b')

    const notes = new NotesStore(db, MINE, false)
    const row = await notes.noteRow(NOTE_ID)
    expect(row).not.toBeNull()
    expect((await notes.purge(row!)).deleted).toBe(true)

    expectReleased('a')
    expect(count('SELECT COUNT(*) AS n FROM notes WHERE id = ?', NOTE_ID)).toBe(0)
    expect(get('SELECT note_id FROM chat_artifacts WHERE user_id = ? AND id = ?', OTHER, 'art-b'))
      .toMatchObject({ note_id: NOTE_ID })
    expect(get('SELECT note_id FROM chat_conversations WHERE user_id = ? AND id = ?', OTHER, 'conv-b'))
      .toMatchObject({ note_id: NOTE_ID })
    expect(get('SELECT note_id FROM chat_memories WHERE user_id = ? AND id = ?', OTHER, 'mem-b'))
      .toMatchObject({ note_id: NOTE_ID })
    expect(count('SELECT COUNT(*) AS n FROM chat_note_writes WHERE user_id = ?', OTHER)).toBe(1)
  })

  it('refuses to touch a live note\'s references', async () => {
    note(NOTE_ID, MINE, false)
    chatPointingAtNote(MINE, NOTE_ID, 'a')
    const notes = new NotesStore(db, MINE, false)
    const row = await notes.noteRow(NOTE_ID)
    // The purge guard is `deleted_at IS NOT NULL`: a note that came back to life mid-request keeps its
    // provenance, and so do the chat rows that name it.
    expect(await notes.purge(row!)).toMatchObject({ deleted: false })
    expect(get('SELECT note_id FROM chat_artifacts WHERE id = ?', 'art-a')).toMatchObject({ note_id: NOTE_ID })
    expect(get('SELECT note_id FROM chat_memories WHERE id = ?', 'mem-a')).toMatchObject({ note_id: NOTE_ID })
    expect(count('SELECT COUNT(*) AS n FROM chat_note_writes WHERE note_id = ?', NOTE_ID)).toBe(1)
  })

  it('through the batched trash purge, for a page of ids', async () => {
    note(NOTE_ID, MINE, true)
    note('note-2', MINE, true)
    chatPointingAtNote(MINE, NOTE_ID, 'a')
    chatPointingAtNote(MINE, 'note-2', 'c')
    chatPointingAtNote(OTHER, NOTE_ID, 'b')

    const statements = trashPurgeStatements(db, MINE, JSON.stringify([NOTE_ID, 'note-2']), Date.now(), true)
    expect((await db.batch(statements)).at(-1)?.meta.changes).toBe(2)

    expectReleased('a')
    expectReleased('c')
    expect(get('SELECT note_id FROM chat_artifacts WHERE user_id = ? AND id = ?', OTHER, 'art-b'))
      .toMatchObject({ note_id: NOTE_ID })
    expect(count('SELECT COUNT(*) AS n FROM chat_note_writes WHERE user_id = ?', OTHER)).toBe(1)
  })
})

describe('forking a conversation keeps its provenance', () => {
  it('carries the note the thread started from', async () => {
    const store = new AssistantStore(db, MINE, env)
    const origin = await store.createConversation('Origin', null, false, null, NOTE_ID)
    await store.addMessage({ conversationId: origin.id, role: 'user', content: 'What does the note say?' })
    const answer = await store.addMessage({ conversationId: origin.id, role: 'assistant', content: 'This.' })

    const fork = await store.forkConversation(origin.id, answer.id, 'Branch')
    expect(fork).not.toBeNull()
    expect(fork!.noteId).toBe(NOTE_ID)
  })

  it('copies what each turn cited and what it was limited to', async () => {
    const store = new AssistantStore(db, MINE, env)
    const origin = await store.createConversation('Origin')
    const sources = [{ url: 'https://example.com/a', title: 'A page', kind: 'web' as const }]
    const scopes = [{ kind: 'folder' as const, id: 'folder-1', name: 'Research' }]
    await store.addMessage({ conversationId: origin.id, role: 'user', content: 'Q', sources, scopes })
    const answer = await store.addMessage({ conversationId: origin.id, role: 'assistant', content: 'A' })

    const fork = await store.forkConversation(origin.id, answer.id, 'Branch')
    const rows = await store.allMessages(fork!.id)
    expect(rows).toHaveLength(2)
    // Compared against how the source thread reads back rather than against the literal input: the
    // stored form is normalized on the way out, and what a fork owes its reader is the same provenance
    // the original shows, not the same object he handed the composer.
    const copied = await store.allMessages(origin.id)
    expect(rows[0]!.sources).toEqual(copied[0]!.sources)
    expect(rows[0]!.sources).toBeDefined()
    expect(rows[0]!.scopes).toEqual(copied[0]!.scopes)
    expect(rows[0]!.scopes).toHaveLength(1)
    expect(rows[1]!.sources).toEqual([])
  })
})

describe('a shared conversation does not publish private note links', () => {
  function buildApp(): Hono<AppBindings> {
    const instance = new Hono<AppBindings>()
    instance.onError((err, c) => errorResponse(c, err))
    instance.use('*', async (c, next) => {
      c.set('userId', MINE)
      c.set('database', { ftsEnabled: false })
      await next()
    })
    instance.route('/api/public', shareRoutes)
    return instance
  }

  /** Publishes one thread whose answer cites a note, a web page, and a note citation predating `kind`. */
  async function publish(sources: unknown[]): Promise<string> {
    sqlite.prepare(
      `INSERT INTO chat_conversations (user_id, id, title, note_id, created_at, updated_at)
       VALUES (?, ?, 'Planning', ?, 1, 1)`,
    ).run(MINE, 'conv-1', NOTE_ID)
    sqlite.prepare(
      `INSERT INTO chat_messages (user_id, id, conversation_id, role, content, sources, created_at)
       VALUES (?, ?, 'conv-1', 'assistant', 'The answer.', ?, 1)`,
    ).run(MINE, 'msg-1', JSON.stringify(sources))
    const share = new ChatShareStore(db, MINE)
    await share.upsertShare({
      conversationId: 'conv-1', scope: '', passwordHash: null, expiresAt: null,
      now: 1_700_000_000_000, replacePassword: true, replaceExpiry: true, rotate: false,
    })
    const row = await share.shareFor('conv-1')
    if (!row) throw new Error('the share link was not written')
    return row.slug
  }

  async function readAnonymously(slug: string): Promise<{ status: number, body: string, payload: PublicConversation }> {
    // The route hands the view count to `waitUntil`; the test settles it so a rejected write cannot
    // disappear behind an unhandled rejection.
    const pending: Promise<unknown>[] = []
    const response = await buildApp().fetch(
      new Request(`http://localhost/api/public/conversation/${slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      { waitUntil: (task: Promise<unknown>) => { pending.push(task) } } as ExecutionContext,
    )
    const body = await response.text()
    await Promise.all(pending)
    return { status: response.status, body, payload: JSON.parse(body) as PublicConversation }
  }

  it('answers a stranger with the web source and no trace of the note', async () => {
    const slug = await publish([
      { url: `/n/${SHARED_NOTE_ID}`, title: 'Private note title', kind: 'note', id: SHARED_NOTE_ID, cited: 'a private passage' },
      { url: 'https://example.com/ok', title: 'Ok', kind: 'web' },
      // A citation stored before notes could be cited: no `kind`, still the app's own relative path.
      { url: `/n/${SHARED_NOTE_ID}`, title: 'Old shape title' },
    ])
    const { status, body, payload } = await readAnonymously(slug)
    expect(status).toBe(200)
    expect(body).not.toContain(SHARED_NOTE_ID)
    expect(body).not.toContain('/n/')
    expect(body).not.toContain('Private note title')
    expect(body).not.toContain('a private passage')
    expect(payload.messages[0]!.sources).toEqual([{ url: 'https://example.com/ok', title: 'Ok' }])
  })

  it('still publishes the thread around the dropped citation', async () => {
    const slug = await publish([
      { url: `/n/${SHARED_NOTE_ID}`, title: 'Private note title', kind: 'note', id: SHARED_NOTE_ID },
    ])
    const { payload } = await readAnonymously(slug)
    expect(payload.title).toBe('Planning')
    expect(payload.messages[0]!.content).toBe('The answer.')
    expect(payload.messages[0]!.sources).toEqual([])
  })
})
