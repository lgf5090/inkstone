/** Inknote settings and user templates. Both are per-account rows; built-in templates stay client-side. */
import { Hono } from 'hono'
import {
  INKNOTE_ASSET_ID_RE,
  INKNOTE_ASSET_URL_PREFIX,
  INKNOTE_LIMITS,
} from '@shared/inknote/constants'
import { sanitizePageForSave } from '@shared/inknote/parse'
import { sanitizeInknoteSettings, sanitizePaper } from '@shared/inknote/settings'
import { INKNOTE_PAGE_VERSION, type InknoteTextBox, type InknoteTemplate } from '@shared/inknote/types'
import {
  deleteInknoteAsset,
  drainInknoteCleanup,
  inknoteAssetById,
  inknoteAssetIsReferenced,
} from '../inknote/assets'
import {
  deleteInknoteTemplateRow,
  insertInknoteTemplateRow,
  inknoteTemplateRowById,
  listInknoteTemplateRows,
  readInknoteSettingsRecord,
  renameInknoteTemplateRow,
  writeInknoteSettingsRecord,
  type InknoteTemplateRow,
} from '../inknote/snapshots'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

const TEMPLATE_TITLE_SIZE = 32
const TEMPLATE_SUB_SIZE = 15

export const inknoteSettingsRoutes = new Hono<AppBindings>()

inknoteSettingsRoutes.use('*', requireAuth)

inknoteSettingsRoutes.get('/settings', async (c) => {
  const row = await readInknoteSettingsRecord(c.env.DB, c.get('userId'))
  return c.json({
    config: configFromRow(row?.config),
    updatedAt: row?.updated_at ?? 0,
  })
})

inknoteSettingsRoutes.put('/settings', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ config?: unknown; baseUpdatedAt?: unknown }>(c, JSON_BODY_LIMITS.settings)
  const config = body.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw ApiError.badRequest('The config field must be an object')
  }
  let baseUpdatedAt: number | undefined
  if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== null) {
    if (typeof body.baseUpdatedAt !== 'number'
      || !Number.isSafeInteger(body.baseUpdatedAt)
      || body.baseUpdatedAt < 0) {
      throw ApiError.badRequest('baseUpdatedAt must be a non-negative integer')
    }
    baseUpdatedAt = body.baseUpdatedAt
  }

  const current = await readInknoteSettingsRecord(c.env.DB, userId)
  const updatedAt = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
  const sanitized = sanitizeInknoteSettings(config)
  const written = await writeInknoteSettingsRecord(
    c.env.DB,
    userId,
    JSON.stringify(sanitized),
    updatedAt,
    baseUpdatedAt,
  )
  if (!written) {
    const latest = await readInknoteSettingsRecord(c.env.DB, userId)
    throw ApiError.conflict('Settings were changed on another device', {
      current: {
        config: configFromRow(latest?.config),
        updatedAt: latest?.updated_at ?? 0,
      },
    })
  }
  return c.json({ config: sanitized, updatedAt })
})

inknoteSettingsRoutes.get('/templates', async (c) => {
  const rows = await listInknoteTemplateRows(c.env.DB, c.get('userId'))
  return c.json({ templates: rows.map(templateFromRow) })
})

inknoteSettingsRoutes.post('/templates', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.templateLibrary)
  const name = templateName(body.name)
  const bgAssetId = await templateBackground(c.env.DB, userId, body.bgAssetId)
  const paper = sanitizePaper(body.paper)
  const now = Date.now()
  const row: Omit<InknoteTemplateRow, 'user_id'> = {
    id: newId(),
    name,
    paper_style: paper.style,
    paper_color: paper.color,
    paper_spacing: paper.spacing,
    bg_asset_id: bgAssetId,
    texts: JSON.stringify(templateTexts(body.texts)),
    title: optionalText(body.title, INKNOTE_LIMITS.titleMaxLength, 'title'),
    sub: optionalText(body.sub, INKNOTE_LIMITS.titleMaxLength, 'sub'),
    title_size: TEMPLATE_TITLE_SIZE,
    sub_size: TEMPLATE_SUB_SIZE,
    created_at: now,
    updated_at: now,
  }
  if (!(await insertInknoteTemplateRow(c.env.DB, row, userId, INKNOTE_LIMITS.templatesPerUser))) {
    throw ApiError.badRequest(`The account template limit of ${INKNOTE_LIMITS.templatesPerUser} has been reached`)
  }
  return c.json(templateFromRow({ ...row, user_id: userId }), 201)
})

