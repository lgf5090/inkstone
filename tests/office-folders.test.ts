// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFICE_LIMITS } from '../src/shared/office/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { officeContentRoutes } from '../src/worker/routes/office-content'
import { officeRoutes } from '../src/worker/routes/office'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

/**
 * The office tree: folder hierarchy rules, tag families and revision trimming.
 *
 * These are the rules that keep a flat `parent_id` table from becoming a corrupt one — depth,
 * cycles, sibling names, promotion on delete — plus the `/` family rewrite that must not touch an
 * unrelated tag whose name merely starts with the same letters.
 */

const USER = 'user-alpha'
const OTHER = 'user-beta'

interface FileJson {
  id: string
  title: string
  folderId: string | null
  rev: number
  size: number
}

interface FolderJson {
  id: string
  parentId: string | null
  name: string
  position: number
}

interface TagJson {
  id: string
  name: string
  color: string | null
  isPinned: boolean
  count: number
}

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/office', officeContentRoutes)
  instance.route('/api/office', officeRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  return app().request(`http://localhost/api/office${path}`, init, env)
}

async function bodyOf<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function createFile(title: string, folderId?: string | null): Promise<FileJson> {
  const response = await call('POST', '/files', { type: 'docs', title, folderId })
  expect(response.status).toBe(201)
  return (await bodyOf<{ file: FileJson }>(response)).file
}

async function createFolder(name: string, parentId: string | null = null): Promise<FolderJson> {
  const response = await call('POST', '/folders', { name, parentId })
  expect(response.status).toBe(201)
  return (await bodyOf<{ folder: FolderJson }>(response)).folder
}

async function createTag(name: string): Promise<TagJson> {
  const response = await call('POST', '/tags', { name })
  expect(response.status).toBe(201)
  return (await bodyOf<{ tag: TagJson }>(response)).tag
}

async function foldersOf(parentId: string | null): Promise<FolderJson[]> {
  const all = await bodyOf<{ folders: FolderJson[] }>(await call('GET', '/folders'))
  return all.folders.filter((folder) => folder.parentId === parentId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = USER
})

