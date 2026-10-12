// @vitest-environment node
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'

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

function r2() {
    const store = new Map<string, string>()
    return {
        store,
        put: async (key: string, value: unknown) => {
            store.set(key, typeof value === 'string' ? value : String(value))
            return { key }
        },
        get: async () => null,
    }
}

function env() {
    return {
        FILES: r2(),
        DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) }) },
    } as never
}

/** The route caches the catalog in module scope, so every test needs a freshly imported module. */
async function freshApp() {
    vi.resetModules()
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
        globalThis.fetch = fetchSpy as never
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
        globalThis.fetch = fetchSpy as never
        const app = await freshApp()

        await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        const second = await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(second.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('refuses an upstream redirect rather than following it', async () => {
        // The guard is the point, not the option literal: workerd never had 'error' at all.
        const fetchSpy = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/x.json' } }))
        globalThis.fetch = fetchSpy as never
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())
        expect(res.status).toBe(502)
        const body = await res.json() as { ok: boolean; libraries: unknown[] }
        expect(body.ok).toBe(false)
        expect(body.libraries).toEqual([])
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        // What the old literal-string test could never see: workerd rejects 'error' before the
        // request is even made, so the option this app passes has to be one it accepts.
        expect((fetchSpy.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
    })

    it('serves stale data immediately and refreshes behind the response', async () => {
        const app0 = await freshApp()
        const ok = vi.fn(async () => catalogResponse([ENTRY]))
        globalThis.fetch = ok as never
        await app0.request('/api/excalidraw/library/official-catalog', {}, env(), ctx())

        // Backdate by pushing a failing upstream after the window: the first call still answers.
        vi.useFakeTimers()
        vi.setSystemTime(Date.now() + 2 * 3600_000)
        const flaky = vi.fn(async () => { throw new Error('upstream down') })
        globalThis.fetch = flaky as never
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
        }) as never

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
        globalThis.fetch = fetchSpy as never
        const app = await freshApp()

        const res = await app.request('/api/excalidraw/library/official-download', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'thijsdev/snowflake.excalidrawlib' }),
        }, env(), ctx())

        expect(res.status).toBe(502)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('archives the raw file behind the response instead of before it', async () => {
        const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ libraryItems: [[{ id: 'a' }]] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        globalThis.fetch = fetchSpy as never
        const app = await freshApp()
        const e = env()

        const res = await app.request('/api/excalidraw/library/official-download', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'thijsdev/snowflake.excalidrawlib' }),
        }, e, ctx())

        expect(res.status).toBe(200)
        expect(((await res.json()) as { data: unknown }).data).toMatchObject({ libraryItems: [[{ id: 'a' }]] })
        expect(waitUntilCalls).toHaveLength(1)
        await Promise.allSettled(waitUntilCalls)
        expect([...(e as never as { FILES: { store: Map<string, string> } }).FILES.store.keys()])
            .toEqual(['excalidraw/libraries/user-1/snowflake.excalidrawlib'])
    })
})
