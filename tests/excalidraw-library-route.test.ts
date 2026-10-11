// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { errorResponse } from '../src/worker/lib/errors'
import {
  excalidrawLibraryRoutes,
  officialLibraryUrl,
} from '../src/worker/routes/excalidraw-library'
import type { AppBindings } from '../src/worker/env'

const mocks = vi.hoisted(() => ({ userId: 'user-1' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!mocks.userId) {
      throw new (await import('../src/worker/lib/errors')).ApiError(401, 'unauthenticated', 'Authentication required')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/excalidraw/library', excalidrawLibraryRoutes)

function makeR2() {
  const store = new Map<string, string>()
  return {
    store,
    put: async (key: string, value: unknown) => {
      store.set(key, typeof value === 'string' ? value : String(value))
      return { key }
    },
    get: async (key: string) =>
      store.has(key)
        ? { body: store.get(key) as string, text: async () => store.get(key) as string }
        : null,
  }
}

function makeEnv(r2: ReturnType<typeof makeR2>) {
  return {
    FILES: r2,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      }),
    },
  } as never
}

function asUser(userId: string) {
  mocks.userId = userId
}

async function putManifest(env: never, name: string) {
  return app.request('/api/excalidraw/library/manifest', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { version: 2, folders: [{ id: 'f-1', name }], items: [], updatedAt: 1 } }),
  }, env)
}

describe('excalidraw library route', () => {
  it('keeps one account manifest out of another account view', async () => {
    const r2 = makeR2()
    const env = makeEnv(r2)

    asUser('user-1')
    expect((await putManifest(env, 'Alice Shapes')).status).toBe(200)

    asUser('user-2')
    expect((await putManifest(env, 'Bob Shapes')).status).toBe(200)

    asUser('user-1')
    const mine = await (await app.request('/api/excalidraw/library/manifest', {}, env)).json() as any
    expect(mine.manifest.folders[0].name).toBe('Alice Shapes')

    asUser('user-2')
    const theirs = await (await app.request('/api/excalidraw/library/manifest', {}, env)).json() as any
    expect(theirs.manifest.folders[0].name).toBe('Bob Shapes')

    expect([...r2.store.keys()].every((key) => key.includes('user-1') || key.includes('user-2'))).toBe(true)
    expect(r2.store.size).toBe(2)
  })

  it('does not let a second account read or overwrite a stored library file by name', async () => {
    const r2 = makeR2()
    const env = makeEnv(r2)

    asUser('user-1')
    await app.request('/api/excalidraw/library/save-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'arrows.excalidrawlib', content: { libraryItems: [[{ id: 'a' }]] } }),
    }, env)

    asUser('user-2')
    const peek = await app.request('/api/excalidraw/library/file/arrows.excalidrawlib', {}, env)
    expect(peek.status).toBe(404)

    await app.request('/api/excalidraw/library/save-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'arrows.excalidrawlib', content: { libraryItems: [[{ id: 'b' }]] } }),
    }, env)

    asUser('user-1')
    const intact = await app.request('/api/excalidraw/library/file/arrows.excalidrawlib', {}, env)
    expect(intact.status).toBe(200)
    expect(await intact.text()).toContain('"a"')
    expect(r2.store.size).toBe(2)
  })

  it('accepts only official excalidraw library urls', () => {
    expect(officialLibraryUrl('https://libraries.excalidraw.com/libraries/ismail-tall.excalidrawlib')?.hostname)
      .toBe('libraries.excalidraw.com')
    expect(officialLibraryUrl('https://libraries.excalidraw.com/libraries/nested/dir.set.excalidrawlib')).not.toBeNull()
    expect(officialLibraryUrl('http://libraries.excalidraw.com/libraries/x.excalidrawlib')).toBeNull()
    expect(officialLibraryUrl('https://libraries.excalidraw.com.evil.test/libraries/x.excalidrawlib')).toBeNull()
    expect(officialLibraryUrl('https://evil.test/libraries/x.excalidrawlib')).toBeNull()
    expect(officialLibraryUrl('https://libraries.excalidraw.com/libraries/x.svg')).toBeNull()
    expect(officialLibraryUrl('https://libraries.excalidraw.com/')).toBeNull()
    expect(officialLibraryUrl('https://libraries.excalidraw.com/libraries/x.excalidrawlib?next=1')).toBeNull()
    expect(officialLibraryUrl('https://user:pw@libraries.excalidraw.com/libraries/x.excalidrawlib')).toBeNull()
    expect(officialLibraryUrl('https://libraries.excalidraw.com/libraries/x.excalidrawlib#frag')).toBeNull()
    expect(officialLibraryUrl('not a url')).toBeNull()
  })

  it('refuses a download whose url is not an official library file', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as never
    const env = makeEnv(makeR2())
    asUser('user-1')

    const res = await app.request('/api/excalidraw/library/official-download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/x.excalidrawlib' }),
    }, env)

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
