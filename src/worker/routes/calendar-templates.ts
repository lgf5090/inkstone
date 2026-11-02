/** Reusable event drafts: a name for the palette, the fields an event starts with. */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  deleteTemplateRow,
  getTemplateRow,
  insertTemplateRow,
  listTemplateRows,
  updateTemplateRow,
  type TemplateRow,
  type TemplateWrite,
} from '../calendar/templates'
import type { CalendarEventKind, CalendarTemplateDto } from '@shared/calendar/model'

const LIMIT = 64 * 1024
const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')
const writeBudget = createMinuteBudget(120, 'Too many calendar changes at once. Try again in a minute.')
const HEX = /^#[0-9a-f]{6}$/i

export const calendarTemplateRoutes = new Hono<AppBindings>()
calendarTemplateRoutes.use('*', requireAuth)

function toDto(row: TemplateRow): CalendarTemplateDto {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    kind: row.kind === 'task' ? 'task' : 'event' as CalendarEventKind,
    allDay: row.all_day === 1,
    durationMinutes: Number(row.duration_minutes),
    color: row.color,
    rev: Number(row.rev),
  }
}

function text(value: unknown, field: string, max: number, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is too long`)
  return trimmed
}

function parse(value: unknown): Omit<TemplateWrite, 'metaJson'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('template must be an object')
  }
  const record = value as Record<string, unknown>
  const name = text(record.name, 'name', 80)
  if (!name) throw ApiError.badRequest('name is required')
  const title = text(record.title, 'title', 300)
  if (!title) throw ApiError.badRequest('title is required')
  const kind = record.kind === 'task' ? 'task' : record.kind === 'event' || record.kind === undefined ? 'event' : null
  if (!kind) throw ApiError.badRequest('kind must be event or task')
  const duration = record.durationMinutes === undefined ? 60 : Number(record.durationMinutes)
  if (!Number.isInteger(duration) || duration < 0 || duration > 1440) {
    throw ApiError.badRequest('durationMinutes must be between 0 and 1440')
  }
  const color = record.color === undefined || record.color === null || record.color === ''
    ? null
    : typeof record.color === 'string' && HEX.test(record.color)
      ? record.color
      : null
  return {
    name,
    title,
    description: text(record.description, 'description', 20_000),
    kind,
    allDay: record.allDay === true,
    durationMinutes: duration,
    color,
  }
}

calendarTemplateRoutes.get('/templates', async (c) => {
  readBudget(c.get('userId'))
  const rows = await listTemplateRows(c.env.DB, c.get('userId'))
  return c.json({ templates: rows.map(toDto) })
})

calendarTemplateRoutes.post('/templates', async (c) => {
  writeBudget(c.get('userId'))
  const input = parse(await readJson<unknown>(c, LIMIT))
  const id = newId()
  try {
    const row = await insertTemplateRow(c.env.DB, c.get('userId'), id, { ...input, metaJson: '{}' })
    return c.json({ template: toDto(row) })
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw ApiError.conflict('A template with that name already exists')
    }
    throw error
  }
})

calendarTemplateRoutes.patch('/templates/:id', async (c) => {
  writeBudget(c.get('userId'))
  const id = c.req.param('id')
  const current = await getTemplateRow(c.env.DB, c.get('userId'), id)
  if (!current) throw ApiError.notFound('Template not found')
  const record = await readJson<Record<string, unknown>>(c, LIMIT)
  const input = parse({ ...toDto(current), ...record })
  const rev = record.rev === undefined ? current.rev : Number(record.rev)
  if (!Number.isSafeInteger(rev)) throw ApiError.badRequest('rev is invalid')
  try {
    const row = await updateTemplateRow(c.env.DB, c.get('userId'), id, rev, {
      ...input,
      metaJson: current.meta_json,
    })
    return c.json({ template: toDto(row) })
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw ApiError.conflict('A template with that name already exists')
    }
    if (error instanceof Error && error.message.includes('did not persist')) {
      throw ApiError.conflict('The template changed elsewhere')
    }
    throw error
  }
})

calendarTemplateRoutes.delete('/templates/:id', async (c) => {
  writeBudget(c.get('userId'))
  if (await deleteTemplateRow(c.env.DB, c.get('userId'), c.req.param('id')) === 0) {
    throw ApiError.notFound('Template not found')
  }
  return c.body(null, 204)
})
