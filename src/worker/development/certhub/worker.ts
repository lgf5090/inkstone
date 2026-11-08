import type { Env } from '../../env'
import { newId } from '../../lib/id'
import { CERTHUB_LIMITS } from '@shared/development/certhub/limits'
import { advanceOrder, renewOrder } from './state-machine'
import {
  appendEvent,
  claimJobForOrder,
  claimJobs,
  finishJob,
  listDomains,
  listDueRenewals,
  listExpiring,
  pruneEvents,
  readConfig,
  updateOrder,
  type JobRow,
} from './store'
import { notifyCerthub } from './notify'

async function runJob(env: Env, db: D1Database, job: JobRow): Promise<void> {
  try {
    const result = await advanceOrder(env, db, job.user_id, job.order_id, 'system')
    if (result.retryAfterMs > 0) {
      await finishJob(db, job, { ok: false, errorCode: 'retry_later', errorMessage: 'The order is not ready yet', retryAfterMs: result.retryAfterMs })
      return
    }
    await finishJob(db, job, { ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The certificate job failed'
    const exhausted = job.attempts >= job.max_attempts
    await finishJob(db, job, {
      ok: false,
      errorCode: 'job_failed',
      errorMessage: message.slice(0, 160),
    })
    if (exhausted) {
      await updateOrder(db, job.user_id, job.order_id, {
        status: 'failed',
        failure_code: 'job_failed',
        failure_message: message.slice(0, 160),
        updated_at: Date.now(),
      })
      await appendEvent(db, {
        userId: job.user_id,
        orderId: job.order_id,
        actor: 'system',
        kind: 'job.dead',
        level: 'error',
        messageCode: 'job.dead',
        detail: { message: message.slice(0, 160) },
      })
    }
  }
}

export async function kickOrder(env: Env, db: D1Database, userId: string, orderId: string): Promise<void> {
  const owner = `kick:${newId()}`
  const job = await claimJobForOrder(db, owner, userId, orderId)
  if (!job) return
  await runJob(env, db, job)
}

async function expireCertificates(db: D1Database): Promise<void> {
  const now = Date.now()
  const { results } = await db.prepare(`SELECT user_id, id, cert_not_after FROM development_certhub_orders
    WHERE status = 'issued' AND cert_not_after IS NOT NULL AND cert_not_after <= ?1 AND deleted_at IS NULL
    LIMIT ?2`).bind(now, 100).all<{ user_id: string; id: string; cert_not_after: number }>()
  for (const row of results) {
    await updateOrder(db, row.user_id, row.id, { status: 'expired', updated_at: now })
    await appendEvent(db, {
      userId: row.user_id,
      orderId: row.id,
      actor: 'system',
      kind: 'cert.expired',
      level: 'warn',
      messageCode: 'cert.expired',
      detail: { notAfter: row.cert_not_after },
    })
  }
}

async function renewCertificates(env: Env, db: D1Database): Promise<void> {
  for (const order of await listExpiring(db, CERTHUB_LIMITS.renewScanPerTick)) {
    const domains = await listDomains(db, order.user_id, order.id)
    await notifyCerthub(env, db, {
      userId: order.user_id,
      orderId: order.id,
      event: 'expiring',
      ca: order.ca,
      domains: domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)),
      notAfter: order.cert_not_after,
    })
  }
  const due = await listDueRenewals(db, CERTHUB_LIMITS.renewScanPerTick)
  for (const order of due) {
    try {
      await renewOrder(env, db, order.user_id, order.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'renewal failed'
      await updateOrder(db, order.user_id, order.id, {
        renew_at: Date.now() + 6 * 60 * 60_000,
        failure_code: 'renew_failed',
        failure_message: message.slice(0, 160),
        updated_at: Date.now(),
      })
      await appendEvent(db, {
        userId: order.user_id,
        orderId: order.id,
        actor: 'system',
        kind: 'renew.failed',
        level: 'error',
        messageCode: 'renew.failed',
        detail: { message: message.slice(0, 160) },
      })
      const domains = await listDomains(db, order.user_id, order.id)
      await notifyCerthub(env, db, {
        userId: order.user_id,
        orderId: order.id,
        event: 'renew_failed',
        ca: order.ca,
        domains: domains.map((domain) => (domain.wildcard === 1 ? `*.${domain.name}` : domain.name)),
        notAfter: order.cert_not_after,
      })
    }
  }
}

async function cleanup(db: D1Database): Promise<void> {
  const before = Date.now() - CERTHUB_LIMITS.eventRetentionDays * 86_400_000
  await pruneEvents(db, before, CERTHUB_LIMITS.cleanupPerTick)
  await db.prepare(`DELETE FROM development_certhub_jobs WHERE status IN ('done','failed','dead','canceled')
    AND updated_at < ?1 LIMIT 500`).bind(Date.now() - 30 * 86_400_000).run()
}

export async function runCerthubTick(env: Env, scheduledTime: number): Promise<void> {
  void scheduledTime
  const config = await readConfig(env.DB)
  const owner = `cron:${newId()}`
  const jobs = await claimJobs(env.DB, owner, config.jobBatchSize)
  for (const job of jobs) await runJob(env, env.DB, job)
  await expireCertificates(env.DB)
  await renewCertificates(env, env.DB)
  await cleanup(env.DB)
}
