import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoBackend } from './backend'
import type { ListNotesResponse, Note, SearchResponse, SyncResponse, Tag } from '@shared/types'
import { LIMITS } from '@shared/constants'
import { tagInScope } from '@shared/markdown-utils'

let backend: ReturnType<typeof createDemoBackend>

async function call(method: string, path: string, body?: unknown) {
  return backend.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

async function sync(since: number): Promise<SyncResponse> {
  const response = await call('GET', `/api/sync?since=${since}`)
  expect(response.status).toBe(200)
  return await response.json() as SyncResponse
}

beforeEach(async () => {
  backend = createDemoBackend()
  const login = await call('POST', '/api/auth/login', { username: 'admin', password: 'password' })
  expect(login.status).toBe(200)
})

describe('demo sync facets stay consistent with what they carry', () => {
  it('the first pull is a full snapshot that carries the tag counts', async () => {
    const first = await sync(0)
    expect(first.full).toBe(true)
    expect(first.facetsFull).toBe(true)
    expect(first.tags.length).toBeGreaterThan(0)
    for (const tag of first.tags) {
      const users = first.notes.filter((note) => note.tags.includes(tag.name)).length
      expect(tag.count).toBe(users)
    }
  })

  it('a pull with nothing new claims no full facets', async () => {
    const first = await sync(0)
    const quiet = await sync(first.cursor)
    expect(quiet.full).toBe(false)
    expect(quiet.facetsFull, 'facetsFull with an empty tag list wipes the sidebar').toBe(false)
    expect(quiet.tags).toEqual([])
    expect(quiet.cursor).toBe(first.cursor)
  })

  it('recounts the surviving tags after one is deleted', async () => {
    const first = await sync(0)
    const shared = first.tags.find((tag) => tag.count > 1)
    if (!shared) throw new Error('the demo library needs a tag used by more than one note')

    const removed = await call('DELETE', `/api/tags/${shared.id}`)
    expect(removed.status).toBe(200)

    const after = await sync(first.cursor)
    expect(after.facetsFull).toBe(true)
    const counts = new Map(after.tags.map((tag: Tag) => [tag.name, tag.count]))
    expect(counts.has(shared.name)).toBe(false)
    for (const note of after.notes) expect(note.tags).not.toContain(shared.name)
  })
})

describe('demo tag filters match the worker', () => {
  async function listNotes(query: string) {
    const response = await backend.fetch(new Request(`http://localhost/api/notes?${query}`))
    const body = await response.json() as ListNotesResponse
    return body.notes.map((note) => note.id).sort()
  }

  it('excludes a whole subtree and keeps prefix siblings', async () => {
    const first = await listNotes('view=all')
    expect(first.length).toBeGreaterThan(0)
    const all = await backend.fetch(new Request('http://localhost/api/tags'))
    const tags = (await all.json() as { tags: Tag[] }).tags
    const hub = tags.find((item) => item.count > 0)!
    const withoutHub = await listNotes(`view=all&excludeTag=${encodeURIComponent(hub.name)}`)
    expect(withoutHub.length).toBeLessThan(first.length)
    expect(withoutHub).not.toHaveLength(0)
  })

  it('combines an included tag with an excluded one', async () => {
    const all = await backend.fetch(new Request('http://localhost/api/tags'))
    const tags = (await all.json() as { tags: Tag[] }).tags
    const kept = tags.find((item) => !item.name.includes('/'))!
    const dropped = tags.find((item) => item.name.includes('/'))
    if (!dropped) return
    const query = `view=tag&tag=${encodeURIComponent(kept.name)}&excludeTag=${encodeURIComponent(dropped.name)}`
    const result = await listNotes(query)
    for (const id of result) {
      const note = await backend.fetch(new Request(`http://localhost/api/notes/${id}`))
      const body = await note.json() as { tags: string[] }
      expect(body.tags.some((name) => tagInScope(name, dropped.name))).toBe(false)
    }
  })
})

describe('demo rename cascades the subtree like the worker', () => {
  async function tagNames(): Promise<string[]> {
    const response = await backend.fetch(new Request('http://localhost/api/tags'))
    const body = await response.json() as { tags: Tag[] }
    return body.tags.map((tag) => tag.name).sort()
  }

  async function rename(id: string, name: string) {
    const response = await backend.fetch(new Request(`http://localhost/api/tags/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }))
    expect(response.status).toBe(200)
  }

  async function noteTags(id: string): Promise<string[]> {
    const response = await backend.fetch(new Request(`http://localhost/api/notes/${id}`))
    const body = await response.json() as { tags: string[] }
    return body.tags
  }

  it('carries every descendant and rewrites the bodies', async () => {
    const created = await backend.fetch(new Request('http://localhost/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ content: ['---', 'title: cascade', 'tags: [pro, pro/deep, pro/deep/eu]', '---', 'body #pro/deep'].join('\n') }),
    }))
    const note = await created.json() as { id: string }
    expect(await tagNames()).toContain('pro/deep/eu')
    const root = (await (await backend.fetch(new Request('http://localhost/api/tags'))).json() as { tags: Tag[] })
      .tags.find((tag) => tag.name === 'pro')!

    await rename(root.id, 'proj')

    expect(await tagNames()).toEqual(expect.arrayContaining(['proj', 'proj/deep', 'proj/deep/eu']))
    expect(await tagNames()).not.toContain('pro/deep')
    expect((await noteTags(note.id)).sort()).toEqual(['proj', 'proj/deep', 'proj/deep/eu'])
  })

  it('leaves a prefix sibling alone', async () => {
    await backend.fetch(new Request('http://localhost/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ content: ['---', 'title: prefix', 'tags: [se, search]', '---', ''].join('\n') }),
    }))
    const root = (await (await backend.fetch(new Request('http://localhost/api/tags'))).json() as { tags: Tag[] })
      .tags.find((tag) => tag.name === 'se')!

    await rename(root.id, 'sort')

    const names = await tagNames()
    expect(names).toContain('search')
    expect(names).not.toContain('se')
    expect(names).not.toContain('sortarch')
  })
})

describe('demo refuses the names the worker refuses', () => {
  async function tagNames(): Promise<string[]> {
    const body = await (await call('GET', '/api/tags')).json() as { tags: Tag[] }
    return body.tags.map((tag) => tag.name).sort()
  }

  async function seedFamily(): Promise<string> {
    await backend.fetch(new Request('http://localhost/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ content: ['---', 'title: refusal', 'tags: [pro, pro/deep, pro/deep/eu]', '---', ''].join('\n') }),
    }))
    const body = await (await call('GET', '/api/tags')).json() as { tags: Tag[] }
    return body.tags.find((tag) => tag.name === 'pro')!.id
  }

  it('rejects a separator in a created or renamed name', async () => {
    const root = await seedFamily()
    expect((await call('POST', '/api/tags', { name: 'a\uFF0Cb' })).status).toBe(400)
    expect((await call('PATCH', `/api/tags/${root}`, { name: 'a;b' })).status).toBe(400)
    const names = await tagNames()
    expect(names).not.toContain('a\uFF0Cb')
    expect(names).not.toContain('a;b')
    expect(names).toContain('pro')
  })

  it('refuses a rename or move whose cascade would outgrow the name cap', async () => {
    const root = await seedFamily()
    expect((await call('PATCH', `/api/tags/${root}`, { name: 'j'.repeat(LIMITS.tagNameMaxLength) })).status).toBe(400)
    const moved = await call('POST', `/api/tags/${root}/move`, { parent: 'p'.repeat(LIMITS.tagNameMaxLength - 4) })
    expect(moved.status).toBe(400)
  })

  it('keeps two spellings the server keeps apart', async () => {
    expect((await call('POST', '/api/tags', { name: 'stra\u00DFe' })).status).toBe(201)
    expect((await call('POST', '/api/tags', { name: 'STRASSE' })).status).toBe(201)
    expect((await call('POST', '/api/tags', { name: 'strasse' })).status).toBe(409)
    const names = await tagNames()
    expect(names).toContain('stra\u00DFe')
    expect(names).toContain('STRASSE')
  })

  it('splits a full-width separated pair in frontmatter', async () => {
    const created = await backend.fetch(new Request('http://localhost/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ content: ['---', 'title: fold probe', 'tags: [getting-started\uFF0CInkstone]', '---', ''].join('\n') }),
    }))
    const note = await created.json() as { id: string }
    const loaded = await backend.fetch(new Request(`http://localhost/api/notes/${note.id}`))
    const body = await loaded.json() as { tags: string[] }
    expect(body.tags).toEqual(['getting-started', 'Inkstone'])
  })
})

