import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { notesCarryEveryTag } from '../src/shared/markdown-utils'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings } from '../src/worker/env'
import type { ListNotesResponse } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }
const ctx = { waitUntil: () => {} } as ExecutionContext

function note(id: string, userId = USER, flags: { archived?: boolean; deleted?: number } = {}) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, created_at, updated_at, is_archived, deleted_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)',
  ).run(id, userId, id, `body ${id}`, flags.archived ? 1 : 0, flags.deleted ?? null)
}

function tag(id: string, name: string, userId = USER) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run(id, userId, name)
}

function link(noteId: string, tagId: string) {
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId)
}

async function list(query: string): Promise<ListNotesResponse> {
  const response = await app.fetch(new Request(`http://localhost/api/notes?${query}`), env as never, ctx)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as ListNotesResponse
}

const ids = (response: ListNotesResponse) => response.notes.map((item) => item.id).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
})

describe('multi-tag filtering', () => {
  beforeEach(() => {
    tag('t-work', 'work')
    tag('t-meet', 'work/meeting')
    tag('t-fun', 'fun')
    tag('t-pct', '50%_done')
    note('plain')
    note('work-only')
    note('nested-only')
    note('both')
    note('percent')
    link('work-only', 't-work')
    link('nested-only', 't-meet')
    link('both', 't-work')
    link('both', 't-fun')
    link('percent', 't-pct')
  })

  function url(...scopes: string[]): string {
    return `view=tag&${scopes.map((value) => `tag=${encodeURIComponent(value)}`).join('&')}`
  }

  it('a parent tag also returns the notes carrying a descendant', async () => {
    expect(ids(await list(url('work')))).toEqual(['both', 'nested-only', 'work-only'])
  })

  it('does not treat a sibling with a shared prefix as a descendant', async () => {
    tag('t-why', 'workflow')
    note('workflow-only')
    link('workflow-only', 't-why')
    const found = ids(await list(url('work')))
    expect(found).not.toContain('workflow-only')
    expect(found).toEqual(['both', 'nested-only', 'work-only'])
  })

  it('several tags combine with AND', async () => {
    expect(ids(await list(url('work', 'fun')))).toEqual(['both'])
    expect(ids(await list(url('work', 'missing')))).toEqual([])
  })

  it('escapes LIKE wildcards that appear inside a tag name', async () => {
    expect(ids(await list(url('50%_done')))).toEqual(['percent'])
    expect(ids(await list(url('50%')))).toEqual([])
    expect(ids(await list(url('5x%')))).toEqual([])
    expect(ids(await list(url('50%_don')))).toEqual([])
  })

  it('matches a tag regardless of case', async () => {
    expect(ids(await list(url('WORK')))).toEqual(['both', 'nested-only', 'work-only'])
  })

  it('refuses a tag view with no tag at all', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/notes?view=tag'), env as never, ctx)
    expect(response.status).toBe(400)
  })
})

// The route spells the subtree rule in SQL and the offline shell spells it in TypeScript;
// one drifts silently and the sidebar count stops matching the list.
describe('the SQL filter and the shared TypeScript rule agree', () => {
  const cases: Array<[string, string[]]> = [
    ['work', ['both', 'nested-only', 'work-only']],
    ['work/meeting', ['nested-only']],
    ['WORK', ['both', 'nested-only', 'work-only']],
    ['fun', ['both']],
    ['50%_done', ['percent', 'percent-sub']],
    ['50%_done/sub', ['percent-sub']],
    ['50%', []],
    ['50', []],
    ['workflow', ['workflow-only']],
    ['nope', []],
  ]

  beforeEach(() => {
    tag('t-work', 'work')
    tag('t-meet', 'work/meeting')
    tag('t-fun', 'fun')
    tag('t-pct', '50%_done')
    tag('t-why', 'workflow')
    tag('t-pct-sub', '50%_done/sub')
    for (const id of ['plain', 'work-only', 'nested-only', 'both', 'percent', 'percent-sub', 'workflow-only'])
      note(id)
    link('work-only', 't-work')
    link('nested-only', 't-meet')
    link('both', 't-work')
    link('both', 't-fun')
    link('percent', 't-pct')
    link('percent-sub', 't-pct-sub')
    link('workflow-only', 't-why')
  })

  it.each(cases)('scope %s', async (scope, expected) => {
    const route = ids(await list(`view=tag&tag=${encodeURIComponent(scope)}`))
    const shared = ['plain', 'work-only', 'nested-only', 'both', 'percent', 'percent-sub', 'workflow-only']
      .filter((id) => {
        const carried: string[] = id === 'work-only' ? ['work']
          : id === 'nested-only' ? ['work/meeting']
            : id === 'both' ? ['work', 'fun']
              : id === 'percent' ? ['50%_done']
                : id === 'percent-sub' ? ['50%_done', '50%_done/sub']
                  : id === 'workflow-only' ? ['workflow'] : []
        return notesCarryEveryTag(carried, [scope])
      })
      .sort()
    expect(route).toEqual(expected)
    expect(route).toEqual(shared)
  })
})

describe('the untagged view', () => {
  beforeEach(() => {
    tag('t-work', 'work')
    tag('t-fun', 'fun')
    note('bare')
    note('one-tag')
    note('two-tags')
    note('archived-bare', USER, { archived: true })
    note('trashed-tag', USER, { deleted: 1_700_000_000_000 })
    note('theirs', OTHER)
    link('one-tag', 't-work')
    link('two-tags', 't-work')
    link('two-tags', 't-fun')
    link('trashed-tag', 't-work')
  })

  it('lists only live notes that carry no tag', async () => {
    expect(ids(await list('view=untagged'))).toEqual(['bare'])
  })

  it('agrees with the all view minus the tagged ones', async () => {
    const all = ids(await list('view=all'))
    const untagged = ids(await list('view=untagged'))
    const tagged = ids(await list('view=tag&tag=work'))
    expect(all).toEqual(['bare', 'one-tag', 'two-tags'])
    expect(untagged.concat(tagged).sort()).toEqual(all)
  })

  it('still paginates and reports a total', async () => {
    const response = await list('view=untagged&limit=1')
    expect(response.notes).toHaveLength(1)
    expect(response.total).toBe(1)
    expect(response.nextCursor).toBeNull()
  })
})
