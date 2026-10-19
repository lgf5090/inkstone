/**
 * The subscription app's HTTP surface.
 *
 * Static paths are registered before `/:id`, because Hono matches in registration order and
 * `/settings` would otherwise be read as the id of a subscription named "settings". Everything below
 * the first `use` requires a session, and every query goes through the store, which scopes by the
 * account the session named — an id from another account is a 404 rather than a 403, because a refusal
 * that confirms an id exists is still a leak.
 *
 * Validation lives here rather than in the store: the store's job is the rules that must hold whatever
 * the caller sent, while "a name is required and at most 120 characters" is a property of the request.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { newId } from '../lib/id'
import { requireAuth } from '../middleware/auth'
import {
  defaultPresetRules,
  isChannelKind,
  isCurrencyCode,
  isPeriodUnit,
  isSubscriptionMode,
  type SubscriptionInput,
  type SubscriptionSettings,
} from '@shared/subscriptions/model'
import { buildNotificationBody, subjectOf } from '../subscriptions/notify-content'
import { buildOverview } from '../subscriptions/overview'
import { dispatch, testChannel } from '../subscriptions/channels'
import { queryNotifyLogs, recentScheduleLogs } from '../subscriptions/logs'
import {
  clearChannel,
  enabledChannels,
  listChannels,
  loadSettings,
  readChannelConfig,
  recordChannelTest,
  rotateInboundToken,
  saveChannel,
  saveSettings,
} from '../subscriptions/settings'
import { SubscriptionsStore, storeContext, type StoreContext } from '../subscriptions/store'

const BODY_LIMIT = 32 * 1024

type Ctx = Context<AppBindings>

export const subscriptionRoutes = new Hono<AppBindings>()

subscriptionRoutes.use('*', requireAuth)

function storeOf(c: Ctx): SubscriptionsStore {
  return new SubscriptionsStore(c.env.DB, c.get('userId')!)
}

async function contextOf(c: Ctx): Promise<{ store: SubscriptionsStore; context: StoreContext; settings: SubscriptionSettings }> {
  const settings = await loadSettings(c.env.DB, c.get('userId')!)
  return { store: storeOf(c), context: storeContext(settings), settings }
}

/** The store throws short codes for the rules it will not break; this is where they become sentences. */
function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('missing:')) throw ApiError.badRequest(`The ${message.slice(8)} field is required`)
  if (message.startsWith('invalid_url:')) throw ApiError.badRequest(`The ${message.slice(12)} field is not a valid address`)
  if (message.startsWith('invalid_json:')) throw ApiError.badRequest(`The ${message.slice(13)} field is not valid JSON`)
  if (message === 'invalid_expiry') throw ApiError.badRequest('An expiry date is required')
  if (message === 'lunar_out_of_range') throw ApiError.badRequest('That lunar date is outside 1900-2100')
  if (message === 'invalid_timezone') throw ApiError.badRequest('That time zone is not recognised')
  throw error
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`)
  return trimmed
}

function optionalText(value: unknown, max: number, field: string): string | undefined {
  return value === undefined ? undefined : text(value, max, field)
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest(`${field} is required`)
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
  if (!Number.isFinite(parsed)) throw ApiError.badRequest(`${field} is not a date`)
  return value.trim()
}

function optionalDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return requireDate(value, field)
}

function amountOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1_000_000_000) {
    throw ApiError.badRequest('The amount must be a positive number')
  }
  return Math.round(numeric * 100) / 100
}

function positiveInt(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined
  const numeric = Math.trunc(Number(value))
  if (!Number.isFinite(numeric) || numeric < 1) throw ApiError.badRequest('That number must be at least 1')
  return Math.min(max, numeric)
}

function inputOf(raw: Record<string, unknown>): SubscriptionInput {
  const name = text(raw.name, 120, 'Name')
  if (!name) throw ApiError.badRequest('A name is required')
  const currency = raw.currency
  if (currency !== undefined && !isCurrencyCode(currency)) throw ApiError.badRequest('That currency is not supported')
  const periodUnit = raw.periodUnit
  if (periodUnit !== undefined && !isPeriodUnit(periodUnit)) throw ApiError.badRequest('That period unit is not supported')
  const mode = raw.subscriptionMode
  if (mode !== undefined && !isSubscriptionMode(mode)) throw ApiError.badRequest('That billing mode is not supported')

  return {
    name,
    customType: optionalText(raw.customType, 40, 'Type'),
    category: optionalText(raw.category, 40, 'Category'),
    amount: amountOf(raw.amount),
    currency: currency as SubscriptionInput['currency'],
    startDate: optionalDate(raw.startDate, 'Start date'),
    expiryDate: requireDate(raw.expiryDate, 'Expiry date'),
    periodValue: positiveInt(raw.periodValue, 120),
    periodUnit: periodUnit as SubscriptionInput['periodUnit'],
    subscriptionMode: mode as SubscriptionInput['subscriptionMode'],
    useLunar: raw.useLunar === undefined ? undefined : raw.useLunar === true,
    isActive: raw.isActive === undefined ? undefined : raw.isActive === true,
    autoRenew: raw.autoRenew === undefined ? undefined : raw.autoRenew === true,
    notes: optionalText(raw.notes, 2000, 'Notes'),
    reminderRules: Array.isArray(raw.reminderRules) ? raw.reminderRules as SubscriptionInput['reminderRules'] : undefined,
  }
}

subscriptionRoutes.get('/', async (c) => {
  const { store, context, settings } = await contextOf(c)
  const [items, categories, channels, overview] = await Promise.all([
    store.list(context),
    store.listCategories(),
    listChannels(c.env.DB, c.get('userId')!),
    buildOverview(c.env, c.env.DB, c.get('userId')!, settings, context.now),
  ])
  return c.json({ items, categories, settings, channels, overview })
})

subscriptionRoutes.post('/', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const input = inputOf(raw)
  const { store, context } = await contextOf(c)
  try {
    return c.json(await store.create(input, context), 201)
  } catch (error) {
    fail(error)
  }
})

subscriptionRoutes.get('/categories', async (c) => {
  return c.json({ categories: await storeOf(c).listCategories() })
})

subscriptionRoutes.post('/categories', async (c) => {
  const raw = await readJson<{ name?: unknown }>(c, 4096)
  const name = text(raw.name, 40, 'Name')
  if (!name) throw ApiError.badRequest('A category name is required')
  const store = storeOf(c)
  await store.addCategory(name)
  return c.json({ categories: await store.listCategories() })
})

subscriptionRoutes.get('/settings', async (c) => {
  const { settings } = await contextOf(c)
  return c.json({ settings })
})

subscriptionRoutes.put('/settings', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, 8192)
  try {
    return c.json({ settings: await saveSettings(c.env.DB, c.get('userId')!, raw) })
  } catch (error) {
    fail(error)
  }
})

subscriptionRoutes.post('/inbound-token', async (c) => {
  return c.json(await rotateInboundToken(c.env.DB, c.get('userId')!))
})

subscriptionRoutes.get('/channels', async (c) => {
  return c.json({ channels: await listChannels(c.env.DB, c.get('userId')!) })
})

subscriptionRoutes.put('/channels/:kind', async (c) => {
  const kind = c.req.param('kind')
  if (!isChannelKind(kind)) throw ApiError.notFound('Unknown channel')
  const raw = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  try {
    return c.json({ channel: await saveChannel(c.env, c.env.DB, c.get('userId')!, kind, raw) })
  } catch (error) {
    fail(error)
  }
})

subscriptionRoutes.delete('/channels/:kind', async (c) => {
  const kind = c.req.param('kind')
  if (!isChannelKind(kind)) throw ApiError.notFound('Unknown channel')
  await clearChannel(c.env.DB, c.get('userId')!, kind)
  return c.json({ channels: await listChannels(c.env.DB, c.get('userId')!) })
})

subscriptionRoutes.post('/channels/:kind/test', async (c) => {
  const kind = c.req.param('kind')
  if (!isChannelKind(kind)) throw ApiError.notFound('Unknown channel')
  const settings = await loadSettings(c.env.DB, c.get('userId')!)
  const stored = await readChannelConfig(c.env, c.env.DB, c.get('userId')!, kind)
  if (!stored) throw ApiError.badRequest('That channel has not been configured yet')
  const result = await testChannel(kind, stored.config, { timezone: settings.timezone, locale: settings.locale })
  await recordChannelTest(c.env.DB, c.get('userId')!, kind, result.success ? 'success' : 'failed', result.error ?? '')
  return c.json({ result })
})

subscriptionRoutes.get('/logs/notify', async (c) => {
  const query = c.req.query()
  return c.json({
    logs: await queryNotifyLogs(c.env.DB, c.get('userId')!, {
      subscriptionId: query.subscriptionId || undefined,
      channel: isChannelKind(query.channel) ? query.channel : undefined,
      status: query.status === 'success' || query.status === 'failed' ? query.status : undefined,
      since: query.since || undefined,
      until: query.until || undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  })
})

subscriptionRoutes.get('/logs/schedule', async (c) => {
  const limit = Number(c.req.query('limit') ?? 20)
  return c.json({ logs: await recentScheduleLogs(c.env.DB, c.get('userId')!, Number.isFinite(limit) ? limit : 20) })
})

subscriptionRoutes.get('/:id', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json(detail)
})

subscriptionRoutes.put('/:id', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const input = inputOf(raw)
  const { store, context } = await contextOf(c)
  try {
    const detail = await store.update(c.req.param('id'), input, context)
    if (!detail) throw ApiError.notFound('That subscription does not exist')
    return c.json(detail)
  } catch (error) {
    fail(error)
  }
})

subscriptionRoutes.delete('/:id', async (c) => {
  if (!await storeOf(c).remove(c.req.param('id'))) throw ApiError.notFound('That subscription does not exist')
  return c.json({ ok: true })
})

subscriptionRoutes.post('/:id/toggle', async (c) => {
  const raw = await readJson<{ isActive?: unknown }>(c, 4096)
  const { store, context } = await contextOf(c)
  const detail = await store.setActive(c.req.param('id'), raw.isActive === true, context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json(detail)
})

subscriptionRoutes.post('/:id/renew', async (c) => {
  const raw = await readJson<{ paymentDate?: unknown; amount?: unknown; periodMultiplier?: unknown; note?: unknown }>(c, 8192)
  const { store, context } = await contextOf(c)
  const detail = await store.renew(c.req.param('id'), {
    paymentDate: raw.paymentDate === undefined ? undefined : requireDate(raw.paymentDate, 'Payment date'),
    amount: amountOf(raw.amount) ?? undefined,
    periodMultiplier: positiveInt(raw.periodMultiplier, 120),
    note: optionalText(raw.note, 200, 'Note'),
  }, context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json(detail)
})

subscriptionRoutes.post('/:id/test-notify', async (c) => {
  const { store, context, settings } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  const channels = await enabledChannels(c.env, c.env.DB, c.get('userId')!)
  if (channels.length === 0) throw ApiError.badRequest('No notification channel is enabled')

  const rule = detail.rules[0] ?? { type: 'on_expiry' as const, value: 0, unit: 'days' as const, repeatInterval: null }
  const body = buildNotificationBody([
    subjectOf(detail.item, detail.item.daysRemaining, detail.item.hoursRemaining, {
      type: rule.type,
      value: rule.value,
      unit: rule.unit,
      repeatInterval: rule.repeatInterval,
    }),
  ], settings, context.now)

  return c.json({
    result: await dispatch(
      { title: body.title, content: body.content, metadata: { tags: [detail.item.name] } },
      channels,
      { timezone: settings.timezone, locale: settings.locale, now: context.now },
    ),
  })
})

subscriptionRoutes.get('/:id/payments', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json({ payments: detail.payments })
})

subscriptionRoutes.put('/:id/payments/:paymentId', async (c) => {
  const raw = await readJson<{ date?: unknown; amount?: unknown; currency?: unknown; note?: unknown }>(c, 8192)
  if (raw.currency !== undefined && !isCurrencyCode(raw.currency)) throw ApiError.badRequest('That currency is not supported')
  const { store, context } = await contextOf(c)
  const detail = await store.updatePayment(c.req.param('id'), c.req.param('paymentId'), {
    date: raw.date === undefined ? undefined : requireDate(raw.date, 'Payment date'),
    amount: amountOf(raw.amount) ?? undefined,
    currency: raw.currency as string | undefined,
    note: optionalText(raw.note, 200, 'Note'),
  }, context)
  if (!detail) throw ApiError.notFound('That payment record does not exist')
  return c.json(detail)
})

subscriptionRoutes.delete('/:id/payments/:paymentId', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.deletePayment(c.req.param('id'), c.req.param('paymentId'), context)
  if (!detail) throw ApiError.notFound('That payment record does not exist')
  return c.json(detail)
})

subscriptionRoutes.get('/:id/reminders', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json({ rules: detail.rules })
})

subscriptionRoutes.post('/:id/reminders', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, 8192)
  const store = storeOf(c)
  const id = c.req.param('id')
  if (raw.preset === true) {
    const rules = await store.replaceRules(id, defaultPresetRules(newId))
    if (!rules) throw ApiError.notFound('That subscription does not exist')
    return c.json({ rules })
  }
  const rule = await store.addRule(id, raw)
  if (!rule) throw ApiError.badRequest('That subscription does not exist, or already holds the maximum number of rules')
  return c.json({ rule })
})

subscriptionRoutes.put('/:id/reminders', async (c) => {
  const raw = await readJson<{ rules?: unknown }>(c, 16384)
  if (!Array.isArray(raw.rules)) throw ApiError.badRequest('Rules must be a list')
  const rules = await storeOf(c).replaceRules(c.req.param('id'), raw.rules as never)
  if (!rules) throw ApiError.notFound('That subscription does not exist')
  return c.json({ rules })
})

subscriptionRoutes.put('/:id/reminders/:ruleId', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, 8192)
  const rule = await storeOf(c).updateRule(c.req.param('id'), c.req.param('ruleId'), raw)
  if (!rule) throw ApiError.notFound('That rule does not exist')
  return c.json({ rule })
})

subscriptionRoutes.delete('/:id/reminders/:ruleId', async (c) => {
  if (!await storeOf(c).deleteRule(c.req.param('id'), c.req.param('ruleId'))) {
    throw ApiError.notFound('That rule does not exist')
  }
  return c.json({ ok: true })
})

subscriptionRoutes.get('/:id/next-reminder', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json({ nextReminder: detail.nextReminder, allUpcoming: detail.upcoming })
})
