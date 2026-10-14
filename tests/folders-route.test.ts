// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { errorResponse } from '../src/worker/lib/errors'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { foldersRoutes } from '../src/worker/routes/folders'
import type { AppBindings } from '../src/worker/env'
import type { Folder } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The folder tree's own routes, end to end.
 *
 * Nothing exercised these before: a create, a patch and the two delete strategies all answer through
 * statements wrapped in a recursive common-table expression, and the local D1 double used to read the
 * opening `WITH` as a sign that the statement was a query. It returned no `meta`, the store asked for
 * `meta.changes`, and every one of these calls failed as a 500 that had nothing to do with the code
 * under test. See `tests/d1-double-statement-kinds.test.ts` for the double itself.
 */
const ALICE = 'user-alice'
const BOB = 'user-bob'
const TREE = '/api/folders'

let sqlite: DatabaseSync
let db: D1Database
let user: string
// Typed as the context `app.fetch` actually declares, so every field the route may read has to be
// there: the ambient Workers interface is wider than hono needs and cannot be faked outside a Worker.
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
}

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('userId', user)
  c.set('database', { ftsEnabled: false })
  await next()
})
app.route(TREE, foldersRoutes)

function env() {
  return { DB: db } as unknown as AppBindings['Bindings']
}

/**
 * A folder id the route accepts.
 *
 * `isValidId` wants 26 characters drawn from the alphabet `newId` writes, which leaves out the letters
 * that read alike, so the labels below are chosen from the ones that survive and then padded.
 */
function fid(label: string): string {
  return label.padEnd(26, '0').slice(0, 26)
}

async function call(method: string, path: string, body?: unknown) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env(), ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function create(body: Record<string, unknown>): Promise<Folder> {
  return json<Folder>(await call('POST', TREE, body))
}

async function tree(): Promise<Folder[]> {
  return (await json<{ folders: Folder[] }>(await call('GET', TREE))).folders
}

async function names(): Promise<string[]> {
  return (await tree()).map((folder) => folder.name).sort()
}

async function failure(method: string, path: string, body?: unknown) {
  const response = await call(method, path, body)
  const { error } = await response.json() as { error: { message: string } }
  return { status: response.status, message: error.message }
}

async function depth(levels: number): Promise<string> {
  let parentId: string | null = null
  for (let level = 1; level <= levels; level++) {
    // Padded so that the tenth and twelfth stems cannot collapse onto the first one once `fid` pads.
    const id = fid(`deep${String(level).padStart(2, '0')}`)
    await create({ id, name: `L${level}`, parentId })
    parentId = id
  }
  return parentId!
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = ALICE
})

describe('putting folders in the tree', () => {
  it('creates one and lists it back', async () => {
    const created = await create({ name: 'Ideas' })
    expect(created.name).toBe('Ideas')
    expect(created.parentId).toBeNull()
    expect(await names()).toEqual(['Ideas'])
  })

  it('answers a repeated id with the folder it already holds', async () => {
    const first = await create({ id: fid('fxd'), name: 'Ideas' })
    const again = await call('POST', TREE, { id: fid('fxd'), name: 'Renamed elsewhere' })
    expect(again.status).toBe(200)
    expect((await json<Folder>(again)).name).toBe('Ideas')
    expect(first.id).toBe(fid('fxd'))
    expect(await names()).toEqual(['Ideas'])
  })

  it('refuses an id that is not a folder id', async () => {
    expect(await failure('POST', TREE, { id: 'not-an-id', name: 'Ideas' })).toEqual({
      status: 400,
      message: 'id must be a valid folder id',
    })
  })

  it('gives an unnamed folder the next free name beside its siblings', async () => {
    await create({})
    await create({})
    expect(await names()).toEqual(['New folder', 'New folder 2'])
  })

  it('refuses a sibling that already answers to the same name', async () => {
    await create({ id: fid('a'), name: 'Ideas' })
    expect(await failure('POST', TREE, { id: fid('b'), name: 'Ideas' })).toEqual({
      status: 409,
      message: 'The parent folder changed or a sibling already uses this name',
    })
  })

  it('refuses a folder id another account is holding', async () => {
    await create({ id: fid('shared'), name: 'Ideas' })
    user = BOB
    expect(await failure('POST', TREE, { id: fid('shared'), name: 'Mine' })).toEqual({
      status: 409,
      message: 'This folder id is already in use',
    })
  })

  it('refuses the level below the depth it allows', async () => {
    const deepest = await depth(LIMITS.folderDepthMax)
    expect(await failure('POST', TREE, { name: 'Too deep', parentId: deepest })).toEqual({
      status: 400,
      message: `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`,
    })
    expect((await tree())).toHaveLength(LIMITS.folderDepthMax)
  })

  it('refuses a name longer than the limit and a parent that does not exist', async () => {
    expect((await failure('POST', TREE, { name: 'x'.repeat(LIMITS.folderNameMaxLength + 1) })).status).toBe(400)
    expect(await failure('POST', TREE, { name: 'Orphan', parentId: fid('absent') })).toEqual({
      status: 400,
      message: 'The parent folder does not exist',
    })
  })
})

