/**
 * The public face of a shared comparison.
 *
 * A shared comparison is a slug and nothing else: `/tc/<slug>` answers a self-contained page, and
 * `/api/tools/compare/public/<slug>/asset/<side>` serves the two pictures. The page carries no
 * script and no remote resource, so a reader can open it without a session and nothing on it can
 * reach into this deployment.
 */
import { Hono, type Context } from 'hono'
import { COMPARE_KINDS } from '@shared/tools/compare/types'
import { computeTextDiff, diffSummaryLine, formatUnifiedPatch } from '@shared/tools/compare/engine'
import { CompareStore } from '../tools/compare/store'
import type { AppBindings } from '../env'

export const comparePublicRoutes = new Hono<AppBindings>()
export const comparePublicPageRoutes = new Hono<AppBindings>()

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function kindLabel(kind: string): string {
  return (COMPARE_KINDS as readonly string[]).includes(kind) ? kind : 'comparison'
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #faf9f7; color: #1f1d1a; }
  .wrap { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 22px; margin: 0; }
  .muted { color: #6b6a66; font-size: 13px; }
  .card { border: 1px solid #ddd9d2; border-radius: 10px; padding: 16px; background: #fff; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { border: 1px solid #d8d4cd; border-radius: 999px; padding: 3px 10px; font-size: 12px; }
  pre { overflow: auto; max-height: 70vh; padding: 12px; border-radius: 8px; background: #f2f1ee; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .images { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .images figure { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .images img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #d8d4cd; background: repeating-conic-gradient(#e9e7e2 0 25%, transparent 0 50%) 50% / 16px 16px; }
  figcaption { font-size: 12px; overflow-wrap: anywhere; }
  @media (prefers-color-scheme: dark) { body { background: #17181a; color: #e8e6e1; } .card { background: #1f2124; border-color: #33363b; } .muted { color: #9aa0a6; } pre { background: #111214; } }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`
}

function notFoundPage(): string {
  return htmlShell('Comparison not found', `<h1>Comparison not found</h1><p class="muted">This share link was revoked or never existed.</p>`)
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
  })
}

comparePublicPageRoutes.get('/:slug', async (c: Context<AppBindings>) => {
  const shared = await CompareStore.findSharedProject(c.env.DB, c.req.param('slug') ?? '')
  if (!shared) return htmlResponse(notFoundPage(), 404)
  const { project, left, right } = shared

  const header = `<header><h1>${escapeHtml(project.name)}</h1>
    <p class="muted">${escapeHtml(kindLabel(project.kind))} · shared comparison${
      left ? ` · ${escapeHtml(left.filename)}` : ''
    }${right ? ` ↔ ${escapeHtml(right.filename)}` : ''}</p></header>`

  let body = ''
  if (project.kind === 'text' && left && right) {
    const [leftObject, rightObject] = await Promise.all([
      c.env.FILES?.get(left.r2_key),
      c.env.FILES?.get(right.r2_key),
    ])
    const diff = computeTextDiff(leftObject ? await leftObject.text() : '', rightObject ? await rightObject.text() : '', project.options)
    const patch = formatUnifiedPatch(diff, left.filename, right.filename)
    body = `${header}<section class="card"><div class="stats">
      <span class="pill">${diff.stats.added} added</span>
      <span class="pill">${diff.stats.removed} removed</span>
      <span class="pill">${diff.stats.changed} changed</span>
      <span class="pill">${diff.stats.changedBlocks} blocks</span>
      <span class="pill">${diff.stats.same} unchanged</span>
      </div><p class="muted">${escapeHtml(diffSummaryLine(diff.stats))}</p></section>
      <section class="card"><pre>${escapeHtml(patch || 'The two files are identical.')}</pre></section>`
  } else if (project.kind === 'image') {
    const slug = encodeURIComponent(project.share_slug ?? '')
    body = `${header}<section class="images">
      <figure><img src="/api/tools/compare/public/${slug}/asset/left" alt="Left image"><figcaption>${escapeHtml(left?.filename ?? 'Left')}</figcaption></figure>
      <figure><img src="/api/tools/compare/public/${slug}/asset/right" alt="Right image"><figcaption>${escapeHtml(right?.filename ?? 'Right')}</figcaption></figure>
      </section>`
  } else if (project.kind === 'binary' || project.kind === 'file') {
    body = `${header}<section class="card"><p>${escapeHtml(left?.filename ?? 'Left')} · ${left?.size ?? 0} bytes · <code>${escapeHtml(left?.sha256 ?? '—')}</code></p>
      <p>${escapeHtml(right?.filename ?? 'Right')} · ${right?.size ?? 0} bytes · <code>${escapeHtml(right?.sha256 ?? '—')}</code></p>
      <p class="muted">${left?.sha256 === right?.sha256 ? 'Identical bytes' : 'Different bytes'}</p></section>`
  } else {
    const counts = project.summary.dirCounts
    body = `${header}<section class="card"><div class="stats">
      <span class="pill">same ${counts?.same ?? 0}</span>
      <span class="pill">different ${counts?.different ?? 0}</span>
      <span class="pill">left only ${counts?.leftOnly ?? 0}</span>
      <span class="pill">right only ${counts?.rightOnly ?? 0}</span>
      </div><p class="muted">Directory comparison shared as a summary.</p></section>`
  }

  return htmlResponse(htmlShell(project.name, body))
})

comparePublicRoutes.get('/public/:slug/asset/:side', async (c) => {
  const side = c.req.param('side')
  if (side !== 'left' && side !== 'right') return new Response('Not found', { status: 404 })
  const asset = await CompareStore.sharedAsset(c.env.DB, c.req.param('slug') ?? '', side)
  if (!asset) return new Response('Not found', { status: 404 })
  const object = await c.env.FILES?.get(asset.r2_key)
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(object.body, {
    headers: {
      'Content-Type': asset.mime,
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=300',
      ...SECURITY_HEADERS,
    },
  })
})
