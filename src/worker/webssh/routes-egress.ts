import { Hono, type Context } from 'hono'
import type {
  WebsshEgressTestResponse,
  WebsshEgressTestResult,
  WebsshEgressTestStep,
  WebsshRegionHint,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson, requestClientIp } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { hashAuditValue, recordAudit } from './audit'
import { isWebsshRegionHint, parseHostEgress, resolveEgressPlan } from './egress'
import { readWebsshSettings } from './settings'

export const websshEgressRoutes = new Hono<AppBindings>()

websshEgressRoutes.use('*', requireAuth)

const PROBE_MAX_REGIONS = 3

interface HostRow {
  id: string
  egress: string
}

function readProbeRegions(value: unknown, fallback: WebsshRegionHint[]): WebsshRegionHint[] {
  if (value === undefined || value === null) return fallback.slice(0, PROBE_MAX_REGIONS)
  if (!Array.isArray(value)) throw ApiError.badRequest('regions must be an array of region hints')
  const regions: WebsshRegionHint[] = []
  for (const item of value) {
    if (item === 'auto') {
      for (const region of fallback) if (!regions.includes(region)) regions.push(region)
      continue
    }
    if (!isWebsshRegionHint(item)) throw ApiError.badRequest('regions contains an unsupported hint')
    if (!regions.includes(item)) regions.push(item)
  }
  if (regions.length === 0) throw ApiError.badRequest('Choose at least one region')
  return regions.slice(0, PROBE_MAX_REGIONS)
}

function stepSummary(result: WebsshEgressTestResult): { phase: string; elapsedMs: number; forward?: string } {
  const last: WebsshEgressTestStep | undefined = result.steps.at(-1)
  const forward = result.steps.find((step) => step.phase === 'forward')
  return {
    phase: last?.phase ?? 'unknown',
    elapsedMs: result.steps.reduce((total, step) => total + step.elapsedMs, 0),
    ...(forward?.detail ? { forward: forward.detail } : {}),
  }
}

async function loadHost(c: Context<AppBindings>, userId: string, hostId: string): Promise<HostRow> {
  if (!isValidId(hostId)) throw ApiError.notFound('That host does not exist')
  const row = await c.env.DB.prepare(
    `SELECT id, egress FROM webssh_hosts WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId)
    .first<HostRow>()
  if (!row) throw ApiError.notFound('That host does not exist')
  return row
}

websshEgressRoutes.post('/hosts/:id/egress-test', async (c) => {
  const userId = c.get('userId')
  const namespace = c.env.WEBSSH_SESSION
  if (!namespace) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')
  const host = await loadHost(c, userId, c.req.param('id'))
  const settings = await readWebsshSettings(c.env.DB, userId)
  const plan = resolveEgressPlan(parseHostEgress(host.egress), settings.egress)
  if (!plan.available) {
    throw new ApiError(
      400,
      'egress_mode_unavailable',
      'Relay egress modes need a relay node and are not available yet',
    )
  }
  const body = await readJson<{ regions?: unknown }>(c, 4096)
  const regions = readProbeRegions(body.regions, plan.regionCandidates)

  const ipHash = await hashAuditValue(requestClientIp(c))
  const results: WebsshEgressTestResult[] = []
  for (const region of regions) {
    const id = namespace.newUniqueId()
    const stub = namespace.get(id, { locationHint: region })
    const url = `https://webssh.internal/internal/egress-probe?u=${encodeURIComponent(userId)}&h=${encodeURIComponent(host.id)}&r=${encodeURIComponent(region)}`
    const response = await stub.fetch(new Request(url, { method: 'POST' }))
    if (!response.ok) {
      results.push({
        region,
        ok: false,
        steps: [],
        failure: {
          name: 'EgressProbeError',
          message: `The probe answered HTTP ${response.status}`,
          phase: 'connect',
          address: '',
          port: 0,
          elapsedMs: 0,
          mode: plan.mode,
          region,
          retryable: true,
        },
      })
      continue
    }
    const result = await response.json() as WebsshEgressTestResult
    results.push(result)
    const summary = stepSummary(result)
    await recordAudit(c.env.DB, {
      userId,
      hostId: host.id,
      ipHash,
      eventType: 'egress_test',
      metadata: {
        region,
        ok: result.ok,
        phase: summary.phase,
        elapsedMs: summary.elapsedMs,
        ...(summary.forward ? { forward: summary.forward } : {}),
      },
    }).catch((error) => console.warn('[inkstone] WebSSH egress test audit failed:', error instanceof Error ? error.message : String(error)))
  }
  return c.json<WebsshEgressTestResponse>({ results })
})