describe('renaming and moving what is in the tree', () => {
  const KEEP = fid('keep')
  const BANK = fid('bank')
  const ANT = fid('ant')

  beforeEach(async () => {
    await create({ id: KEEP, name: 'Keep' })
    await create({ id: BANK, name: 'Bank' })
    await create({ id: ANT, name: 'Ant', parentId: KEEP })
  })

  async function parentOf(id: string): Promise<string | null> {
    return (await tree()).find((folder) => folder.id === id)?.parentId ?? null
  }

  it('renames in place', async () => {
    expect((await call('PATCH', `${TREE}/${BANK}`, { name: 'Renamed' })).status).toBe(200)
    expect(await names()).toEqual(['Ant', 'Keep', 'Renamed'])
  })

  it('re-parents to the top level', async () => {
    expect((await call('PATCH', `${TREE}/${ANT}`, { parentId: null })).status).toBe(200)
    expect(await parentOf(ANT)).toBeNull()
  })

  it('places a moved folder before the sibling the caller named', async () => {
    const moved = await json<Folder>(await call('PATCH', `${TREE}/${ANT}`, { parentId: null, beforeId: BANK }))
    expect(moved.parentId).toBeNull()
    const top = (await tree()).filter((folder) => folder.parentId === null).sort((a, b) => a.position - b.position)
    expect(top.map((folder) => folder.id)).toEqual([KEEP, ANT, BANK])
  })

  it('answers a patch that asks for nothing with the folder unchanged', async () => {
    const untouched = await json<Folder>(await call('PATCH', `${TREE}/${KEEP}`, {}))
    expect(untouched.name).toBe('Keep')
  })

  it('refuses an empty name, a self-referential order and a missing folder', async () => {
    expect((await failure('PATCH', `${TREE}/${KEEP}`, { name: '   ' })).status).toBe(400)
    expect((await failure('PATCH', `${TREE}/${KEEP}`, { beforeId: KEEP, parentId: null })).status).toBe(400)
    expect(await failure('PATCH', `${TREE}/${fid('absent')}`, { name: 'Ghost' })).toEqual({
      status: 404,
      message: 'Folder not found',
    })
  })

  it('refuses moving a folder underneath its own child', async () => {
    expect(await failure('PATCH', `${TREE}/${KEEP}`, { parentId: ANT })).toEqual({
      status: 400,
      message: 'A folder cannot be moved into its own descendant',
    })
  })

  it('refuses a reorder that leaves the destination or skips the parent', async () => {
    expect(await failure('PATCH', `${TREE}/${ANT}`, { beforeId: fid('elsewhere') })).toEqual({
      status: 400,
      message: 'parentId is required when reordering a folder',
    })
    expect((await failure('PATCH', `${TREE}/${BANK}`, { parentId: KEEP, beforeId: fid('absent') })).status).toBe(400)
  })
})

describe('taking folders out of the tree', () => {
  const PEAK = fid('peak')
  const NECK = fid('neck')
  const FERN = fid('fern')

  beforeEach(async () => {
    await create({ id: PEAK, name: 'Peak' })
    await create({ id: NECK, name: 'Neck', parentId: PEAK })
    await create({ id: FERN, name: 'Fern', parentId: NECK })
  })

  async function ids(): Promise<string[]> {
    return (await tree()).map((folder) => folder.id).sort()
  }

  it('moves the children up when the strategy says move-up', async () => {
    expect((await call('DELETE', `${TREE}/${NECK}?strategy=move-up`)).status).toBe(200)
    expect(await ids()).toEqual([FERN, PEAK].sort())
    expect((await tree()).find((folder) => folder.id === FERN)?.parentId).toBe(PEAK)
  })

  it('takes the whole subtree when the strategy says delete', async () => {
    expect((await call('DELETE', `${TREE}/${PEAK}?strategy=delete`)).status).toBe(200)
    expect(await ids()).toEqual([])
  })

  it('defaults to moving up when the caller names no strategy', async () => {
    expect((await call('DELETE', `${TREE}/${NECK}`)).status).toBe(200)
    expect(await ids()).toEqual([FERN, PEAK].sort())
  })

  it('refuses a strategy that is neither, and a folder the account does not have', async () => {
    expect(await failure('DELETE', `${TREE}/${NECK}?strategy=sideways`)).toEqual({
      status: 400,
      message: 'strategy must be move-up or delete',
    })
    user = BOB
    expect(await failure('DELETE', `${TREE}/${PEAK}?strategy=delete`)).toEqual({
      status: 404,
      message: 'Folder not found',
    })
    expect(await ids()).toEqual([])
    user = ALICE
    expect(await ids()).toEqual([FERN, NECK, PEAK].sort())
  })
})
