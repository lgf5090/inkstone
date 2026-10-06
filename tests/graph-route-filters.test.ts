// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildUserGraph, type GraphParams } from '../src/worker/routes/search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

function note(id: string, user: string, title: string) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev,
       word_count, char_count, is_pinned, is_starred, is_archived, position, content_hash,
       created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, 'body', 'body', 1, 0, 0, 0, 0, 0, 0, '', 1, 1, NULL)`,
  ).run(id, user, title, title.toLowerCase())
}

function link(source: string, target: string | null, title: string) {
  sqlite.prepare(
    'INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id) VALUES (?, ?, ?, ?, ?)',
  ).run(source, title.toLowerCase(), title, target, MINE)
}

function tag(id: string, name: string, noteIds: string[]) {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, color, created_at) VALUES (?, ?, ?, NULL, 1)').run(id, MINE, name)
  for (const noteId of noteIds) {
    sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, id)
  }
}

const graph = (over: Partial<GraphParams> = {}) => buildUserGraph(db, {
  userId: MINE,
  mode: 'global',
  centerId: null,
  depth: 1,
  limit: 350,
  query: '',
  folderId: '',
  tags: [],
  tagsMatch: 'any',
  includeOrphans: true,
  includeUnresolved: false,
  showTagNodes: false,
  excluded: [],
  direction: 'both',
  ...over,
})

const titles = async (over: Partial<GraphParams> = {}) => (await graph(over)).nodes
  .map((node) => node.title).sort()

const localTitles = async (over: Partial<GraphParams> = {}) => (await graph({
  mode: 'local', centerId: 'n-a', ...over,
})).nodes.map((node) => node.title).sort()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  note('n-a', MINE, 'Alpha')
  note('n-b', MINE, 'Bravo')
  note('n-c', MINE, 'Charlie')
  note('n-d', MINE, 'Delta')
  note('n-theirs', OTHER, 'Theirs')
  link('n-a', 'n-b', 'Bravo')
  link('n-c', 'n-a', 'Alpha')
  link('n-a', null, 'Ghost')
  tag('t-x', 'x', ['n-a', 'n-b'])
  tag('t-y', 'y', ['n-a', 'n-c'])
})

describe('graph link direction', () => {
  it('walks both ends when no direction is set', async () => {
    expect(await localTitles()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('keeps only what the centre links to', async () => {
    expect(await localTitles({ direction: 'outgoing' })).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps only what links to the centre', async () => {
    expect(await localTitles({ direction: 'incoming' })).toEqual(['Alpha', 'Charlie'])
  })

  it('terminates on a mutual link instead of looping', async () => {
    link('n-b', 'n-a', 'Alpha')
    expect(await localTitles({ depth: 3 })).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })
})

describe('graph tag filter', () => {
  it('unions a single tag', async () => {
    expect(await titles({ tags: ['x'] })).toEqual(['Alpha', 'Bravo'])
  })

  it('unions several tags under any', async () => {
    expect(await titles({ tags: ['x', 'y'], tagsMatch: 'any' })).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('intersects several tags under all', async () => {
    expect(await titles({ tags: ['x', 'y'], tagsMatch: 'all' })).toEqual(['Alpha'])
  })

  it('matches a tag name regardless of case', async () => {
    expect(await titles({ tags: ['X'], tagsMatch: 'any' })).toEqual(['Alpha', 'Bravo'])
  })
})

describe('graph excluded notes', () => {
  it('drops an excluded note from a global graph', async () => {
    expect(await titles({ excluded: ['n-b'] })).toEqual(['Alpha', 'Charlie', 'Delta'])
  })

  it('keeps the centre of a local graph the reader excluded', async () => {
    const body = await graph({ mode: 'local', centerId: 'n-a', excluded: ['n-a'] })
    expect(body.nodes.map((node) => node.title)).toContain('Alpha')
  })
})

describe('graph tag nodes', () => {
  it('adds one node per tag and links its members', async () => {
    const body = await graph({ showTagNodes: true })
    const tagNodes = body.nodes.filter((node) => node.kind === 'tag').map((node) => node.title).sort()
    expect(tagNodes).toEqual(['x', 'y'])
    expect(body.edges.filter((edge) => edge.target === 'tag:x')).toHaveLength(2)
  })

  it('leaves the note degrees alone', async () => {
    const plain = await graph()
    const withTags = await graph({ showTagNodes: true })
    const degree = (nodes: typeof plain.nodes, id: string) => nodes.find((node) => node.id === id)?.degree
    expect(degree(withTags.nodes, 'n-a')).toBe(degree(plain.nodes, 'n-a'))
  })

  it('stays off unless asked', async () => {
    expect((await graph()).nodes.some((node) => node.kind === 'tag')).toBe(false)
  })
})

describe('graph tenant isolation', () => {
  it('never answers with another account note', async () => {
    expect(await titles()).not.toContain('Theirs')
  })

  it('carries unresolved ghosts only when asked', async () => {
    expect(await titles({ includeUnresolved: true })).toContain('Ghost')
    expect(await titles({ includeUnresolved: false })).not.toContain('Ghost')
  })
})
