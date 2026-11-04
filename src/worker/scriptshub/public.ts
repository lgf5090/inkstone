/**
 * The public half of ScriptsHub: `/sc/<path>` serves a file, `/sc-view/<id>` is its readable page.
 *
 * Neither route reads a session. A publication is the grant, and every decision here is made from
 * the publication row: paused, expired, token-gated, pointing at a file, and still owned by the
 * account that published it. A request that fails is written to the event table as a real visit
 * with a status, so the dashboard's 403/404 counts are counts of requests rather than decoration.
 */

import { Hono, type Context } from 'hono'
import { EN_US_SCRIPTSHUB_PUBLIC } from '@shared/locales/en-US-scriptshub-public'
import { ZH_CN_SCRIPTSHUB_PUBLIC } from '@shared/locales/zh-CN-scriptshub-public'
import type { ScriptshubPublicCopy } from '@shared/locales/en-US-scriptshub-public'
import { contentTypeForFile, languageFor } from '@shared/scriptshub/languages'
import { parsePublicationRequestPath, publicationUrlPath } from '@shared/scriptshub/path'
import { etagMatches, requestedRevision, scriptEtag, scriptResponseHeaders } from '@shared/scriptshub/publication'
import type { ScriptLanguageId } from '@shared/scriptshub/languages'
import type { AppBindings } from '../env'
import { escapeHtml, sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { parseBrowser, parseDeviceType } from '../tools/shortlinks/ua'
import { parseReferrerHost } from '../tools/shortlinks/referrer'
import { ScriptsHubStore } from './store'

/** How many distribution requests one visitor may make in a rolling minute. */
const REQUESTS_PER_MINUTE = 120

const PUBLIC_PATH_PREFIX = '/sc/'
const DETAIL_PREFIX = '/sc-view/'

interface PublicationRow {
  id: string
  user_id: string
  snippet_id: string
  file_id: string
  path: string
  is_enabled: number
  visibility: string
  token_hash: string | null
  expires_at: number | null
  title: string
  description: string
  language: string
  source_url: string
  updated_at: number
}

interface ServedFile {
  id: string
  name: string
  language: string
  content: string
}

export const scriptshubPublicRoutes = new Hono<AppBindings>()

function publicCopy(acceptLanguage: string | undefined): { locale: 'en-US' | 'zh-CN'; copy: ScriptshubPublicCopy } {
  return (acceptLanguage ?? '').toLowerCase().startsWith('zh')
    ? { locale: 'zh-CN', copy: ZH_CN_SCRIPTSHUB_PUBLIC }
    : { locale: 'en-US', copy: EN_US_SCRIPTSHUB_PUBLIC }
}

async function visitorFingerprint(
  ip: string,
  userAgent: string,
  secret: string | undefined,
  now: number,
): Promise<string | null> {
  if (!ip && !userAgent) return null
  const day = new Date(now).toISOString().slice(0, 10)
  const salt = await sha256Hex(`${secret ?? 'inkstone-scriptshub'}|${day}`)
  return (await sha256Hex(`${ip}|${userAgent}|${salt}`)).slice(0, 16)
}

function recordEvent(
  c: Context<AppBindings>,
  publication: PublicationRow,
  kind: string,
  status: number,
  revision: number | null,
  knownFingerprint?: string | null,
): void {
  const now = Date.now()
  const ua = c.req.header('user-agent') ?? ''
  const ip = (c.req.header('cf-connecting-ip') ?? '').trim()
  const referrer = parseReferrerHost(c.req.header('referer'))
  const country = c.req.header('cf-ipcountry') ?? null
  const record = (async () => {
    const fingerprint = knownFingerprint ?? await visitorFingerprint(ip, ua, c.env.SHORTLINKS_SECRET, now)
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO scriptshub_events
          (user_id, id, publication_id, snippet_id, kind, status, at, visitor_fp, ua_family, device_type,
           referrer_host, country, path, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        publication.user_id,
        newId(),
        publication.id,
        publication.snippet_id,
        kind,
        status,
        Math.floor(now / 1000),
        fingerprint,
        parseBrowser(ua).slice(0, 40),
        parseDeviceType(ua).slice(0, 16),
        referrer,
        country,
        publication.path,
        revision,
      ),
    ]
    if (kind === 'download') {
      statements.push(
        c.env.DB.prepare(
          'UPDATE scriptshub_snippets SET download_count = download_count + 1, last_used_at = ? WHERE user_id = ? AND id = ?',
        ).bind(now, publication.user_id, publication.snippet_id),
        c.env.DB.prepare(
          'UPDATE scriptshub_publications SET last_served_at = ? WHERE user_id = ? AND id = ?',
        ).bind(now, publication.user_id, publication.id),
      )
    }
    await c.env.DB.batch(statements)
  })().catch((error: unknown) => {
    console.warn('[inkstone] scriptshub event write failed:', error instanceof Error ? error.message : error)
  })
  try {
    c.executionCtx.waitUntil(record)
  } catch {
    void record
  }
}

