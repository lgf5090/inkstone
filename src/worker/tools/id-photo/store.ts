import type {
  IdPhotoRecord,
  IdPhotoSpec,
  IdPhotoUserSettings,
  IdPhotoCategory,
} from '@shared/tools/id-photo/types'
import { ApiError } from '../../lib/errors'

interface RecordRow {
  user_id: string
  id: string
  title: string
  spec_id: string
  spec_name: string
  width_px: number
  height_px: number
  width_mm: number
  height_mm: number
  dpi: number
  bg_color: string
  options_json: string
  r2_key: string
  print_r2_key: string
  file_type: string
  file_size: number
  created_at: number
  updated_at: number
}

interface SpecRow {
  user_id: string
  id: string
  name: string
  category: string
  country_code: string
  width_mm: number
  height_mm: number
  width_px: number
  height_px: number
  dpi: number
  bg_colors_json: string
  face_ratio_min: number
  face_ratio_max: number
  file_size_max_kb: number
  is_favorite: number
  created_at: number
  updated_at: number
}

interface SettingsRow {
  user_id: string
  default_spec_id: string
  default_bg_color: string
  default_dpi: number
  default_export_format: string
  auto_save_history: number
  auto_face_align: number
  print_paper_size: string
  updated_at: number
}

function toRecord(row: RecordRow): IdPhotoRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    specId: row.spec_id,
    specName: row.spec_name,
    widthPx: row.width_px,
    heightPx: row.height_px,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    dpi: row.dpi,
    bgColor: row.bg_color,
    optionsJson: row.options_json,
    r2Key: row.r2_key,
    printR2Key: row.print_r2_key || undefined,
    fileType: row.file_type,
    fileSize: row.file_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSpec(row: SpecRow): IdPhotoSpec {
  let colors: string[] = ['#ffffff']
  try {
    colors = JSON.parse(row.bg_colors_json)
  } catch {
    // fallback
  }

  return {
    id: row.id,
    name: row.name,
    category: row.category as IdPhotoCategory,
    countryCode: row.country_code,
    countryNameKey: '',
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    widthPx: row.width_px,
    heightPx: row.height_px,
    dpi: row.dpi,
    recommendedBgColors: colors,
    faceRatioMin: row.face_ratio_min,
    faceRatioMax: row.face_ratio_max,
    fileSizeMaxKb: row.file_size_max_kb || undefined,
    isBuiltin: false,
    isFavorite: Boolean(row.is_favorite),
  }
}

function toSettings(row: SettingsRow): IdPhotoUserSettings {
  return {
    userId: row.user_id,
    defaultSpecId: row.default_spec_id,
    defaultBgColor: row.default_bg_color,
    defaultDpi: row.default_dpi,
    defaultExportFormat: row.default_export_format,
    autoSaveHistory: Boolean(row.auto_save_history),
    autoFaceAlign: Boolean(row.auto_face_align),
    printPaperSize: (row.print_paper_size as '5inch' | '6inch' | 'a4') || '6inch',
    updatedAt: row.updated_at,
  }
}

