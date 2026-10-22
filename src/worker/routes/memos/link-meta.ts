import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'
import { requireMemoUser } from '../../memos/auth'
import { fetchMemoLinkMetadata, parseMemoLinkUrls } from '../../memos/link-meta'

export const MEMO_LINK_META_HOURLY_ATTEMPTS = 120
const LINK_META_WINDOW_MS = 60 * 60 * 1000

export const memoLinkMetaRoutes = new Hono<AppBindings>()

memoLinkMetaRoutes.use('*', requireMemoUser)

memoLinkMetaRoutes.post('/', async (c) => {
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{
      key: `memo-link-meta:${c.get('userId')}`,
      maxAttempts: MEMO_LINK_META_HOURLY_ATTEMPTS,
      windowMs: LINK_META_WINDOW_MS,
    }]),
    'Too many link previews',
  )
  const body = await readJson<{ urls?: unknown }>(c, JSON_BODY_LIMITS.small)
  const urls = parseMemoLinkUrls(body.urls)
  const items = await fetchMemoLinkMetadata(c.env.DB, urls)
  return c.json({ items })
})
