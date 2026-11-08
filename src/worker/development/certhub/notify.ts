import type { Env } from '../../env'
import { newId } from '../../lib/id'
import { normalizeAssistantSettings } from '@shared/assistant'
import { AssistantStore } from '../../assistant/store'
import type { CerthubCa } from '@shared/development/certhub/types'
import { EN_US_CERTHUB_NOTIFY } from '../../../shared/locales/en-US-certhub-notify'
import { ZH_CN_CERTHUB_NOTIFY } from '../../../shared/locales/zh-CN-certhub-notify'
import { appendEvent, readSettings } from './store'

export type CerthubNotifyEvent = 'issued' | 'renewed' | 'renew_failed' | 'failed' | 'expiring' | 'revoked'

interface NotifyInput {
  userId: string
  orderId: string
  event: CerthubNotifyEvent
  ca: CerthubCa
  domains: string[]
  notAfter?: number | null
}

const DEDUPE_FOREVER: ReadonlySet<CerthubNotifyEvent> = new Set(['issued', 'renewed', 'expiring', 'revoked'])
const FAILURE_COOLDOWN_MS = 60 * 60_000
const RATE_WINDOW_MS = 10 * 60_000
const RATE_LIMIT = 6

function enabled(event: CerthubNotifyEvent, flags: {
  notifyOnIssued: boolean
  notifyOnFailed: boolean
  notifyOnExpiring: boolean
}): boolean {
  if (event === 'issued' || event === 'renewed') return flags.notifyOnIssued
  if (event === 'renew_failed' || event === 'failed') return flags.notifyOnFailed
  if (event === 'expiring') return flags.notifyOnExpiring
  return true
}

function label(domains: string[]): string {
  if (domains.length === 0) return 'certificate'
  const first = domains[0]!
  return domains.length > 1 ? `${first} +${domains.length - 1}` : first
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function copyFor(language: string, event: CerthubNotifyEvent, input: NotifyInput): { title: string; body: string } {
  const copy = language === 'en-US' ? EN_US_CERTHUB_NOTIFY : ZH_CN_CERTHUB_NOTIFY
  const values = {
    name: label(input.domains),
    ca: input.ca,
    domains: input.domains.join(', '),
    expiry: input.notAfter ? new Date(input.notAfter).toISOString().slice(0, 10) : '-',
  }
  const templates: Record<CerthubNotifyEvent, { title: string; body: string }> = {
    issued: { title: copy.issuedTitle, body: copy.issuedBody },
    renewed: { title: copy.renewedTitle, body: copy.renewedBody },
    renew_failed: { title: copy.renewFailedTitle, body: copy.renewFailedBody },
    failed: { title: copy.failedTitle, body: copy.failedBody },
    expiring: { title: copy.expiringTitle, body: copy.expiringBody },
    revoked: { title: copy.revokedTitle, body: copy.revokedBody },
  }
  const template = templates[event]
  return { title: fill(template.title, values), body: fill(template.body, values) }
}

export async function notifyCerthub(env: Env, db: D1Database, input: NotifyInput): Promise<boolean> {
  const settings = await readSettings(db, input.userId)
  if (!enabled(input.event, settings)) return false
  const marker = `notify.${input.event}`
  const now = Date.now()
  const { results: recent } = await db.prepare(`SELECT COUNT(*) AS n FROM development_certhub_events
    WHERE user_id = ?1 AND kind LIKE 'notify.%' AND kind <> 'notify.sent' AND created_at >= ?2`)
    .bind(input.userId, now - RATE_WINDOW_MS).all<{ n: number }>()
  if ((recent[0]?.n ?? 0) >= RATE_LIMIT) return false
  const since = DEDUPE_FOREVER.has(input.event) ? 0 : now - FAILURE_COOLDOWN_MS
  const inserted = await db.prepare(`INSERT INTO development_certhub_events (
    user_id, id, order_id, domain_id, actor, kind, level, message_code, detail_json, created_at
  )
  SELECT ?1, ?2, ?3, '', 'system', ?4, 'info', ?4, '{}', ?5
   WHERE NOT EXISTS (
     SELECT 1 FROM development_certhub_events
      WHERE user_id = ?1 AND order_id = ?3 AND kind = ?4 AND created_at >= ?6
   )`)
    .bind(input.userId, newId(), input.orderId, marker, now, since).run()
  if ((inserted.meta.changes ?? 0) === 0) return false
  const store = new AssistantStore(db, input.userId, env)
  const assistant = normalizeAssistantSettings(await store.getSettings())
  const copy = copyFor(assistant.language, input.event, input)
  await store.createNotification({ title: copy.title, body: copy.body })
  await appendEvent(db, {
    userId: input.userId,
    orderId: input.orderId,
    actor: 'system',
    kind: 'notify.sent',
    messageCode: 'notify.sent',
    detail: { event: input.event },
  })
  return true
}

export function notifyFromOrder(
  env: Env,
  db: D1Database,
  order: { id: string; user_id: string; ca: CerthubCa; cert_not_after: number | null; renew_from_order_id: string | null },
  domains: string[],
  event?: CerthubNotifyEvent,
): Promise<boolean> {
  const kind = event ?? (order.renew_from_order_id ? 'renewed' : 'issued')
  return notifyCerthub(env, db, {
    userId: order.user_id,
    orderId: order.id,
    event: kind,
    ca: order.ca,
    domains,
    notAfter: order.cert_not_after,
  })
}
