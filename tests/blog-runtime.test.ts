/// <reference types="node" />
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { BLOG_RENDERER_VERSION } from '../src/shared/blog/renderer'
import { blogRuntimeRoutes } from '../src/worker/blog/runtime-routes'
import type { Env } from '../src/worker/env'
import { testBindings, testD1 } from './doubles/bindings'

function harness() {
  const requested: string[] = []
  const app = new Hono()
  app.route('/blog-runtime', blogRuntimeRoutes)
  const assets = {
    async fetch(input: RequestInfo | URL) {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      requested.push(path)
      if (path.endsWith('/stale.js')) return new Response('missing', { status: 404 })
      return new Response('export {}', { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
    },
  } as unknown as Env['ASSETS']
  const env = testBindings(testD1(), { ASSETS: assets })
  return { app, env, requested }
}

describe('reading runtime assets', () => {
  it('serves the current version with immutable caching and CORS', async () => {
    const { app, env, requested } = harness()
    const response = await app.fetch(
      new Request(`http://localhost/blog-runtime/${BLOG_RENDERER_VERSION}/assets/main.js`),
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('export {}')
    expect(requested).toEqual([`/blog-runtime/${BLOG_RENDERER_VERSION}/assets/main.js`])
  })

  it('refuses a renderer generation that is not the one this build serves', async () => {
    const { app, env, requested } = harness()
    const response = await app.fetch(
      new Request('http://localhost/blog-runtime/inkstone-blog-v1/runtime.js'),
      env,
    )
    expect(response.status).toBe(404)
    expect(requested).toEqual([])
  })

  it('never lets a path segment climb out of the runtime directory', async () => {
    const { app, env, requested } = harness()
    const response = await app.fetch(
      new Request(`http://localhost/blog-runtime/${BLOG_RENDERER_VERSION}/..%2Fsecret.js`),
      env,
    )
    expect(response.status).toBe(404)
    expect(requested).toEqual([])
  })

  it('passes an upstream miss through as a miss instead of the SPA shell', async () => {
    const { app, env } = harness()
    const response = await app.fetch(
      new Request(`http://localhost/blog-runtime/${BLOG_RENDERER_VERSION}/stale.js`),
      env,
    )
    expect(response.status).toBe(404)
  })
})
