/**
 * The public board's address.
 *
 * `/p` is reserved in `wrangler.toml`'s run_worker_first, so the worker answers it rather than the
 * asset fallback — without this route the reserved path was a 404 and the link the share dialog hands
 * out led nowhere. It serves the app shell and nothing more: a board's title sits behind the same
 * passcode as its cards, so a crawler is told no more than a stranger holding the address.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { escapeHtml } from '../lib/encoding'

export const projectSharePageRoutes = new Hono<AppBindings>()

projectSharePageRoutes.get('/:slug', async (c) => {
  const url = new URL(c.req.url)
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell
  const siteName = escapeHtml(c.env.APP_NAME || 'Inkstone')
  const head = `    <title>${siteName}</title>\n    <meta name="robots" content="noindex, nofollow" />\n  </head>`
  const html = (await shell.text()).replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', head)
  return c.html(html, 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
})