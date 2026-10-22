import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import {
  createMemoWebhook,
  deleteMemoWebhook,
  listMemoWebhooks,
  regenerateMemoWebhookSecret,
  updateMemoWebhook,
  type MemoWebhookFields,
} from '../../memos/webhooks'

function webhookId(c: Context<AppBindings>): string {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Webhook not found')
  return id
}

export const memoWebhookRoutes = new Hono<AppBindings>()

memoWebhookRoutes.use('*', requireMemoUser)

memoWebhookRoutes.get('/', async (c) => {
  const webhooks = await listMemoWebhooks(c.env.DB, c.get('userId'))
  return c.json({ webhooks })
})

memoWebhookRoutes.post('/', async (c) => {
  const body = await readJson<MemoWebhookFields>(c, JSON_BODY_LIMITS.small)
  const result = await createMemoWebhook(c.env, c.get('userId'), body)
  return c.json(result, 201)
})

memoWebhookRoutes.patch('/:id', async (c) => {
  const body = await readJson<MemoWebhookFields>(c, JSON_BODY_LIMITS.small)
  const webhook = await updateMemoWebhook(c.env.DB, c.get('userId'), webhookId(c), body)
  if (!webhook) throw ApiError.notFound('Webhook not found')
  return c.json(webhook)
})

memoWebhookRoutes.delete('/:id', async (c) => {
  const deleted = await deleteMemoWebhook(c.env.DB, c.get('userId'), webhookId(c))
  if (!deleted) throw ApiError.notFound('Webhook not found')
  return c.json({ ok: true })
})

memoWebhookRoutes.post('/:id/secret', async (c) => {
  const result = await regenerateMemoWebhookSecret(c.env, c.get('userId'), webhookId(c))
  if (!result) throw ApiError.notFound('Webhook not found')
  return c.json(result)
})
