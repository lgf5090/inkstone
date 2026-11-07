/**
 * Public Edge Redirect Engine with Password Gate and Async Analytics (`/l/:slug`).
 */

import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { EN_US_SHORTLINKS_PUBLIC, type ShortlinksPublicCopy } from '@shared/locales/en-US-shortlinks-public'
import { ZH_CN_SHORTLINKS_PUBLIC } from '@shared/locales/zh-CN-shortlinks-public'
import { urlProblem } from '@shared/tools/shortlinks/schemas'
import { parseRoutingRules, pickRoutingTarget } from '@shared/tools/shortlinks/routing'
import type { AppBindings } from '../env'
import { escapeHtml } from '../lib/encoding'
import { verifyPassword } from '../lib/password'
import { computeVisitorFingerprint } from '../tools/shortlinks/fingerprint'
import {
  AUTH_TOKEN_TTL_SECONDS,
  attemptBucket,
  authCookieName,
  isLegacyDigest,
  legacyDigest,
  mintAuthToken,
  verifyAuthToken,
} from '../tools/shortlinks/password-gate'
import { isSelfReferrer, parseReferrerHost } from '../tools/shortlinks/referrer'
import { isSocialCrawler, parseOgPreview, renderOgPage } from '../tools/shortlinks/og'
import { fetchPageMetadata } from '../tools/shortlinks/title-fetch'
import { ShortlinksStore } from '../tools/shortlinks/store'
import { parseUserAgentInfo } from '../tools/shortlinks/ua'

export const toolsShortlinksRedirectRoutes = new Hono<AppBindings>()

/**
 * The language a public page answers in.
 *
 * A short link is opened by whoever received it, not by the deployment's owner, so the deployment
 * setting would be the wrong guess. `Accept-Language` is the reader's own statement; anything that
 * does not ask for Chinese gets English, which is the catalog's source language.
 */
export function shortlinksPublicCopy(acceptLanguage: string | undefined): { locale: 'en-US' | 'zh-CN'; copy: ShortlinksPublicCopy } {
  return (acceptLanguage ?? '').toLowerCase().startsWith('zh')
    ? { locale: 'zh-CN', copy: ZH_CN_SHORTLINKS_PUBLIC }
    : { locale: 'en-US', copy: EN_US_SHORTLINKS_PUBLIC }
}

