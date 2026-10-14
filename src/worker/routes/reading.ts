/**
 * Word lookup and translation, through this deployment.
 *
 * The reader asks for a translation of a passage it selected, and the answer comes from a free
 * public endpoint that only speaks to a server: the browser cannot call it directly (the app's
 * `connect-src` allows only this origin), and asking the client to name an arbitrary URL would turn a
 * translation button into a redirector. So the target host is fixed here, and the only thing a caller
 * chooses is the text and the language.
 *
 * The AI engine is deliberately absent from this route: an AI translation goes through the reader's own
 * configured provider and the existing `/api/ai` relay, which is where that credential belongs.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'
import { createMinuteBudget } from '../lib/rate-limit'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { isBlockedTarget } from '@shared/ai-proxy-guard'

const TRANSLATE_HOST = 'translate.googleapis.com'
const MAX_TEXT_CHARS = 1200
/** Per isolate, so it is a runaway-client brake rather than a quota. The body cap is the real limit. */
const BUDGET_PER_MINUTE = 40

export const readingRoutes = new Hono<AppBindings>()
readingRoutes.use('*', requireAuth)

interface TranslatePayload {
  text?: unknown
  to?: unknown
  from?: unknown
}

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?(?:-[A-Za-z]{2})?$/

const takeBudget = createMinuteBudget(BUDGET_PER_MINUTE, 'Translation limit reached. Try again in a minute.')

/**
 * Google's `gtx` endpoint answers with a nested array whose first element holds the sentence chunks.
 * Anything else — an error page, a rate-limit notice, a differently shaped body — yields no text, and
 * the caller reports that as a failed translation rather than showing a fragment of JSON.
 */
function extractTranslation(payload: unknown): { text: string; detected: string } {
  if (!Array.isArray(payload)) return { text: '', detected: '' }
  const chunks = payload[0]
  let text = ''
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      if (Array.isArray(chunk) && typeof chunk[0] === 'string') text += chunk[0]
    }
  }
  const source = payload[2]
  return { text, detected: typeof source === 'string' ? source : '' }
}

readingRoutes.post('/translate', async (c) => {
  const userId = c.get('userId') ?? 'anonymous'
  takeBudget(userId)
  const data = await readJson<TranslatePayload>(c, 8 * 1024)
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  const to = typeof data.to === 'string' ? data.to : 'en'
  const from = typeof data.from === 'string' && data.from !== 'auto' ? data.from : 'auto'
  if (!text) throw ApiError.badRequest('Nothing to translate')
  if (text.length > MAX_TEXT_CHARS) throw ApiError.badRequest('The selection is too long to translate in one go')
  if (!LANGUAGE.test(to) || (from !== 'auto' && !LANGUAGE.test(from))) throw ApiError.badRequest('Unsupported language code')

  const url = new URL(`https://${TRANSLATE_HOST}/translate_a/single`)
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', from)
  url.searchParams.set('tl', to)
  url.searchParams.set('dt', 't')
  url.searchParams.set('q', text)
  if (isBlockedTarget(url.hostname)) throw ApiError.badRequest('Unsupported translation host')

  let upstream: Response
  try {
    upstream = await fetch(url.toString(), { headers: { accept: 'application/json' }, redirect: NO_REDIRECT })
  } catch {
    throw ApiError.badRequest('The translation service could not be reached')
  }
  if (isRedirectResponse(upstream)) throw ApiError.badRequest('The translation service redirected')
  if (!upstream.ok) throw ApiError.badRequest(`The translation service replied ${upstream.status}`)

  const body = await upstream.json().catch((): null => null)
  const translated = extractTranslation(body)
  if (!translated.text.trim()) throw ApiError.badRequest('The translation service returned no text')
  return c.json({
    translated: translated.text.trim(),
    detected: translated.detected || null,
    chars: text.length,
  })
})
