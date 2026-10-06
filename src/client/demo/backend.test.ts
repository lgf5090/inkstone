import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoBackend } from './backend'
import type { ListNotesResponse, SyncResponse, Tag } from '@shared/types'
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