describe('office folder hierarchy', () => {
  it('creates nested folders and refuses a chain deeper than the ceiling', async () => {
    let parentId: string | null = null
    for (let depth = 1; depth <= OFFICE_LIMITS.folderDepthMax; depth++) {
      const folder = await createFolder(`Level ${depth}`, parentId)
      expect(folder.parentId).toBe(parentId)
      parentId = folder.id
    }
    const tooDeep = await call('POST', '/folders', { name: 'Level 13', parentId })
    expect(tooDeep.status).toBe(400)
    expect((await bodyOf<ErrorJson>(tooDeep)).error.message).toContain(String(OFFICE_LIMITS.folderDepthMax))
  })

  it('refuses a cycle and a move that would outgrow the depth ceiling', async () => {
    const root = await createFolder('Root')
    const child = await createFolder('Child', root.id)
    const cycle = await call('PATCH', `/folders/${root.id}`, { parentId: child.id })
    expect(cycle.status).toBe(400)

    let parentId = root.id
    let current = child
    for (let depth = 3; depth <= OFFICE_LIMITS.folderDepthMax; depth++) {
      current = await createFolder(`Level ${depth}`, parentId)
      parentId = current.id
    }
    const deep = await call('PATCH', `/folders/${root.id}`, { parentId: current.id })
    expect(deep.status).toBe(400)

    const other = await createFolder('Other root')
    const moved = await bodyOf<{ folder: FolderJson }>(
      await call('PATCH', `/folders/${child.id}`, { parentId: other.id }),
    )
    expect(moved.folder.parentId).toBe(other.id)
  })

  it('keeps sibling names unique, case-insensitively, per parent', async () => {
    const root = await createFolder('Root')
    await createFolder('Work', root.id)
    expect((await call('POST', '/folders', { name: 'work', parentId: root.id })).status).toBe(409)
    expect((await call('POST', '/folders', { name: 'work' })).status).toBe(201)
    expect((await call('POST', '/folders', { name: '' })).status).toBe(400)
    expect((await call('POST', '/folders', { name: 'bad/name' })).status).toBe(400)
  })

  it('renames and reorders siblings before a named neighbour', async () => {
    const root = await createFolder('Root')
    const first = await createFolder('First', root.id)
    const second = await createFolder('Second', root.id)
    const third = await createFolder('Third', root.id)

    const renamed = await bodyOf<{ folder: FolderJson }>(
      await call('PATCH', `/folders/${second.id}`, { name: 'Second renamed' }),
    )
    expect(renamed.folder.name).toBe('Second renamed')

    const reordered = await call('PATCH', `/folders/${third.id}`, {
      parentId: root.id,
      beforeId: first.id,
    })
    expect(reordered.status).toBe(200)
    const order = (await foldersOf(root.id)).map((folder) => folder.id)
    expect(order).toEqual([third.id, first.id, second.id])

    expect((await call('PATCH', `/folders/${third.id}`, { beforeId: first.id })).status).toBe(400)
    expect((await call('PATCH', `/folders/${third.id}`, { parentId: root.id, beforeId: third.id })).status).toBe(400)
  })

  it('promotes children and files on delete, then restores the emptied folder', async () => {
    const parent = await createFolder('Parent')
    const child = await createFolder('Child', parent.id)
    const file = await createFile('Inside parent', parent.id)

    expect((await call('DELETE', `/folders/${parent.id}`)).status).toBe(200)
    expect(await foldersOf(null)).toHaveLength(1)
    const promoted = (await foldersOf(null))[0]!
    expect(promoted.id).toBe(child.id)
    const movedFile = await bodyOf<{ file: FileJson }>(await call('GET', `/files/${file.id}`))
    expect(movedFile.file.folderId).toBeNull()

    const restored = await bodyOf<{ folder: FolderJson }>(await call('POST', `/folders/${parent.id}/restore`))
    expect(restored.folder).toMatchObject({ id: parent.id, parentId: null })
    expect((await foldersOf(null)).map((folder) => folder.id).sort()).toEqual([parent.id, child.id].sort())
  })

  it('trashes a whole subtree and roots a file restored before its folder', async () => {
    const parent = await createFolder('Parent')
    const child = await createFolder('Child', parent.id)
    const file = await createFile('Buried', child.id)

    expect((await call('DELETE', `/folders/${parent.id}?strategy=delete`)).status).toBe(200)
    expect(await foldersOf(null)).toEqual([])
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', '/files'))).files).toEqual([])
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', '/files?trash=1'))).files.map((row) => row.id)).toEqual([file.id])

    const restoredFile = await bodyOf<{ file: FileJson }>(await call('POST', `/files/${file.id}/restore`))
    expect(restoredFile.file.folderId).toBeNull()

    expect((await call('POST', `/folders/${parent.id}/restore`)).status).toBe(200)
    const live = await bodyOf<{ folders: FolderJson[] }>(await call('GET', '/folders'))
    expect(live.folders.map((folder) => folder.id).sort()).toEqual([parent.id, child.id].sort())
    const childRow = live.folders.find((folder) => folder.id === child.id)!
    expect(childRow.parentId).toBe(parent.id)
  })

  it('rejects a malformed delete strategy and keeps another account out', async () => {
    const folder = await createFolder('Private')
    expect((await call('DELETE', `/folders/${folder.id}?strategy=nuke`)).status).toBe(400)

    mocks.userId = OTHER
    expect((await call('PATCH', `/folders/${folder.id}`, { name: 'Stolen' })).status).toBe(404)
    expect((await call('DELETE', `/folders/${folder.id}`)).status).toBe(404)
    expect((await call('POST', `/folders/${folder.id}/restore`)).status).toBe(404)
    expect((await call('POST', '/folders', { name: 'Child', parentId: folder.id })).status).toBe(400)
    expect((await bodyOf<{ folders: FolderJson[] }>(await call('GET', '/folders'))).folders).toEqual([])
  })

  it('refuses a rename onto a live sibling name', async () => {
    await createFolder('One')
    const two = await createFolder('Two')
    expect((await call('PATCH', `/folders/${two.id}`, { name: 'one' })).status).toBe(409)
  })
})

