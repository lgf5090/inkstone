import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'

export const memosPublicPageRoutes = new Hono<AppBindings>()

memosPublicPageRoutes.get('/explore', renderMemosPublicShell)
memosPublicPageRoutes.get('/s/:token', renderMemosPublicShell)
memosPublicPageRoutes.get('/u/:username', renderMemosPublicShell)
memosPublicPageRoutes.get('/u/:username/m/:id', renderMemosPublicShell)

async function renderMemosPublicShell(c: Context<AppBindings>) {
  const url = new URL(c.req.url)
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell

  const siteName = c.env.APP_NAME || 'Inkstone'
  const title = 'Memos'
  const description = `Public memos on ${siteName}`
  const meta = [
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join('\n    ')

  const html = (await shell.text())
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace('</head>', `    ${meta}\n  </head>`)

  return c.html(html, 200, {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
