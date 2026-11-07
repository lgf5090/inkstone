import { Hono, type Context } from 'hono'
import type { WebsshDashboard, WebsshDashboardExport, WebsshDashboardListResponse } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  defaultDashboardWidgets,
  normalizeDashboardExport,
  normalizeDashboardName,
  normalizeDashboardWidgets,
  WebsshDashboardsStore,
} from './dashboards'

export const websshDashboardRoutes = new Hono<AppBindings>()

const DASHBOARD_BODY_LIMIT = 32 * 1024

function store(c: Context<AppBindings>): WebsshDashboardsStore {
  return new WebsshDashboardsStore(c.env.DB, c.get('userId'))
}

function dashboardId(c: Context<AppBindings>): string {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('Invalid dashboard id')
  return id
}

function invalidDashboard(error: unknown): never {
  if (error instanceof Error && /^(invalid_dashboard|too_many_widgets)/.test(error.message)) {
    throw ApiError.badRequest(error.message)
  }
  throw error
}

websshDashboardRoutes.get('/dashboards', async (c) => {
  return c.json<WebsshDashboardListResponse>({ dashboards: await store(c).list() })
})

websshDashboardRoutes.post('/dashboards', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, DASHBOARD_BODY_LIMIT)
  try {
    const name = normalizeDashboardName(body.name ?? 'Dashboard', true)
    const widgets = body.widgets === undefined ? defaultDashboardWidgets() : normalizeDashboardWidgets(body.widgets)
    return c.json<{ dashboard: WebsshDashboard }>({ dashboard: await store(c).create(name, widgets) }, 201)
  } catch (error) {
    return invalidDashboard(error)
  }
})

websshDashboardRoutes.patch('/dashboards/:id', async (c) => {
  const id = dashboardId(c)
  const body = await readJson<Record<string, unknown>>(c, DASHBOARD_BODY_LIMIT)
  let name: string | undefined
  try {
    name = body.name === undefined ? undefined : normalizeDashboardName(body.name, false)
  } catch (error) {
    return invalidDashboard(error)
  }
  const locked = typeof body.locked === 'boolean' ? body.locked : undefined
  if (name === undefined && locked === undefined) throw ApiError.badRequest('Nothing to update')
  const dashboards = store(c)
  const changed = await dashboards.updateMeta(id, { ...(name === undefined ? {} : { name }), ...(locked === undefined ? {} : { locked }) })
  if (!changed) throw ApiError.notFound('That dashboard does not exist')
  const dashboard = await dashboards.get(id)
  if (!dashboard) throw ApiError.notFound('That dashboard does not exist')
  return c.json<{ dashboard: WebsshDashboard }>({ dashboard })
})

websshDashboardRoutes.delete('/dashboards/:id', async (c) => {
  const id = dashboardId(c)
  const removed = await store(c).remove(id)
  if (!removed) throw ApiError.notFound('That dashboard does not exist')
  return c.json({ ok: true })
})

websshDashboardRoutes.put('/dashboards/:id/layout', async (c) => {
  const id = dashboardId(c)
  const body = await readJson<Record<string, unknown>>(c, DASHBOARD_BODY_LIMIT)
  let widgets
  try {
    widgets = normalizeDashboardWidgets(body.widgets)
  } catch (error) {
    return invalidDashboard(error)
  }
  const dashboards = store(c)
  if (!await dashboards.replaceLayout(id, widgets)) throw ApiError.notFound('That dashboard does not exist')
  const dashboard = await dashboards.get(id)
  if (!dashboard) throw ApiError.notFound('That dashboard does not exist')
  return c.json<{ dashboard: WebsshDashboard }>({ dashboard })
})

websshDashboardRoutes.get('/dashboards/:id/export', async (c) => {
  const dashboard = await store(c).get(dashboardId(c))
  if (!dashboard) throw ApiError.notFound('That dashboard does not exist')
  const layout: WebsshDashboardExport = {
    version: 1,
    name: dashboard.name,
    locked: dashboard.locked,
    widgets: dashboard.widgets.map(({ type, x, y, w, h, config }) => ({ type, x, y, w, h, config })),
  }
  return c.json<{ layout: WebsshDashboardExport }>({ layout })
})

websshDashboardRoutes.post('/dashboards/import', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, DASHBOARD_BODY_LIMIT)
  try {
    const layout = normalizeDashboardExport(body.layout)
    const widgets = normalizeDashboardWidgets(layout.widgets)
    return c.json<{ dashboard: WebsshDashboard }>({ dashboard: await store(c).create(layout.name, widgets) }, 201)
  } catch (error) {
    return invalidDashboard(error)
  }
})