export class IdPhotoStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async listRecords(query: {
    specId?: string
    limit?: number
    offset?: number
    search?: string
  }): Promise<{ records: IdPhotoRecord[]; total: number }> {
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0

    const conditions: string[] = ['user_id = ?']
    const params: unknown[] = [this.userId]

    if (query.specId) {
      conditions.push('spec_id = ?')
      params.push(query.specId)
    }

    if (query.search?.trim()) {
      conditions.push('(title LIKE ? OR spec_name LIKE ?)')
      params.push(`%${query.search.trim()}%`, `%${query.search.trim()}%`)
    }

    const where = conditions.join(' AND ')

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM tools_id_photo_records WHERE ${where}`)
      .bind(...params)
      .first<{ cnt: number }>()

    const total = countRow?.cnt ?? 0

    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_id_photo_records WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<RecordRow>()

    return {
      records: (rows.results ?? []).map(toRecord),
      total,
    }
  }

  async getRecord(id: string): Promise<IdPhotoRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_id_photo_records WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .first<RecordRow>()

    return row ? toRecord(row) : null
  }

  async createRecord(data: {
    id: string
    title: string
    specId: string
    specName: string
    widthPx: number
    heightPx: number
    widthMm: number
    heightMm: number
    dpi: number
    bgColor: string
    optionsJson: string
    r2Key: string
    printR2Key?: string
    fileType: string
    fileSize: number
  }): Promise<IdPhotoRecord> {
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_id_photo_records (
          user_id, id, title, spec_id, spec_name, width_px, height_px, width_mm, height_mm,
          dpi, bg_color, options_json, r2_key, print_r2_key, file_type, file_size, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        this.userId,
        data.id,
        data.title,
        data.specId,
        data.specName,
        data.widthPx,
        data.heightPx,
        data.widthMm,
        data.heightMm,
        data.dpi,
        data.bgColor,
        data.optionsJson,
        data.r2Key,
        data.printR2Key || '',
        data.fileType,
        data.fileSize,
        now,
        now,
      )
      .run()

    const created = await this.getRecord(data.id)
    if (!created) {
      throw ApiError.internal('Failed to create ID photo record')
    }
    return created
  }

  async deleteRecord(id: string): Promise<{ r2Key: string; printR2Key: string } | null> {
    const rec = await this.getRecord(id)
    if (!rec) return null

    await this.db
      .prepare(`DELETE FROM tools_id_photo_records WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()

    return { r2Key: rec.r2Key, printR2Key: rec.printR2Key || '' }
  }

  async listSpecs(): Promise<IdPhotoSpec[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_id_photo_specs WHERE user_id = ? ORDER BY is_favorite DESC, updated_at DESC`
      )
      .bind(this.userId)
      .all<SpecRow>()

    return (rows.results ?? []).map(toSpec)
  }

  async createSpec(spec: {
    id: string
    name: string
    category: IdPhotoCategory
    countryCode: string
    widthMm: number
    heightMm: number
    widthPx: number
    heightPx: number
    dpi: number
    recommendedBgColors: readonly string[]
    faceRatioMin: number
    faceRatioMax: number
    fileSizeMaxKb?: number
  }): Promise<IdPhotoSpec> {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_id_photo_specs (
          user_id, id, name, category, country_code, width_mm, height_mm, width_px, height_px,
          dpi, bg_colors_json, face_ratio_min, face_ratio_max, file_size_max_kb, is_favorite,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(
        this.userId,
        spec.id,
        spec.name,
        spec.category,
        spec.countryCode,
        spec.widthMm,
        spec.heightMm,
        spec.widthPx,
        spec.heightPx,
        spec.dpi,
        JSON.stringify(spec.recommendedBgColors),
        spec.faceRatioMin,
        spec.faceRatioMax,
        spec.fileSizeMaxKb || 0,
        now,
        now,
      )
      .run()

    const created = await this.db
      .prepare(`SELECT * FROM tools_id_photo_specs WHERE user_id = ? AND id = ?`)
      .bind(this.userId, spec.id)
      .first<SpecRow>()

    if (!created) {
      throw ApiError.internal('Failed to create custom ID photo spec')
    }
    return toSpec(created)
  }

  async deleteSpec(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(`DELETE FROM tools_id_photo_specs WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()
    return (res.meta.changes ?? 0) > 0
  }

  async getSettings(): Promise<IdPhotoUserSettings> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_id_photo_settings WHERE user_id = ?`)
      .bind(this.userId)
      .first<SettingsRow>()

    if (row) {
      return toSettings(row)
    }

    const defaultSettings: IdPhotoUserSettings = {
      userId: this.userId,
      defaultSpecId: 'cn_one_inch',
      defaultBgColor: '#ffffff',
      defaultDpi: 300,
      defaultExportFormat: 'jpg',
      autoSaveHistory: true,
      autoFaceAlign: true,
      printPaperSize: '6inch',
      updatedAt: Date.now(),
    }

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO tools_id_photo_settings (
          user_id, default_spec_id, default_bg_color, default_dpi, default_export_format,
          auto_save_history, auto_face_align, print_paper_size, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        this.userId,
        defaultSettings.defaultSpecId,
        defaultSettings.defaultBgColor,
        defaultSettings.defaultDpi,
        defaultSettings.defaultExportFormat,
        defaultSettings.autoSaveHistory ? 1 : 0,
        defaultSettings.autoFaceAlign ? 1 : 0,
        defaultSettings.printPaperSize,
        defaultSettings.updatedAt,
      )
      .run()

    return defaultSettings
  }

  async updateSettings(
    patch: Partial<Omit<IdPhotoUserSettings, 'userId' | 'updatedAt'>>
  ): Promise<IdPhotoUserSettings> {
    const current = await this.getSettings()
    const updated = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    }

    await this.db
      .prepare(
        `INSERT INTO tools_id_photo_settings (
          user_id, default_spec_id, default_bg_color, default_dpi, default_export_format,
          auto_save_history, auto_face_align, print_paper_size, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          default_spec_id = excluded.default_spec_id,
          default_bg_color = excluded.default_bg_color,
          default_dpi = excluded.default_dpi,
          default_export_format = excluded.default_export_format,
          auto_save_history = excluded.auto_save_history,
          auto_face_align = excluded.auto_face_align,
          print_paper_size = excluded.print_paper_size,
          updated_at = excluded.updated_at`
      )
      .bind(
        this.userId,
        updated.defaultSpecId,
        updated.defaultBgColor,
        updated.defaultDpi,
        updated.defaultExportFormat,
        updated.autoSaveHistory ? 1 : 0,
        updated.autoFaceAlign ? 1 : 0,
        updated.printPaperSize,
        updated.updatedAt,
      )
      .run()

    return updated
  }
}
