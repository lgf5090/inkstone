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
  BULK_ACTIONS,
  BULK_LIMIT,
  defaultPresetRules,
  isChannelKind,
  isCurrencyCode,
  isLabelKind,
  isPeriodUnit,
  isSubscriptionMode,
  LABEL_MAX,
  type SubscriptionInput,
  type SubscriptionSettings,
  type LabelKind,
  type BulkAction,
} from '@shared/subscriptions/model'
import { buildNotificationBody, subjectOf } from '../subscriptions/notify-content'
import { normalizeColor, normalizeIcon } from '@shared/subscriptions/identity'
import { SUBSCRIPTION_SEARCH_LIMIT, SUBSCRIPTION_SEARCH_MAX, searchSubscriptions } from '@shared/subscriptions/search'
import { buildOverview } from '../subscriptions/overview'
import { dispatch, testChannel } from '../subscriptions/channels'
import { queryNotifyLogs, recentScheduleLogs } from '../subscriptions/logs'
import {
  channelHasSecrets,
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
/** Rows one import may carry. Above this a reader is syncing, not migrating, and needs a real tool. */
const IMPORT_LIMIT = 500

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
  if (message === 'invalid_base_currency') throw ApiError.badRequest('That currency is not supported')
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
    trialEndsAt: optionalDate(raw.trialEndsAt, 'Trial end date'),
    reminderRules: Array.isArray(raw.reminderRules) ? raw.reminderRules as SubscriptionInput['reminderRules'] : undefined,
  }
}

subscriptionRoutes.get('/', async (c) => {
  const { store, context, settings } = await contextOf(c)
  const [items, types, categories, channels, overview, trashCount] = await Promise.all([
    store.list(context),
    store.listLabels('type'),
    store.listLabels('category'),
    listChannels(c.env.DB, c.get('userId')!),
    buildOverview(c.env, c.env.DB, c.get('userId')!, settings, context.now),
    store.trashCount(),
  ])
  return c.json({ items, types, categories, settings, channels, overview, trashCount })
})

subscriptionRoutes.get('/trash', async (c) => {
  const { store, context } = await contextOf(c)
  return c.json({ items: await store.list(context, 'trash') })
})

/**
 * The rows a global search can name.
 *
 * Registered above `/:id`, because a literal segment after a parameter route would be swallowed by it and
 * answer with whatever subscription happens to be called `search`. Live rows only: the trash is reached
 * from the app's own rail, and a search that silently resurrects deleted plans in its results is worse
 * than one that omits them.
 */
subscriptionRoutes.get('/search', async (c) => {
  const { store, context } = await contextOf(c)
  const query = (c.req.query('q') ?? '').slice(0, SUBSCRIPTION_SEARCH_MAX)
  const limit = Number(c.req.query('limit') ?? SUBSCRIPTION_SEARCH_LIMIT)
  const items = searchSubscriptions(await store.list(context), query, Number.isFinite(limit) ? limit : SUBSCRIPTION_SEARCH_LIMIT)
  return c.json({ items })
})

