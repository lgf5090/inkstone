import type {
  QrCodeRecord,
  QrCodeSettings,
  QrCodeTemplate,
  QrContentType,
  QrErrorCorrectionLevel,
  QrExportFormat,
  QrTemplateCategory,
} from '@shared/tools/qrcode/types'
import { ApiError } from '../../lib/errors'

interface RecordRow {
  user_id: string
  id: string
  title: string
  content_type: string
  content_raw: string
  options_json: string
  r2_key: string
  file_type: string
  file_size: number
  width: number
  height: number
  created_at: number
  updated_at: number
}

interface TemplateRow {
  user_id: string
  id: string
  name: string
  category: string
  preview_svg: string
  options_json: string
  is_builtin: number
  sort: number
  created_at: number
  updated_at: number
}

interface SettingsRow {
  user_id: string
  default_error_correction: string
  default_size: number
  default_format: string
  auto_save_history: number
  updated_at: number
}

function toRecord(row: RecordRow): QrCodeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    contentType: row.content_type as QrContentType,
    contentRaw: row.content_raw,
    optionsJson: row.options_json,
    r2Key: row.r2_key,
    fileType: row.file_type as QrExportFormat,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toTemplate(row: TemplateRow): QrCodeTemplate {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    category: row.category as QrTemplateCategory,
    previewSvg: row.preview_svg,
    optionsJson: row.options_json,
    isBuiltin: Boolean(row.is_builtin),
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSettings(row: SettingsRow): QrCodeSettings {
  return {
    defaultErrorCorrection: row.default_error_correction as QrErrorCorrectionLevel,
    defaultSize: row.default_size,
    defaultFormat: row.default_format as QrExportFormat,
    autoSaveHistory: Boolean(row.auto_save_history),
    updatedAt: row.updated_at,
  }
}

export const DEFAULT_QR_SETTINGS: QrCodeSettings = {
  defaultErrorCorrection: 'Q',
  defaultSize: 1000,
  defaultFormat: 'png',
  autoSaveHistory: true,
  updatedAt: 0,
}

export class QrCodeStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async listRecords(options: {
    contentType?: string
    search?: string
    limit?: number
    offset?: number
  } = {}): Promise<{ items: QrCodeRecord[]; total: number }> {
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0

    const conditions: string[] = ['user_id = ?1']
    const params: unknown[] = [this.userId]
    let paramIndex = 2

    if (options.contentType) {
      conditions.push(`content_type = ?${paramIndex++}`)
      params.push(options.contentType)
    }

    if (options.search) {
      const idx = paramIndex++
      conditions.push(`(title LIKE ?${idx} OR content_raw LIKE ?${idx})`)
      params.push(`%${options.search}%`)
    }

    const whereClause = conditions.join(' AND ')

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM tools_qrcode_t_records WHERE ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>()
    const total = countRow?.total ?? 0

    const limitIdx = paramIndex++
    const offsetIdx = paramIndex++
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_qrcode_t_records
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?${limitIdx} OFFSET ?${offsetIdx}`,
      )
      .bind(...params, limit, offset)
      .all<RecordRow>()

    return {
      items: (rows.results ?? []).map(toRecord),
      total,
    }
  }

  async getRecord(id: string): Promise<QrCodeRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM tools_qrcode_t_records
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<RecordRow>()

    if (!row) return null
    return toRecord(row)
  }

  async createRecord(data: {
    id?: string
    title?: string
    contentType?: string
    contentRaw: string
    optionsJson: string
    r2Key?: string
    fileType?: string
    fileSize?: number
    width?: number
    height?: number
  }): Promise<QrCodeRecord> {
    const id = data.id || crypto.randomUUID()
    const now = Date.now()
    const title = data.title ?? ''
    const contentType = data.contentType ?? 'text'
    const r2Key = data.r2Key ?? ''
    const fileType = data.fileType ?? 'png'
    const fileSize = data.fileSize ?? 0
    const width = data.width ?? 1000
    const height = data.height ?? 1000

    await this.db
      .prepare(
        `INSERT INTO tools_qrcode_t_records (
           user_id, id, title, content_type, content_raw, options_json,
           r2_key, file_type, file_size, width, height, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        this.userId,
        id,
        title,
        contentType,
        data.contentRaw,
        data.optionsJson,
        r2Key,
        fileType,
        fileSize,
        width,
        height,
        now,
        now,
      )
      .run()

    return {
      id,
      userId: this.userId,
      title,
      contentType: contentType as QrContentType,
      contentRaw: data.contentRaw,
      optionsJson: data.optionsJson,
      r2Key,
      fileType: fileType as QrExportFormat,
      fileSize,
      width,
      height,
      createdAt: now,
      updatedAt: now,
    }
  }

  async deleteRecord(id: string): Promise<QrCodeRecord | null> {
    const existing = await this.getRecord(id)
    if (!existing) return null

    await this.db
      .prepare(
        `DELETE FROM tools_qrcode_t_records
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .run()

    return existing
  }

  async listTemplates(category?: string): Promise<QrCodeTemplate[]> {
    const conditions = [`(user_id = '__builtin__' OR user_id = ?1)`]
    const params: unknown[] = [this.userId]

    if (category) {
      conditions.push('category = ?2')
      params.push(category)
    }

    const whereClause = conditions.join(' AND ')
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_qrcode_t_templates
         WHERE ${whereClause}
         ORDER BY is_builtin DESC, sort ASC, created_at DESC`,
      )
      .bind(...params)
      .all<TemplateRow>()

    return (rows.results ?? []).map(toTemplate)
  }

  async getTemplate(id: string): Promise<QrCodeTemplate | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM tools_qrcode_t_templates
         WHERE (user_id = '__builtin__' OR user_id = ?1) AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<TemplateRow>()

    if (!row) return null
    return toTemplate(row)
  }

  async createTemplate(data: {
    id?: string
    name: string
    category?: string
    previewSvg?: string
    optionsJson: string
    sort?: number
  }): Promise<QrCodeTemplate> {
    const id = data.id || crypto.randomUUID()
    const now = Date.now()
    const category = data.category ?? 'minimal'
    const previewSvg = data.previewSvg ?? ''
    const sort = data.sort ?? 0

    await this.db
      .prepare(
        `INSERT INTO tools_qrcode_t_templates (
           user_id, id, name, category, preview_svg, options_json,
           is_builtin, sort, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)`,
      )
      .bind(
        this.userId,
        id,
        data.name,
        category,
        previewSvg,
        data.optionsJson,
        sort,
        now,
        now,
      )
      .run()

    return {
      id,
      userId: this.userId,
      name: data.name,
      category: category as QrTemplateCategory,
      previewSvg,
      optionsJson: data.optionsJson,
      isBuiltin: false,
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updateTemplate(
    id: string,
    data: {
      name?: string
      category?: string
      previewSvg?: string
      optionsJson?: string
      sort?: number
    },
  ): Promise<QrCodeTemplate> {
    const existing = await this.getTemplate(id)
    if (!existing) {
      throw ApiError.notFound('Template not found')
    }
    if (existing.isBuiltin || existing.userId === '__builtin__') {
      throw ApiError.forbidden('Cannot modify built-in template')
    }
    if (existing.userId !== this.userId) {
      throw ApiError.notFound('Template not found')
    }

    const now = Date.now()
    const name = data.name ?? existing.name
    const category = data.category ?? existing.category
    const previewSvg = data.previewSvg ?? existing.previewSvg
    const optionsJson = data.optionsJson ?? existing.optionsJson
    const sort = data.sort ?? existing.sort

    await this.db
      .prepare(
        `UPDATE tools_qrcode_t_templates
         SET name = ?1, category = ?2, preview_svg = ?3, options_json = ?4, sort = ?5, updated_at = ?6
         WHERE user_id = ?7 AND id = ?8`,
      )
      .bind(name, category, previewSvg, optionsJson, sort, now, this.userId, id)
      .run()

    return {
      id,
      userId: this.userId,
      name,
      category: category as QrTemplateCategory,
      previewSvg,
      optionsJson,
      isBuiltin: false,
      sort,
      createdAt: existing.createdAt,
      updatedAt: now,
    }
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT user_id, is_builtin FROM tools_qrcode_t_templates
         WHERE id = ?1`,
      )
      .bind(id)
      .first<{ user_id: string; is_builtin: number }>()

    if (!row) {
      throw ApiError.notFound('Template not found')
    }

    if (row.is_builtin === 1 || row.user_id === '__builtin__') {
      throw ApiError.forbidden('Cannot delete built-in template')
    }

    if (row.user_id !== this.userId) {
      throw ApiError.notFound('Template not found')
    }

    await this.db
      .prepare(
        `DELETE FROM tools_qrcode_t_templates
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .run()

    return true
  }

  async getSettings(): Promise<QrCodeSettings> {
    const row = await this.db
      .prepare(
        `SELECT * FROM tools_qrcode_t_settings
         WHERE user_id = ?1`,
      )
      .bind(this.userId)
      .first<SettingsRow>()

    if (!row) {
      return { ...DEFAULT_QR_SETTINGS }
    }

    return toSettings(row)
  }

  async saveSettings(data: {
    defaultErrorCorrection?: string
    defaultSize?: number
    defaultFormat?: string
    autoSaveHistory?: boolean
  }): Promise<QrCodeSettings> {
    const current = await this.getSettings()
    const updated: QrCodeSettings = {
      defaultErrorCorrection: (data.defaultErrorCorrection ?? current.defaultErrorCorrection) as QrErrorCorrectionLevel,
      defaultSize: data.defaultSize ?? current.defaultSize,
      defaultFormat: (data.defaultFormat ?? current.defaultFormat) as QrExportFormat,
      autoSaveHistory: data.autoSaveHistory !== undefined ? data.autoSaveHistory : current.autoSaveHistory,
      updatedAt: Date.now(),
    }

    await this.db
      .prepare(
        `INSERT INTO tools_qrcode_t_settings (
           user_id, default_error_correction, default_size, default_format,
           auto_save_history, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id) DO UPDATE SET
           default_error_correction = ?2,
           default_size = ?3,
           default_format = ?4,
           auto_save_history = ?5,
           updated_at = ?6`,
      )
      .bind(
        this.userId,
        updated.defaultErrorCorrection,
        updated.defaultSize,
        updated.defaultFormat,
        updated.autoSaveHistory ? 1 : 0,
        updated.updatedAt,
      )
      .run()

    return updated
  }
}
