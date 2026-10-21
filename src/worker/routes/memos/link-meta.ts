import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import { fetchMemoLinkMetadata, parseMemoLinkUrls } from '../../memos/link-meta'

export const memoLinkMetaRoutes = new Hono<AppBindings>()

memoLinkMetaRoutes.use('*', requireMemoUser)

memoLinkMetaRoutes.post('/', async (c) => {
  const body = await readJson<{ urls?: unknown }>(c, JSON_BODY_LIMITS.small)
  const urls = parseMemoLinkUrls(body.urls)
  const items = await fetchMemoLinkMetadata(c.env.DB, urls)
  return c.json({ items })
})
