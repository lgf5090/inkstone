import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import { searchUserNotes } from '../src/worker/routes/search'
import type { AppBindings } from '../src/worker/env'
import type { ListNotesResponse } from '../src/shared/types'
import type { UserSearchResult } from '../src/worker/routes/search'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function note(id: string, content = `body ${id}`) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, excerpt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)',
  ).run(id, USER, id, content, content)
}

function tag(id: string, name: string) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(id, USER, name)
}

function link(noteId: string, tagId: string) {
  sqlite.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

async function search(q: string): Promise<UserSearchResult> {
  return await searchUserNotes(env.DB, USER, q, 100, false)
}

async function list(query: string): Promise<ListNotesResponse> {
  const response = await app.fetch(new Request(`http://localhost/api/notes?${query}`), env as never, ctx)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as ListNotesResponse
}

const hitIds = (body: UserSearchResult) => body.results.map((hit) => hit.note.id).sort()
const listIds = (body: ListNotesResponse) => body.notes.map((item) => item.id).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)

  tag('t-work', 'work')
  tag('t-meeting', 'work/meeting')
  tag('t-job', 'job')
  note('n-work')
  note('n-meeting')
  note('n-job')
  note('n-both')
  note('n-plain')
  link('n-work', 't-work')
  link('n-meeting', 't-meeting')
  link('n-job', 't-job')
  link('n-both', 't-work')
  link('n-both', 't-job')
})

describe('tag expressions in the search grammar', () => {
  it('reads tag: as the whole subtree', async () => {
    expect(hitIds(await search('tag:work'))).toEqual(['n-both', 'n-meeting', 'n-work'])
    expect(hitIds(await search('tag:#work'))).toEqual(['n-both', 'n-meeting', 'n-work'])
    expect(hitIds(await search('tag:WORK'))).toEqual(['n-both', 'n-meeting', 'n-work'])
    expect(hitIds(await search('tag:work/meeting'))).toEqual(['n-meeting'])
  })

  it('removes the subtree with -tag:', async () => {
    expect(hitIds(await search('-tag:work'))).toEqual(['n-job', 'n-plain'])
    expect(hitIds(await search('tag:work -tag:work/meeting'))).toEqual(['n-both', 'n-work'])
    expect(hitIds(await search('-tag:#job'))).toEqual(['n-meeting', 'n-plain', 'n-work'])
  })

  it('echoes both halves of the parsed expression', async () => {
    const body = await search('tag:work -tag:work/meeting alpha')
    expect(body.query.tags).toEqual(['work'])
    expect(body.query.excludedTags).toEqual(['work/meeting'])
    expect(body.query.text).toBe('alpha')
  })

  it('escapes wildcards inside a tag name', async () => {
    tag('t-percent', '50%')
    tag('t-percent-child', '50%/deep')
    tag('t-fifty', '50x')
    note('n-percent')
    link('n-percent', 't-percent')
    note('n-percent-child')
    link('n-percent-child', 't-percent-child')
    note('n-fifty')
    link('n-fifty', 't-fifty')
    expect(hitIds(await search('tag:50%'))).toEqual(['n-percent', 'n-percent-child'])
    expect(hitIds(await search('-tag:50%'))).toEqual(['n-both', 'n-fifty', 'n-job', 'n-meeting', 'n-plain', 'n-work'])
  })

  it('agrees with the note-list tag view for the same fixture', async () => {
    expect(hitIds(await search('tag:work'))).toEqual(listIds(await list('view=tag&tag=work')))
    expect(hitIds(await search('tag:work tag:job'))).toEqual(
      listIds(await list('view=tag&tag=work&tag=job')),
    )
    expect(hitIds(await search('-tag:work'))).toEqual(listIds(await list('view=all&excludeTag=work')))
  })
})