describe('demo search reads the same expressions', () => {
  async function create(title: string, tags: string[]): Promise<void> {
    const response = await backend.fetch(new Request('http://localhost/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ title, content: ['---', `tags: [${tags.join(', ')}]`, '---', ''].join('\n') }),
    }))
    expect(response.ok).toBe(true)
  }

  async function searchTitles(q: string): Promise<string[]> {
    const body = await (await call('GET', `/api/search?q=${encodeURIComponent(q)}`)).json() as SearchResponse
    return body.results.map((hit) => hit.note.title).sort()
  }

  beforeEach(async () => {
    await create('expr parent', ['srch', 'other'])
    await create('expr child', ['srch/deep'])
    await create('expr stranger', ['other'])
  })

  it('treats tag: as the whole subtree', async () => {
    expect(await searchTitles('tag:srch')).toEqual(['expr child', 'expr parent'])
    expect(await searchTitles('tag:#srch/deep')).toEqual(['expr child'])
    expect(await searchTitles('tag:SRCH')).toEqual(['expr child', 'expr parent'])
  })

  it('removes the subtree with -tag: and echoes both halves', async () => {
    const without = await searchTitles('-tag:srch')
    expect(without).toContain('expr stranger')
    expect(without).not.toContain('expr parent')
    expect(without).not.toContain('expr child')
    expect(await searchTitles('tag:srch -tag:srch/deep')).toEqual(['expr parent'])
    const encoded = encodeURIComponent('tag:srch -tag:srch/deep')
    const body = await (await call('GET', `/api/search?q=${encoded}`)).json() as SearchResponse
    expect(body.query.tags).toEqual(['srch'])
    expect(body.query.excludedTags).toEqual(['srch/deep'])
  })

  it('requires the free text alongside the expressions', async () => {
    expect(await searchTitles('stranger tag:other')).toEqual(['expr stranger'])
    expect(await searchTitles('parent tag:other')).toEqual(['expr parent'])
  })
})

