import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'

/**
 * Serves the versioned reading runtime the blog loads for published articles.
 *
 * The files are ordinary build assets, but the path is claimed by the Worker for two reasons: a
 * version that no longer exists must answer 404 rather than the SPA's `index.html` (a module script
 * cannot recover from HTML), and the blog reads them through a proxy, so the response states the
 * immutable caching the content-hashed names already justify.
 */
export const blogRuntimeRoutes = new Hono<AppBindings>()

blogRuntimeRoutes.get('/:version/*', async (c) => {
  const version = c.req.param('version')
  const rest = c.req.path.slice(`/blog-runtime/${version}/`.length)
  if (version !== BLOG_RENDERER_VERSION || !rest || rest.includes('..')) {
    return c.text('Reading runtime not found', 404)
  }
  const target = new URL(c.req.url)
  target.pathname = `/blog-runtime/${version}/${rest}`
  const upstream = await c.env.ASSETS.fetch(new Request(target.toString(), { method: 'GET' }))
  if (!upstream.ok) return new Response('Reading runtime not found', { status: upstream.status })
  const headers = new Headers(upstream.headers)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(upstream.body, { status: 200, headers })
})