async function publicationByPath(db: D1Database, path: string): Promise<PublicationRow | null> {
  return db.prepare(
    `SELECT p.id, p.user_id, p.snippet_id, p.file_id, p.path, p.is_enabled, p.visibility,
            p.token_hash, p.expires_at,
            s.title, s.description, s.language, s.source_url, s.updated_at
       FROM scriptshub_publications p
       JOIN scriptshub_snippets s ON s.user_id = p.user_id AND s.id = p.snippet_id
      WHERE p.path = ?`,
  ).bind(path).first<PublicationRow>()
}

async function currentFile(db: D1Database, row: PublicationRow): Promise<ServedFile | null> {
  return db.prepare(
    `SELECT id, name, language, content FROM scriptshub_files
      WHERE user_id = ? AND snippet_id = ? AND id = ?`,
  ).bind(row.user_id, row.snippet_id, row.file_id).first<ServedFile>()
}

async function revisionFile(db: D1Database, row: PublicationRow, version: number): Promise<{ file: ServedFile | null; found: boolean }> {
  const revision = await db.prepare(
    `SELECT files_json FROM scriptshub_revisions
      WHERE user_id = ? AND snippet_id = ? AND version = ?`,
  ).bind(row.user_id, row.snippet_id, version).first<{ files_json: string }>()
  if (!revision) return { file: null, found: false }
  try {
    const files = JSON.parse(revision.files_json) as unknown
    if (!Array.isArray(files)) return { file: null, found: true }
    const byId = files.find((entry) => {
      const file = entry as Record<string, unknown>
      return file?.id === row.file_id
    }) as Record<string, unknown> | undefined
    const chosen = byId ?? files[0] as Record<string, unknown> | undefined
    if (!chosen || typeof chosen.name !== 'string' || typeof chosen.content !== 'string') {
      return { file: null, found: true }
    }
    return {
      file: {
        id: typeof chosen.id === 'string' ? chosen.id : row.file_id,
        name: chosen.name,
        language: typeof chosen.language === 'string' ? chosen.language : row.language,
        content: chosen.content,
      },
      found: true,
    }
  } catch {
    return { file: null, found: true }
  }
}

function textResponse(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
}