describe('office tag families', () => {
  it('renames the whole family and leaves a merely similar tag alone', async () => {
    await createTag('work')
    await createTag('work/2026')
    await createTag('workshop')

    const renamed = await bodyOf<{ tag: TagJson }>(
      await call('PATCH', `/tags/${(await findTag('work')).id}`, { name: 'job', color: '#336699', isPinned: true }),
    )
    expect(renamed.tag).toMatchObject({ name: 'job', color: '#336699', isPinned: true })

    const tags = await bodyOf<{ tags: TagJson[] }>(await call('GET', '/tags'))
    expect(tags.tags.map((tag) => tag.name)).toEqual(['job', 'job/2026', 'workshop'])
  })

  it('refuses a family rename whose destination another tag already uses', async () => {
    await createTag('work')
    await createTag('work/2026')
    await createTag('job')
    const work = await findTag('work')
    const response = await call('PATCH', `/tags/${work.id}`, { name: 'job' })
    expect(response.status).toBe(409)
    expect((await bodyOf<ErrorJson>(response)).error.code).toBe('conflict')
  })

  it('counts tagged files and drops memberships when the family goes', async () => {
    const parent = await createTag('work')
    const child = await createTag('work/2026')
    await createTag('workshop')
    const file = await createFile('Tagged')
    expect((await call('PATCH', `/files/${file.id}`, { tagIds: [child.id] })).status).toBe(200)

    const counted = await bodyOf<{ tags: TagJson[] }>(await call('GET', '/tags'))
    expect(counted.tags.find((tag) => tag.id === child.id)!.count).toBe(1)
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?tagId=${child.id}`))).files).toHaveLength(1)

    expect((await call('DELETE', `/tags/${parent.id}`)).status).toBe(200)
    const remaining = await bodyOf<{ tags: TagJson[] }>(await call('GET', '/tags'))
    expect(remaining.tags.map((tag) => tag.name)).toEqual(['workshop'])
    expect((await bodyOf<{ files: FileJson[] }>(await call('GET', `/files?tagId=${child.id}`))).files).toEqual([])
  })

  it('keeps tags unique case-insensitively and scopes them to the account', async () => {
    await createTag('Finance')
    expect((await call('POST', '/tags', { name: 'finance' })).status).toBe(409)
    const tag = await findTag('Finance')

    mocks.userId = OTHER
    expect((await bodyOf<{ tags: TagJson[] }>(await call('GET', '/tags'))).tags).toEqual([])
    expect((await call('PATCH', `/tags/${tag.id}`, { name: 'Steal' })).status).toBe(404)
    expect((await call('DELETE', `/tags/${tag.id}`)).status).toBe(404)
    expect((await call('POST', '/tags', { name: 'bad\u0000name' })).status).toBe(400)
  })
})

describe('office version trimming and restore', () => {
  it('keeps the newest revisions, deletes older objects, and restores into a new rev', async () => {
    const file = await createFile('History')
    for (let rev = 1; rev <= 22; rev++) {
      const response = await call('PUT', `/files/${file.id}/snapshot`, {
        baseRev: rev - 1,
        snapshot: { n: rev },
      })
      expect(response.status).toBe(200)
    }

    const versions = await bodyOf<{ versions: Array<{ rev: number; size: number }> }>(
      await call('GET', `/files/${file.id}/versions`),
    )
    expect(versions.versions).toHaveLength(OFFICE_LIMITS.versionsPerFile)
    expect(versions.versions[0]!.rev).toBe(22)
    expect(versions.versions.at(-1)!.rev).toBe(3)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/1.json`)).toBe(false)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/2.json`)).toBe(false)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/3.json`)).toBe(true)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/22.json`)).toBe(true)

    const restored = await call('POST', `/files/${file.id}/versions/5/restore`)
    expect(restored.status).toBe(200)
    expect((await bodyOf<{ rev: number }>(restored)).rev).toBe(23)
    const snapshot = await bodyOf<{ rev: number; snapshot: { n: number } }>(
      await call('GET', `/files/${file.id}/snapshot`),
    )
    expect(snapshot).toMatchObject({ rev: 23, snapshot: { n: 5 } })

    const afterRestore = await bodyOf<{ versions: Array<{ rev: number }> }>(
      await call('GET', `/files/${file.id}/versions`),
    )
    expect(afterRestore.versions).toHaveLength(OFFICE_LIMITS.versionsPerFile)
    expect(afterRestore.versions[0]!.rev).toBe(23)
    expect(afterRestore.versions.at(-1)!.rev).toBe(4)
    expect(bucket.objects.has(`office/txt/${USER}/${file.id}/3.json`)).toBe(false)

    expect((await call('POST', `/files/${file.id}/versions/999/restore`)).status).toBe(404)
    expect((await call('POST', `/files/${file.id}/versions/zero/restore`)).status).toBe(400)
  })

  it('refuses to restore a version into a trashed file', async () => {
    const file = await createFile('Trashed history')
    await call('PUT', `/files/${file.id}/snapshot`, { baseRev: 0, snapshot: { n: 1 } })
    await call('DELETE', `/files/${file.id}`)
    const response = await call('POST', `/files/${file.id}/versions/1/restore`)
    expect(response.status).toBe(404)
  })
})

async function findTag(name: string): Promise<TagJson> {
  const tags = await bodyOf<{ tags: TagJson[] }>(await call('GET', '/tags'))
  const found = tags.tags.find((tag) => tag.name === name)
  if (!found) throw new Error(`tag ${name} not found`)
  return found
}