function renderPasswordPage(
  slug: string,
  locale: 'en-US' | 'zh-CN',
  copy: ShortlinksPublicCopy,
  errorMsg?: string,
  status = 401,
): Response {
  const safeSlug = encodeURIComponent(slug)
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(copy.passwordTitle)} - Inkstone Shortlinks</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
      --border: #334155;
    }
    body {
      margin: 0;
      padding: 0;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 2.5rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 1.5rem auto;
      color: var(--primary);
      display: block;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      text-align: center;
      margin: 0 0 0.5rem 0;
    }
    p {
      color: var(--text-muted);
      font-size: 0.875rem;
      text-align: center;
      margin: 0 0 1.5rem 0;
      line-height: 1.5;
    }
    .error {
      background-color: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--danger);
      color: var(--danger);
      padding: 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
      text-align: center;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 0.5rem;
    }
    input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background-color: var(--bg);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
    button {
      width: 100%;
      padding: 0.75rem;
      margin-top: 1.25rem;
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 0.5rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    button:hover {
      background-color: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="card" role="main">
    <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
    </svg>
    <h1>${escapeHtml(copy.passwordHeading)}</h1>
    <p>${escapeHtml(copy.passwordMessage)}</p>
    ${errorMsg ? `<div class="error" role="alert">${escapeHtml(errorMsg)}</div>` : ''}
    <form method="POST" action="/l/${safeSlug}">
      <div>
        <label for="password">${escapeHtml(copy.passwordLabel)}</label>
        <input type="password" id="password" name="password" required autofocus autocomplete="current-password" placeholder="${escapeHtml(copy.passwordPlaceholder)}" />
      </div>
      <button type="submit">${escapeHtml(copy.passwordSubmit)}</button>
    </form>
  </div>
</body>
</html>`

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function renderNotFoundPage(
  locale: 'en-US' | 'zh-CN',
  title: string,
  message: string,
): Response {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} - Inkstone Shortlinks</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .box {
      text-align: center;
      max-width: 420px;
      padding: 2rem;
    }
    h1 { font-size: 4rem; margin: 0 0 1rem 0; color: #64748b; }
    h2 { font-size: 1.5rem; margin: 0 0 0.5rem 0; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="box">
    <h1>404</h1>
    <h2>${safeTitle}</h2>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`

  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function renderUnsafePage(slug: string, locale: 'en-US' | 'zh-CN', copy: ShortlinksPublicCopy): Response {
  const safeSlug = encodeURIComponent(slug)
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(copy.unsafeTitle)} - Inkstone Shortlinks</title>
  <style>
    body { margin: 0; background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .box { text-align: center; max-width: 460px; padding: 2rem; }
    h1 { font-size: 3rem; margin: 0 0 1rem 0; color: #f59e0b; }
    h2 { font-size: 1.4rem; margin: 0 0 0.75rem 0; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; }
    form { margin-top: 1.5rem; }
    button { background: #3b82f6; color: white; border: 0; border-radius: 8px; padding: 0.7rem 1.2rem; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #2563eb; }
    a { display: block; margin-top: 1rem; color: #64748b; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>!</h1>
    <h2>${escapeHtml(copy.unsafeTitle)}</h2>
    <p>${escapeHtml(copy.unsafeMessage)}</p>
    <form method="post" action="/l/${safeSlug}">
      <input type="hidden" name="confirm" value="1" />
      <button type="submit">${escapeHtml(copy.unsafeConfirm)}</button>
    </form>
    <a href="/">${escapeHtml(copy.unsafeCancel)}</a>
  </div>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function handleRedirect(c: Context<AppBindings>, providedPassword?: string, confirmedByForm = false) {
  const { locale, copy } = shortlinksPublicCopy(c.req.header('accept-language'))
  const slug = c.req.param('slug')
  if (!slug) {
    return renderNotFoundPage(locale, copy.notFoundTitle, copy.notFoundMessage)
  }

  // 1. Resolve the slug from D1
  const lookup = new ShortlinksStore(c.env.DB, '')
  const dbRecord = await lookup.findSlugForRedirect(slug)
  if (!dbRecord) {
    return renderNotFoundPage(locale, copy.notFoundTitle, copy.notFoundMessage)
  }

  let entry = {
    url: dbRecord.url,
    link_id: dbRecord.link_id,
    user_id: dbRecord.user_id,
    disabled_at: dbRecord.disabled_at,
    expires_at: dbRecord.expires_at,
    password_hash: dbRecord.password_hash,
    edge_flags: dbRecord.edge_flags,
    routing_rules: dbRecord.routing_rules,
    og_preview: dbRecord.og_preview,
    label: dbRecord.label,
  }

  // 2. Status checks
  if (entry.disabled_at != null) {
    return renderNotFoundPage(locale, copy.disabledTitle, copy.disabledMessage)
  }

  const unsafeConfirmed = confirmedByForm || c.req.header('x-link-confirm') === '1'
  if ((entry.edge_flags & 1) && !unsafeConfirmed) {
    return renderUnsafePage(slug, locale, copy)
  }

  const now = Math.floor(Date.now() / 1000)
  if (entry.expires_at != null && entry.expires_at <= now) {
    return renderNotFoundPage(locale, copy.expiredTitle, copy.expiredMessage)
  }

  // A stored target that is not a web address cannot be handed to a browser as `Location`; older
  // rows may predate the schema check, so the same rule is enforced again at the edge.
  if (urlProblem(entry.url)) {
    return renderNotFoundPage(locale, copy.invalidTargetTitle, copy.invalidTargetMessage)
  }

  const store = new ShortlinksStore(c.env.DB, entry.user_id)
  // Cloudflare stamps this header on every edge request; a client-supplied X-Forwarded-For never decides a bucket or a fingerprint.
  const ip = (c.req.header('cf-connecting-ip') || '').trim()
  let issuedCookie: string | null = null

  // 3. Password Gate
  if (entry.password_hash) {
    let authKey: string = entry.password_hash
    const submittedPassword = (providedPassword ?? '').trim()
    const submitted = submittedPassword.length > 0
    const bucket = ip ? await attemptBucket(slug, ip) : null

    if (bucket) {
      const gate = await store.passwordGateState(bucket, now)
      if (gate.blocked) {
        return renderPasswordPage(
          slug,
          locale,
          copy,
          copy.tooManyAttempts.replace('{minutes}', String(Math.ceil(gate.retryAfter / 60))),
          429,
        )
      }
    }

    let verified = false
    if (submitted) {
      verified = await verifyPassword(submittedPassword, authKey)
      if (!verified && isLegacyDigest(authKey)) {
        // One-way upgrade for a link still holding the module's original unsalted SHA-256 digest.
        if ((await legacyDigest(submittedPassword)) === authKey) {
          verified = true
          authKey = await store.upgradePasswordHash(entry.link_id, submittedPassword)
          entry = { ...entry, password_hash: authKey }
        }
      }
      if (!verified) {
        if (bucket) await store.recordPasswordFailure(bucket, now)
        return renderPasswordPage(slug, locale, copy, copy.wrongPassword)
      }
      if (bucket) await store.clearPasswordFailures(bucket)
      issuedCookie = await mintAuthToken(authKey, slug, now + AUTH_TOKEN_TTL_SECONDS)
    } else {
      const token = getCookie(c, authCookieName(slug))
      verified = Boolean(token) && (await verifyAuthToken(token as string, authKey, slug, now))
    }

    if (!verified) {
      return renderPasswordPage(slug, locale, copy)
    }
  }

  // 4. Async Click Tracking via ctx.waitUntil
  const ua = c.req.header('user-agent') || ''
  const referer = c.req.header('referer') || null
  const country = c.req.header('cf-ipcountry') || null
  const region = c.req.header('cf-region') || null
  const city = c.req.header('cf-ipcity') || null
  const requestHost = c.req.header('host') || ''

  const uaInfo = parseUserAgentInfo(ua)
  const referrerHost = parseReferrerHost(referer)
  const isLoop = isSelfReferrer(referer, requestHost)

  // Social crawlers see a preview page instead of the redirect. Stored overrides win; missing pieces
  // are read from the target under a short timeout, and a slow or broken target falls back to the
  // ordinary redirect so a preview can never hold the hop hostage.
  const storedOg = parseOgPreview(entry.og_preview)
  if (isSocialCrawler(ua)) {
    const missingOg = !storedOg?.title || !storedOg?.description || !storedOg?.image
    const fetchedOg = missingOg ? await fetchPageMetadata(entry.url, 1200) : null
    const title = storedOg?.title || fetchedOg?.title || null
    const description = storedOg?.description || fetchedOg?.description || null
    const image = storedOg?.image || fetchedOg?.image || null
    if (title || description || image) {
      const html = renderOgPage({
        title: title || entry.label || entry.url,
        description,
        image,
        shortUrl: new URL(c.req.url).toString(),
        target: entry.url,
        locale,
      })
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': fetchedOg ? 'no-store' : 'public, max-age=300',
        },
      })
    }
  }

  const urlObj = new URL(c.req.url)
  const utmSource = urlObj.searchParams.get('utm_source')
  const utmMedium = urlObj.searchParams.get('utm_medium')
  const utmCampaign = urlObj.searchParams.get('utm_campaign')
  const utmTerm = urlObj.searchParams.get('utm_term')
  const utmContent = urlObj.searchParams.get('utm_content')

  const isQr = utmMedium === 'qr' || urlObj.searchParams.get('src') === 'qr' || urlObj.searchParams.get('qr') === '1'
  const linkMode = isQr ? 'qr' : 'link'

  const recordPromise = (async () => {
    try {
      const visitorFp = await computeVisitorFingerprint(ip, ua, c.env.SHORTLINKS_SECRET)
      await store.recordClick(slug, entry.link_id, entry.user_id, {
        referrer: referer,
        referrerHost,
        country,
        region,
        city,
        deviceType: uaInfo.deviceType,
        os: uaInfo.os,
        browser: uaInfo.browser,
        isBot: uaInfo.isBot,
        linkMode,
        utmSource,
        utmMedium,
        utmCampaign,
        utmTerm,
        utmContent,
        userAgent: ua,
        isSelfReferrer: isLoop ? 1 : 0,
        visitorFp,
      })
    } catch {
      // Best-effort record swallow in click tracker
    }
  })()

  try {
    c.executionCtx.waitUntil(recordPromise)
  } catch {
    // Execution context is not present in local test environments; wait for record directly
    await recordPromise.catch(() => {
      // Best-effort swallow of click tracking failure when background execution context is unavailable
    })
  }

  // A protected hop depends on a cookie, so a cached 302 would replay it for whoever shares the cache.
  const rules = parseRoutingRules(entry.routing_rules)
  let destination = entry.url
  const routed = pickRoutingTarget(rules, uaInfo.deviceType, country)
  if (routed.target && !urlProblem(routed.target)) destination = routed.target
  if (entry.edge_flags & 2) {
    const target = new URL(destination)
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (key !== 'confirm') target.searchParams.set(key, value)
    }
    destination = target.toString()
  }
  const headers: Record<string, string> = {
    Location: destination,
    'Cache-Control': entry.password_hash || unsafeConfirmed ? 'no-store' : 'private, max-age=30',
  }
  if (rules.devices) headers.Vary = 'User-Agent'

  if (issuedCookie) {
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''
    headers['Set-Cookie'] =
      `${authCookieName(slug)}=${encodeURIComponent(issuedCookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_TOKEN_TTL_SECONDS}${secure}`
  }

  return new Response(null, {
    status: routed.status,
    headers,
  })
}

toolsShortlinksRedirectRoutes.get('/l/:slug', async (c) => {
  return handleRedirect(c)
})

toolsShortlinksRedirectRoutes.post('/l/:slug', async (c) => {
  let password = ''
  let confirm = false
  try {
    const body = await c.req.parseBody()
    password = String(body['password'] || '')
    confirm = String(body['confirm'] || '') === '1'
  } catch {
    // Non-fatal
  }
  return handleRedirect(c, password, confirm)
})