async function handleScript(c: Context<AppBindings>): Promise<Response> {
  const rawPath = c.req.path.startsWith(PUBLIC_PATH_PREFIX)
    ? c.req.path.slice(PUBLIC_PATH_PREFIX.length)
    : ''
  let decoded = ''
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return textResponse(404, 'Not found')
  }
  const parsed = parsePublicationRequestPath(decoded)
  if (!parsed) return textResponse(404, 'Not found')
  const row = await publicationByPath(c.env.DB, parsed.path)
  if (!row) return textResponse(404, 'Not found')
  const now = Date.now()
  if (row.is_enabled !== 1) {
    recordEvent(c, row, 'disabled', 404, parsed.version)
    return textResponse(404, 'Not found')
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    recordEvent(c, row, 'expired', 404, parsed.version)
    return textResponse(404, 'Not found')
  }
  if (row.visibility === 'token') {
    const provided = c.req.query('token') ?? c.req.header('x-scriptshub-token') ?? ''
    const authorized = provided && await ScriptsHubStore.tokenMatches(provided, row.token_hash)
    if (!authorized) {
      recordEvent(c, row, 'forbidden', 403, parsed.version)
      return textResponse(403, 'Forbidden')
    }
  }
  const version = requestedRevision(c.req.query('v') ?? null, parsed.version)
  let file: ServedFile | null
  if (version !== null) {
    const resolved = await revisionFile(c.env.DB, row, version)
    if (!resolved.found) {
      recordEvent(c, row, 'missing_revision', 404, version)
      return textResponse(404, 'Not found')
    }
    file = resolved.file
  } else {
    file = await currentFile(c.env.DB, row)
  }
  if (!file) {
    recordEvent(c, row, 'missing_file', 404, version)
    return textResponse(404, 'Not found')
  }
  // A distribution path is public, so the only thing standing between it and a retry loop is this
  // rolling cap. The row is already written per served request, so counting them costs no extra table.
  const ip = (c.req.header('cf-connecting-ip') ?? '').trim()
  const ua = c.req.header('user-agent') ?? ''
  const fingerprint = await visitorFingerprint(ip, ua, c.env.SHORTLINKS_SECRET, now)
  if (fingerprint) {
    const since = Math.floor(now / 1000) - 60
    const recent = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM scriptshub_events WHERE user_id = ? AND visitor_fp = ? AND at >= ?',
    ).bind(row.user_id, fingerprint, since).first<{ n: number }>()
    if (Number(recent?.n ?? 0) >= REQUESTS_PER_MINUTE) {
      recordEvent(c, row, 'rate_limited', 429, version, fingerprint)
      return textResponse(429, 'Too many requests', { 'Retry-After': '60' })
    }
  }
  const sha256 = await sha256Hex(file.content)
  const headers = scriptResponseHeaders({
    contentType: contentTypeForFile(file.name, file.language),
    fileName: file.name,
    sha256,
    visibility: row.visibility === 'token' ? 'token' : 'public',
    enabled: true,
  })
  headers['Content-Length'] = String(new TextEncoder().encode(file.content).byteLength)
  const etag = scriptEtag(sha256)
  if (etagMatches(c.req.header('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'X-Checksum-Sha256': sha256,
        'Cache-Control': headers['Cache-Control']!,
      },
    })
  }
  recordEvent(c, row, c.req.method === 'HEAD' ? 'head' : 'download', 200, version)
  return new Response(c.req.method === 'HEAD' ? null : file.content, { status: 200, headers })
}