describe('demo turns a mention into a link the way the worker does', () => {
  const title = 'Quarterly Retro Notes'

  async function makeNote(noteTitle: string, content: string) {
    const created = await call('POST', '/api/notes', { title: noteTitle, content })
    expect(created.status).toBe(201)
    return await created.json() as Note
  }

  async function halves(targetId: string) {
    const body = await (await call('GET', `/api/notes/${targetId}/backlinks`)).json() as
      { backlinks: Array<{ id: string }>, unlinked: Array<{ id: string }> }
    return { linked: body.backlinks.map((row) => row.id), mentioned: body.unlinked.map((row) => row.id) }
  }

  it('writes the link, keeps the old text as a version, and moves the row between halves', async () => {
    const target = await makeNote(title, 'the note being pointed at')
    const source = await makeNote('Somewhere else', `notes about ${title} and ideas`)
    expect((await halves(target.id)).mentioned).toContain(source.id)
    const response = await call('POST', `/api/notes/${target.id}/link-mention`, { sourceNoteId: source.id })
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string, note?: Note }
    expect(body.status).toBe('linked')
    expect(body.note?.content).toBe(`notes about [[${title}]] and ideas`)
    expect(body.note?.rev).toBe(2)
    const after = await halves(target.id)
    expect(after.linked).toContain(source.id)
    expect(after.mentioned).not.toContain(source.id)
    const versions = await (await call('GET', `/api/notes/${source.id}/versions`)).json() as
      { versions: Array<{ title: string }> }
    expect(versions.versions.map((version) => version.title)).toEqual(['Somewhere else'])
  })

  it('says the mention is gone rather than writing anything', async () => {
    const target = await makeNote(title, 'the note being pointed at')
    const source = await makeNote('Somewhere else', 'no mention of it here')
    const body = await (await call('POST', `/api/notes/${target.id}/link-mention`, { sourceNoteId: source.id })).json() as
      { status: string }
    expect(body.status).toBe('no-mention')
    const after = await call('GET', `/api/notes/${source.id}`)
    expect((await after.json() as Note).rev).toBe(1)
  })

  it('refuses a source it is not given, in either shape', async () => {
    const target = await makeNote(title, 'the note being pointed at')
    expect((await call('POST', `/api/notes/${target.id}/link-mention`, {})).status).toBe(400)
    expect((await call('POST', `/api/notes/${target.id}/link-mention`,
      { sourceNoteId: 'not-a-note' })).status).toBe(400)
    expect((await call('POST', `/api/notes/${target.id}/link-mention`,
      { sourceNoteId: 'z'.repeat(26) })).status).toBe(404)
    expect((await call('POST', `/api/notes/${target.id}/link-mention`,
      { sourceNoteId: target.id })).status).toBe(200)
  })
})
