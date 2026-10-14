// @vitest-environment node
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testBindings, testD1, testR2Bucket } from './doubles/bindings'
import type { AppBindings, Env } from '../src/worker/env'

vi.mock('../src/worker/middleware/auth', () => ({
    requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'user-1')
        await next()
    },
}))

const realFetch = globalThis.fetch
let waitUntilCalls: Promise<unknown>[] = []

function ctx() {
    return {
        waitUntil: (p: Promise<unknown>) => { waitUntilCalls.push(p) },
        passThroughOnException: () => {},
        props: {},
    } as unknown as ExecutionContext
}

/** These two endpoints archive into R2 and read nothing from D1, so an empty database answers them. */
function env(): Env {
    return testBindings(testD1(), { FILES: testR2Bucket() })
}

/** The route caches the catalog in module scope, so every test needs a freshly imported module. */
async function freshApp() {
    vi.resetModules()
    const { errorResponse } = await import('../src/worker/lib/errors')
    const { excalidrawLibraryRoutes } = await import('../src/worker/routes/excalidraw-library')
    const app = new Hono<AppBindings>()
    app.onError((err, c) => errorResponse(c, err))
    app.route('/api/excalidraw/library', excalidrawLibraryRoutes)
    return app
}

function catalogResponse(entries: unknown[]) {
    return new Response(JSON.stringify({ libraries: entries }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    })
}

const ENTRY = {
    name: 'Snowflake',
    description: 'Warehouse shapes',
    authors: [{ name: 'thijsdev' }],
    source: 'thijsdev/snowflake.excalidrawlib',
    preview: 'thijsdev/snowflake.png',
    created: '2021-01-01',
    updated: '2022-02-02',
    version: 1,
    id: 'abc',
    itemNames: ['snowflake', 'stage', 'pipe'],
}

beforeEach(() => {
    waitUntilCalls = []
})

afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
})

describe('the official catalog endpoint', () => {
    it('answers with the fields the browser reads, and says they may be cached', async () => {
        const fetchSpy = vi.fn(async () => catalogResponse([ENTRY]))
        globalThis.fetch = fetchSpy
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(res.status).toBe(200)
        const body = await res.json() as { ok: boolean; libraries: Record<string, unknown>[] }
        expect(body.libraries).toHaveLength(1)
        expect(body.libraries[0]).not.toHaveProperty('itemNames')
        expect(body.libraries[0]).toMatchObject({ name: 'Snowflake', source: 'thijsdev/snowflake.excalidrawlib', preview: 'thijsdev/snowflake.png' })
        expect(res.headers.get('cache-control')).toContain('max-age')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('answers the next reader from the cache instead of the upstream', async () => {
        const fetchSpy = vi.fn(async () => catalogResponse([ENTRY]))
        globalThis.fetch = fetchSpy
        const app = await freshApp()

        await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        const second = await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(second.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('refuses an upstream redirect rather than following it', async () => {
        // The guard is the point, not the option literal: workerd never had 'error' at all.
        // Spied with fetch's own signature: the assertion below reads the second argument, and a
        // zero-parameter mock types every call as an empty tuple, where that argument is undefined.
        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: 'https://evil.test/x.json' } }))
        globalThis.fetch = fetchSpy
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(res.status).toBe(502)
        const body = await res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('internal')
        expect(body.error.message).toBeTruthy()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        // What the old literal-string test could never see: workerd rejects 'error' before the
        // request is even made, so the option this app passes has to be one it accepts.
        expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual')
    })

    it('serves stale data immediately and refreshes behind the response', async () => {
        const app0 = await freshApp()
        const ok = vi.fn(async () => catalogResponse([ENTRY]))
        globalThis.fetch = ok
        await app0.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())

        // Backdate by pushing a failing upstream after the window: the first call still answers.
        vi.useFakeTimers()
        vi.setSystemTime(Date.now() + 2 * 3600_000)
        const flaky = vi.fn(async () => { throw new Error('upstream down') })
        globalThis.fetch = flaky
        const res = await app0.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        vi.useRealTimers()

        expect(res.status).toBe(200)
        expect(((await res.json()) as { libraries: unknown[] }).libraries).toHaveLength(1)
        expect(waitUntilCalls).toHaveLength(1)
        await Promise.allSettled(waitUntilCalls)
    })

    it('runs one background refresh for a burst of stale readers', async () => {
        const app = await freshApp()
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => { release = resolve })
        let calls = 0
        globalThis.fetch = vi.fn(async () => {
            calls += 1
            if (calls === 1) return catalogResponse([ENTRY])
            await gate
            return catalogResponse([{ ...ENTRY, name: 'Refreshed' }])
        })

        await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(calls).toBe(1)

        const base = Date.now()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(base + 2 * 3600_000)
        const answers = await Promise.all([
            app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx()),
            app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx()),
            app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx()),
        ])
        clock.mockRestore()

        // All three answered from the stale cache, and one refresh is in flight for the whole burst.
        expect(calls).toBe(2)
        for (const res of answers) expect(res.status).toBe(200)
        release()
        await Promise.allSettled(waitUntilCalls)
        expect(calls).toBe(2)
    })
})

describe('the official download endpoint', () => {
    it('refuses a library file that redirects away from the official host', async () => {
        const fetchSpy = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://evil.test/x.excalidrawlib' } }))
        globalThis.fetch = fetchSpy
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-download', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'thijsdev/snowflake.excalidrawlib' }),
        }, env(), ctx())

        expect(res.status).toBe(502)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('answers an oversized library with 413 rather than a generic download failure', async () => {
        // The route's own cap: `OFFICIAL_FETCH_MAX_BYTES` in src/worker/routes/excalidraw-library.ts.
        const OFFICIAL_FETCH_MAX_BYTES = 5 * 1024 * 1024
        globalThis.fetch = vi.fn(async () => new Response('x'.repeat(OFFICIAL_FETCH_MAX_BYTES + 1), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-download', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'thijsdev/snowflake.excalidrawlib' }),
        }, env(), ctx())

        expect(res.status).toBe(413)
        const body = await res.json() as { error?: { code?: string; message?: string } }
        expect(body.error?.code).toBe('payload_too_large')
        expect(body.error?.message).toMatch(/5 MB limit/)
    })

    it('archives the raw file behind the response instead of before it', async () => {
        const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ libraryItems: [[{ id: 'a' }]] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        globalThis.fetch = fetchSpy
        const app = await freshApp()
        const files = testR2Bucket()
        const e = testBindings(testD1(), { FILES: files })

        const res = await app.request('/api/excalidraw/library/official-download', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'thijsdev/snowflake.excalidrawlib' }),
        }, e, ctx())

        expect(res.status).toBe(200)
        expect(((await res.json()) as { data: unknown }).data).toMatchObject({ libraryItems: [[{ id: 'a' }]] })
        expect(waitUntilCalls).toHaveLength(1)
        await Promise.allSettled(waitUntilCalls)
        expect([...files.objects.keys()])
            .toEqual(['excalidraw/libraries/user-1/snowflake.excalidrawlib'])
    })
})
