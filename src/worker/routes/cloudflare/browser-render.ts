/**
 * `/api/cloudflare/browser-render` — one URL, one rendering mode.
 *
 * The response is the render itself (a data URL, HTML, Markdown or a link list) with the browser
 * time it cost. Every refusal is an `ApiError`: the client's ordinary error path already shows the
 * sentence and the status, and a second envelope would only give it two shapes to read.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { createAuditLog } from '../../cloudflare/audit'
import {
  renderWithFailover,
  RENDER_BROWSERS,
  RENDER_MODES,
  type RenderBrowser,
  type RenderMode,
} from '../../cloudflare/browser-render'

export const browserRenderRouter = new Hono<AppBindings>()

browserRenderRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => null) as {
    url?: unknown
    mode?: unknown
    browser?: unknown
    accountId?: unknown
  } | null
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  if (!url) throw ApiError.badRequest('A URL is required')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw ApiError.badRequest('That URL is not a valid address')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ApiError.badRequest('Only http and https addresses can be rendered')
  }

  const mode = (body?.mode ?? 'screenshot') as RenderMode
  if (!RENDER_MODES.includes(mode)) {
    throw ApiError.badRequest(`Unknown rendering mode: ${String(body?.mode)}`)
  }
  const browser = (body?.browser ?? 'chrome') as RenderBrowser
  if (!RENDER_BROWSERS.includes(browser)) {
    throw ApiError.badRequest(`Unknown browser engine: ${String(body?.browser)}`)
  }
  const accountId = typeof body?.accountId === 'string' && body.accountId ? body.accountId : undefined

  const outcome = await renderWithFailover(c.env, userId, { url, mode, browser, accountId })
  await createAuditLog(
    c.env,
    userId,
    outcome.accountId,
    'browser_render',
    url,
    `mode=${mode} browser=${browser} ${Math.round(outcome.result.browserMsUsed)}ms`,
    'success',
  )
  return c.json(outcome.result)
})