subscriptionRoutes.post('/trash/empty', async (c) => {
  const { store } = await contextOf(c)
  return c.json({ purged: await store.emptyTrash() })
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

/**
 * The label registry: types and categories, which are the same resource wearing two names.
 *
 * `kind` is an enum and so is safe as a path segment. A label *name* is free text — it may hold a
 * space, a comma, CJK, and after a rename anything the reader typed — so it travels in the body or a
 * query parameter rather than a path segment, where a slash would silently become a route that does
 * not exist. Category names can never contain a slash, because the separator splits on it, but a route
 * that depends on that being true is one bad validation away from a 404 that looks like a missing label.
 */
function kindOf(value: string | undefined): LabelKind {
  if (!isLabelKind(value)) throw ApiError.badRequest('Unknown label kind')
  return value
}

subscriptionRoutes.get('/labels/:kind', async (c) => {
  const kind = kindOf(c.req.param('kind'))
  return c.json({ labels: await storeOf(c).listLabels(kind) })
})

subscriptionRoutes.post('/labels/:kind', async (c) => {
  const kind = kindOf(c.req.param('kind'))
  const raw = await readJson<{ name?: unknown }>(c, 4096)
  const name = text(raw.name, LABEL_MAX, 'Name')
  if (!name) throw ApiError.badRequest('A label name is required')
  const store = storeOf(c)
  await store.registerLabels(kind, name)
  return c.json({ labels: await store.listLabels(kind) })
})

subscriptionRoutes.put('/labels/:kind/style', async (c) => {
  const kind = kindOf(c.req.param('kind'))
  const raw = await readJson<{ name?: unknown; icon?: unknown; color?: unknown }>(c, 4096)
  const name = text(raw.name, LABEL_MAX, 'Name')
  if (!name) throw ApiError.badRequest('A label name is required')
  // Only the axes the request actually names are passed on. Sending `color: null` because the caller
  // said nothing about colour would clear it, and a colour change would quietly cost the reader an icon.
  const patch: { icon?: string | null; color?: string | null } = {}
  if ('icon' in raw) patch.icon = typeof raw.icon === 'string' ? raw.icon : null
  if ('color' in raw) patch.color = typeof raw.color === 'string' ? raw.color : null
  if (!('icon' in patch) && !('color' in patch)) throw ApiError.badRequest('Say which part of the face to change')
  if (patch.icon && !normalizeIcon(patch.icon)) throw ApiError.badRequest('That icon is not one the app offers')
  if (patch.color && !normalizeColor(patch.color)) throw ApiError.badRequest('That colour is not one the app offers')
  const label = await storeOf(c).setLabelStyle(kind, name, patch)
  if (!label) throw ApiError.badRequest('The label could not be saved')
  return c.json({ label })
})

subscriptionRoutes.put('/labels/:kind/rename', async (c) => {
  const kind = kindOf(c.req.param('kind'))
  const raw = await readJson<{ name?: unknown; to?: unknown }>(c, 4096)
  const name = text(raw.name, LABEL_MAX, 'Name')
  const to = text(raw.to, LABEL_MAX, 'Name')
  if (!name || !to) throw ApiError.badRequest('A label name is required')
  const store = storeOf(c)
  const renamed = await store.renameLabel(kind, name, to)
  if (!renamed) throw ApiError.badRequest('That label was not renamed — the new name may already be taken')
  return c.json({ labels: await store.listLabels(kind) })
})

subscriptionRoutes.delete('/labels/:kind', async (c) => {
  const kind = kindOf(c.req.param('kind'))
  const name = c.req.query('name') ?? ''
  if (!name.trim()) throw ApiError.badRequest('A label name is required')
  const store = storeOf(c)
  await store.removeLabel(kind, name)
  return c.json({ labels: await store.listLabels(kind) })
})

/**
 * One action over a named set.
 *
 * `trash` rather than purge: a bulk operation is the one place where a wrong choice is multiplied by
 * however many rows were selected, so the recoverable verb is the only one offered.
 */
subscriptionRoutes.post('/bulk', async (c) => {
  const raw = await readJson<{ ids?: unknown; action?: unknown; category?: unknown }>(c, BODY_LIMIT)
  const action = String(raw.action ?? '')
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) throw ApiError.badRequest('That bulk action is not supported')
  if (!Array.isArray(raw.ids)) throw ApiError.badRequest('ids must be a list')
  const ids = raw.ids.filter((id): id is string => typeof id === 'string').slice(0, BULK_LIMIT)
  if (!ids.length) throw ApiError.badRequest('Name at least one subscription')
  const category = action === 'set_category' ? text(raw.category, LABEL_MAX, 'Category') : undefined
  if (action === 'set_category' && !category) throw ApiError.badRequest('A category name is required')
  const changed = await storeOf(c).bulk(ids, action as BulkAction, { category })
  return c.json({ changed })
})

/**
 * Rows from a CSV the browser parsed.
 *
 * The file is read on the client and the rows arrive as JSON so that every value goes through the same
 * `inputOf` guard a hand-typed form does — a spreadsheet is an untrusted input surface like any other,
 * and a bad row is reported rather than half-written.
 */
subscriptionRoutes.post('/import', async (c) => {
  const raw = await readJson<{ rows?: unknown }>(c, 512 * 1024)
  if (!Array.isArray(raw.rows)) throw ApiError.badRequest('rows must be a list')
  if (raw.rows.length > IMPORT_LIMIT) throw ApiError.badRequest(`A single import is limited to ${IMPORT_LIMIT} rows`)
  const store = storeOf(c)
  const { context } = await contextOf(c)
  const skipped: Array<{ row: number; reason: string }> = []
  let created = 0
  for (const [index, entry] of raw.rows.entries()) {
    if (!entry || typeof entry !== 'object') {
      skipped.push({ row: index + 1, reason: 'Not a row' })
      continue
    }
    try {
      await store.create(inputOf(entry as Record<string, unknown>), context)
      created++
    } catch (error) {
      // One bad line should not cost the reader the other two hundred, but it must not be swallowed
      // either: the reason comes back so the import result can say what was not written.
      skipped.push({
        row: index + 1,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'Rejected',
      })
    }
  }
  return c.json({ created, skipped })
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
  // A kind with no fields has no bundle to read, so its own switch is the whole configuration.
  const stored = channelHasSecrets(kind)
    ? await readChannelConfig(c.env, c.env.DB, c.get('userId')!, kind)
    : { config: {} as Record<string, unknown> }
  if (!stored) throw ApiError.badRequest('That channel has not been configured yet')
  const result = await testChannel(kind, stored.config, { timezone: settings.timezone, locale: settings.locale }, { env: c.env, userId: c.get('userId')! })
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

/** To the trash, not gone: the receipts and rules stay, and a restore is one column wide. */
subscriptionRoutes.delete('/:id', async (c) => {
  const { store, context } = await contextOf(c)
  if (!await store.trash(c.req.param('id'), context)) throw ApiError.notFound('That subscription does not exist')
  return c.json({ ok: true })
})

subscriptionRoutes.post('/:id/restore', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.restore(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription is not in the trash')
  return c.json(detail)
})

subscriptionRoutes.delete('/:id/purge', async (c) => {
  const { store } = await contextOf(c)
  if (!await store.purge(c.req.param('id'))) throw ApiError.notFound('That subscription does not exist')
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
      { env: c.env, userId: c.get('userId')! },
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

subscriptionRoutes.post('/:id/reminders/:ruleId/acknowledge', async (c) => {
  const { store, context } = await contextOf(c)
  const rule = await store.acknowledgeRule(c.req.param('id'), c.req.param('ruleId'), context)
  if (!rule) throw ApiError.notFound('That rule does not exist')
  return c.json({ rule })
})

subscriptionRoutes.get('/:id/next-reminder', async (c) => {
  const { store, context } = await contextOf(c)
  const detail = await store.get(c.req.param('id'), context)
  if (!detail) throw ApiError.notFound('That subscription does not exist')
  return c.json({ nextReminder: detail.nextReminder, allUpcoming: detail.upcoming })
})
