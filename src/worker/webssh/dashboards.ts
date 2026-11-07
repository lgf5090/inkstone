import type { D1Database } from '@cloudflare/workers-types'
import type {
  WebsshDashboard,
  WebsshDashboardExport,
  WebsshDashboardWidget,
} from '@shared/webssh/types'
import { WEBSSH_WIDGET_TYPES } from '@shared/webssh/types'
import { isValidId, newId } from '../lib/id'

export const WEBSSH_DASHBOARD_WIDGET_LIMIT = 24
const DASHBOARD_NAME_MAX = 60
const GRID_COLUMNS = 12
const GRID_MAX_Y = 64
const CONFIG_MAX_BYTES = 1_024

const DEFAULT_WIDGET_RECTS: ReadonlyArray<Pick<WebsshDashboardWidget, 'type' | 'x' | 'y' | 'w' | 'h'>> = [
  { type: 'resources', x: 0, y: 0, w: 6, h: 4 },
  { type: 'network', x: 6, y: 0, w: 6, h: 4 },
  { type: 'processes', x: 0, y: 4, w: 6, h: 4 },
  { type: 'containers', x: 6, y: 4, w: 6, h: 4 },
]

export function defaultDashboardWidgets(): WebsshDashboardWidget[] {
  return DEFAULT_WIDGET_RECTS.map((rect) => ({ ...rect, id: newId(), config: {} }))
}

export function normalizeDashboardName(value: unknown, required: boolean): string {
  if (value === undefined) {
    if (required) throw new Error('invalid_dashboard_name')
    return ''
  }
  if (typeof value !== 'string') throw new Error('invalid_dashboard_name')
  const name = value.trim()
  if (name.length === 0 || name.length > DASHBOARD_NAME_MAX) throw new Error('invalid_dashboard_name')
  return name
}

function isWidgetType(value: unknown): value is WebsshDashboardWidget['type'] {
  return typeof value === 'string' && (WEBSSH_WIDGET_TYPES as readonly string[]).includes(value)
}

function normalizeConfig(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const config: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 32) continue
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      config[key] = typeof entry === 'string' ? entry.slice(0, 120) : entry
    }
  }
  if (JSON.stringify(config).length > CONFIG_MAX_BYTES) return {}
  return config
}

function gridNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Turns one widget from a request or an imported file into a rectangle the grid can draw. */
export function normalizeDashboardWidget(value: unknown, usedIds: Set<string>): WebsshDashboardWidget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isWidgetType(record.type)) return null
  const w = gridNumber(record.w, 6, 1, GRID_COLUMNS)
  const h = gridNumber(record.h, 4, 2, 12)
  const x = gridNumber(record.x, 0, 0, GRID_COLUMNS - w)
  const y = gridNumber(record.y, 0, 0, GRID_MAX_Y)
  const requestedId = typeof record.id === 'string' && isValidId(record.id) && !usedIds.has(record.id) ? record.id : newId()
  usedIds.add(requestedId)
  return { id: requestedId, type: record.type, x, y, w, h, config: normalizeConfig(record.config) }
}

export function normalizeDashboardWidgets(value: unknown): WebsshDashboardWidget[] {
  if (!Array.isArray(value)) throw new Error('invalid_dashboard_widgets')
  if (value.length > WEBSSH_DASHBOARD_WIDGET_LIMIT) throw new Error('too_many_widgets')
  const usedIds = new Set<string>()
  const widgets: WebsshDashboardWidget[] = []
  for (const entry of value) {
    const widget = normalizeDashboardWidget(entry, usedIds)
    if (!widget) throw new Error('invalid_dashboard_widgets')
    widgets.push(widget)
  }
  return widgets
}

export function normalizeDashboardExport(value: unknown): WebsshDashboardExport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_dashboard_file')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('invalid_dashboard_version')
  const name = normalizeDashboardName(record.name, true)
  return {
    version: 1,
    name,
    locked: record.locked === true,
    widgets: normalizeDashboardWidgets(record.widgets).map(({ type, x, y, w, h, config }) => ({ type, x, y, w, h, config })),
  }
}

interface DashboardRow {
  id: string
  name: string
  locked: number
  created_at: number
  updated_at: number
}

interface WidgetRow {
  dashboard_id: string
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  config: string
}

function widgetFromRow(row: WidgetRow): WebsshDashboardWidget | null {
  if (!isWidgetType(row.type)) return null
  const config = JSON.parse(row.config || '{}') as Record<string, string | number | boolean | null>
  return {
    id: row.id,
    type: row.type,
    x: Math.max(0, Math.min(GRID_COLUMNS - 1, Number(row.x))),
    y: Math.max(0, Number(row.y)),
    w: Math.max(1, Math.min(GRID_COLUMNS, Number(row.w))),
    h: Math.max(2, Math.min(12, Number(row.h))),
    config: config && typeof config === 'object' && !Array.isArray(config) ? config : {},
  }
}