function renderUnavailable(locale: 'en-US' | 'zh-CN', copy: ScriptshubPublicCopy, status = 404): Response {
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(copy.unavailableTitle)}</title>
  <meta name="robots" content="noindex, nofollow" />
  <style>
    :root { color-scheme: light dark; --bg: #f7f3ec; --card: #fffdf9; --text: #2d2824; --muted: #776b62; --accent: #a53f32; --border: #e4d8ca; }
    @media (prefers-color-scheme: dark) { :root { --bg: #17130f; --card: #211b16; --text: #efe7dc; --muted: #a6988b; --accent: #d47561; --border: #3a2f27; } }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    main { max-width: 440px; padding: 32px; text-align: center; }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { color: var(--muted); line-height: 1.6; margin: 0; }
    .mark { color: var(--accent); font-size: 34px; line-height: 1; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main role="main">
    <div class="mark" aria-hidden="true">!</div>
    <h1>${escapeHtml(copy.unavailableTitle)}</h1>
    <p>${escapeHtml(copy.unavailableBody)}</p>
  </main>
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  })
}

async function handleDetail(c: Context<AppBindings>): Promise<Response> {
  const { locale, copy } = publicCopy(c.req.header('accept-language'))
  const id = c.req.param('id') ?? ''
  const row = await c.env.DB.prepare(
    `SELECT p.id, p.user_id, p.snippet_id, p.file_id, p.path, p.is_enabled, p.visibility,
            p.token_hash, p.expires_at,
            s.title, s.description, s.language, s.source_url, s.updated_at
       FROM scriptshub_publications p
       JOIN scriptshub_snippets s ON s.user_id = p.user_id AND s.id = p.snippet_id
      WHERE p.id = ?`,
  ).bind(id).first<PublicationRow>()
  if (!row || row.is_enabled !== 1 || row.visibility !== 'public'
    || (row.expires_at !== null && row.expires_at <= Date.now())) {
    return renderUnavailable(locale, copy)
  }
  const file = await currentFile(c.env.DB, row)
  if (!file) return renderUnavailable(locale, copy)
  const sha256 = await sha256Hex(file.content)
  const rawHref = publicationUrlPath(row.path)
  const language = languageFor(file.language)
  const siteName = c.env.APP_NAME || 'Inkstone'
  const description = row.description || `${row.title} · ${siteName}`
  const updated = new Date(row.updated_at).toISOString().slice(0, 10)
  const fileLanguage = language.id as ScriptLanguageId
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(row.title)} · ${escapeHtml(siteName)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(row.title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="robots" content="noindex, nofollow" />
  <style>
    :root { color-scheme: light dark; --bg: #f7f3ec; --card: #fffdf9; --sunken: #f1e9df; --text: #2d2824; --muted: #776b62; --accent: #a53f32; --border: #e4d8ca; }
    @media (prefers-color-scheme: dark) { :root { --bg: #17130f; --card: #211b16; --sunken: #191410; --text: #efe7dc; --muted: #a6988b; --accent: #d47561; --border: #3a2f27; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; line-height: 1.6; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 48px 20px 64px; }
    .eyebrow { color: var(--accent); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; font-weight: 600; }
    h1 { font-size: clamp(26px, 4vw, 38px); line-height: 1.2; margin: 10px 0 12px; letter-spacing: -.02em; }
    .lead { color: var(--muted); margin: 0 0 24px; max-width: 62ch; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 12px 0; margin-bottom: 24px; }
    .meta code { color: var(--text); font-family: var(--font-mono, ui-monospace, monospace); }
    .cmd { background: var(--sunken); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-x: auto; }
    .cmd .prefix { color: var(--muted); user-select: none; }
    h2 { font-size: 14px; margin: 28px 0 10px; color: var(--muted); font-weight: 600; }
    pre { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.55; max-height: 70vh; }
    a { color: var(--accent); }
    .foot { margin-top: 32px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 13px; }
    @media (max-width: 560px) { .wrap { padding-top: 32px; } pre { padding: 14px; font-size: 12px; } }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
    <h1>${escapeHtml(row.title)}</h1>
    ${row.description ? `<p class="lead">${escapeHtml(row.description)}</p>` : ''}
    <div class="meta">
      <span>${escapeHtml(copy.language)}: <code>${escapeHtml(fileLanguage)}</code></span>
      <span>${escapeHtml(copy.updated)}: <code>${escapeHtml(updated)}</code></span>
      <span>${escapeHtml(copy.checksum)}: <code>${escapeHtml(sha256.slice(0, 16))}…</code></span>
    </div>
    <h2>${escapeHtml(copy.install)}</h2>
    <div class="cmd"><span class="prefix">$ </span>curl -fsSL ${escapeHtml(c.req.url.replace(/\/sc-view\/.*/, rawHref))} | bash</div>
    <h2>${escapeHtml(copy.files)}</h2>
    <pre><code>${escapeHtml(file.content)}</code></pre>
    <div class="foot">
      <a class="btn" href="${escapeHtml(rawHref)}">${escapeHtml(copy.download)}</a>
      <span>${escapeHtml(copy.poweredBy)}${row.source_url && /^https?:\/\//i.test(row.source_url) ? ` · <a href="${escapeHtml(row.source_url)}" rel="nofollow noopener noreferrer">${escapeHtml(copy.source)}</a>` : ''}</span>
    </div>
  </main>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  })
}

scriptshubPublicRoutes.on(['GET', 'HEAD'], `${PUBLIC_PATH_PREFIX}*`, handleScript)
scriptshubPublicRoutes.get(`${DETAIL_PREFIX}:id`, handleDetail)