inknoteSettingsRoutes.patch('/templates/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Template not found')
  const existing = await inknoteTemplateRowById(c.env.DB, userId, id)
  if (!existing) throw ApiError.notFound('Template not found')

  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  let name = existing.name
  if (body.name !== undefined) {
    name = templateName(body.name)
    const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
    if (!(await renameInknoteTemplateRow(c.env.DB, userId, id, name, updatedAt))) {
      throw ApiError.notFound('Template not found')
    }
    existing.name = name
    existing.updated_at = updatedAt
  }
  return c.json(templateFromRow(existing))
})

inknoteSettingsRoutes.delete('/templates/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Template not found')
  const existing = await inknoteTemplateRowById(c.env.DB, userId, id)
  if (!existing) throw ApiError.notFound('Template not found')
  if (!(await deleteInknoteTemplateRow(c.env.DB, userId, id))) {
    throw ApiError.notFound('Template not found')
  }

  const bgAssetId = existing.bg_asset_id
  if (bgAssetId && !(await inknoteAssetIsReferenced(c.env.DB, userId, bgAssetId))) {
    await deleteInknoteAsset(c.env, userId, bgAssetId)
  }
  await drainInknoteCleanup(c.env, userId).catch((error) => {
    console.warn('[inknote] Template asset cleanup will retry later:', error)
  })
  return c.json({ ok: true })
})

function configFromRow(config: string | undefined): unknown {
  if (!config) return sanitizeInknoteSettings({})
  try {
    return sanitizeInknoteSettings(JSON.parse(config))
  } catch {
    return sanitizeInknoteSettings({})
  }
}

function optionalText(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is too long`)
  return trimmed
}

function templateName(value: unknown): string {
  const name = optionalText(value, INKNOTE_LIMITS.nameMaxLength, 'name')
  if (!name) throw ApiError.badRequest('name is required')
  return name
}

async function templateBackground(
  db: D1Database,
  userId: string,
  value: unknown,
): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !INKNOTE_ASSET_ID_RE.test(value)) {
    throw ApiError.badRequest('bgAssetId is invalid')
  }
  const asset = await inknoteAssetById(db, userId, value)
  if (!asset) throw ApiError.badRequest('bgAssetId does not belong to this account')
  if (asset.kind !== 'template' && asset.kind !== 'background') {
    throw ApiError.badRequest('bgAssetId must be a template or background asset')
  }
  return value
}

function templateTexts(value: unknown): InknoteTextBox[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('texts must be an array')
  const parsed = sanitizePageForSave(JSON.stringify({
    format: 'inknote-page',
    version: INKNOTE_PAGE_VERSION,
    strokes: [],
    texts: value,
    images: [],
    bg: null,
  }))
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') throw ApiError.tooLarge('The template texts exceed the page limits')
    throw ApiError.badRequest('The template texts are invalid')
  }
  return parsed.result.content.texts
}

function templateFromRow(row: InknoteTemplateRow): InknoteTemplate {
  return {
    id: row.id,
    name: row.name,
    paper: sanitizePaper({
      style: row.paper_style,
      color: row.paper_color,
      spacing: row.paper_spacing,
    }),
    bgAssetId: row.bg_asset_id,
    bgUrl: row.bg_asset_id ? `${INKNOTE_ASSET_URL_PREFIX}${row.bg_asset_id}` : null,
    texts: storedTexts(row.texts),
    title: row.title,
    sub: row.sub,
    titleSize: row.title_size,
    subSize: row.sub_size,
    builtIn: false,
    createdAt: row.created_at,
  }
}

function storedTexts(value: string): InknoteTextBox[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as InknoteTextBox[] : []
  } catch {
    return []
  }
}