export class WebsshDashboardsStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly now: number = Date.now(),
  ) {}

  async list(): Promise<WebsshDashboard[]> {
    const { results: rows } = await this.db.prepare(
      `SELECT id, name, locked, created_at, updated_at
         FROM webssh_dashboards
        WHERE user_id = ?1
        ORDER BY is_default DESC, updated_at DESC`,
    )
      .bind(this.userId)
      .all<DashboardRow>()
    if (rows.length === 0) {
      const created = await this.create('Default', defaultDashboardWidgets())
      return [created]
    }
    const { results: widgetRows } = await this.db.prepare(
      `SELECT dashboard_id, id, type, x, y, w, h, config
         FROM webssh_dashboard_widgets
        WHERE user_id = ?1
        ORDER BY dashboard_id, y, x`,
    )
      .bind(this.userId)
      .all<WidgetRow>()
    const byDashboard = new Map<string, WebsshDashboardWidget[]>()
    for (const row of widgetRows) {
      const widget = widgetFromRow(row)
      if (!widget) continue
      const list = byDashboard.get(row.dashboard_id) ?? []
      list.push(widget)
      byDashboard.set(row.dashboard_id, list)
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      locked: Number(row.locked) === 1,
      widgets: byDashboard.get(row.id) ?? [],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  async get(id: string): Promise<WebsshDashboard | null> {
    const row = await this.db.prepare(
      `SELECT id, name, locked, created_at, updated_at
         FROM webssh_dashboards
        WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id)
      .first<DashboardRow>()
    if (!row) return null
    const { results } = await this.db.prepare(
      `SELECT dashboard_id, id, type, x, y, w, h, config
         FROM webssh_dashboard_widgets
        WHERE user_id = ?1 AND dashboard_id = ?2
        ORDER BY y, x`,
    )
      .bind(this.userId, id)
      .all<WidgetRow>()
    return {
      id: row.id,
      name: row.name,
      locked: Number(row.locked) === 1,
      widgets: results.map(widgetFromRow).filter((widget): widget is WebsshDashboardWidget => widget !== null),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  async create(name: string, widgets: readonly WebsshDashboardWidget[]): Promise<WebsshDashboard> {
    const id = newId()
    const statements = [
      this.db.prepare(
        `INSERT INTO webssh_dashboards (user_id, id, name, locked, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 0, ?4, ?4)`,
      ).bind(this.userId, id, name, this.now),
      ...widgets.map((widget) => this.insertWidgetStatement(id, widget, this.now)),
    ]
    await this.db.batch(statements)
    return {
      id,
      name,
      locked: false,
      widgets: widgets.map((widget) => ({ ...widget, config: { ...widget.config } })),
      createdAt: this.now,
      updatedAt: this.now,
    }
  }

  async updateMeta(id: string, input: { name?: string; locked?: boolean }): Promise<boolean> {
    const assignments: string[] = []
    const values: unknown[] = []
    let index = 3
    if (input.name !== undefined) {
      assignments.push(`name = ?${index}`)
      values.push(input.name)
      index++
    }
    if (input.locked !== undefined) {
      assignments.push(`locked = ?${index}`)
      values.push(input.locked ? 1 : 0)
      index++
    }
    if (assignments.length === 0) return false
    assignments.push(`updated_at = ?${index}`)
    values.push(this.now)
    const result = await this.db.prepare(
      `UPDATE webssh_dashboards
          SET ${assignments.join(', ')}
        WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id, ...values)
      .run()
    return Number(result.meta.changes ?? 0) > 0
  }

  async replaceLayout(id: string, widgets: readonly WebsshDashboardWidget[]): Promise<boolean> {
    const owned = await this.db.prepare(
      `SELECT id FROM webssh_dashboards WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id)
      .first<{ id: string }>()
    if (!owned) return false
    const statements = [
      this.db.prepare(
        `DELETE FROM webssh_dashboard_widgets WHERE user_id = ?1 AND dashboard_id = ?2`,
      ).bind(this.userId, id),
      ...widgets.map((widget) => this.insertWidgetStatement(id, widget, this.now)),
      this.db.prepare(
        `UPDATE webssh_dashboards SET updated_at = ?3 WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id, this.now),
    ]
    await this.db.batch(statements)
    return true
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM webssh_dashboards WHERE user_id = ?1 AND id = ?2`,
    )
      .bind(this.userId, id)
      .run()
    if (Number(result.meta.changes ?? 0) === 0) return false
    await this.db.prepare(
      `DELETE FROM webssh_dashboard_widgets WHERE user_id = ?1 AND dashboard_id = ?2`,
    )
      .bind(this.userId, id)
      .run()
    return true
  }

  private insertWidgetStatement(dashboardId: string, widget: WebsshDashboardWidget, now: number) {
    return this.db.prepare(
      `INSERT INTO webssh_dashboard_widgets
         (user_id, dashboard_id, id, type, x, y, w, h, config, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      this.userId,
      dashboardId,
      widget.id,
      widget.type,
      widget.x,
      widget.y,
      widget.w,
      widget.h,
      JSON.stringify(widget.config),
      now,
    )
  }
}
