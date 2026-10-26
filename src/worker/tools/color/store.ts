/**
 * Color Assistant Store (`ColorStore`)
 * Multi-tenant data repository with D1 database operations for single colors,
 * multi-color palettes, history, settings, and assets.
 */

import { hexToRgb, rgbToCmyk, rgbToLab } from '@shared/tools/color/spaces'
import type {
  ColorHistoryItem,
  ColorSettings,
  PaletteColorItem,
  UserColorFavorite,
  UserColorPalette,
} from '@shared/tools/color/types'

export class ColorStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  // ==========================================
  // Settings
  // ==========================================

  async getSettings(): Promise<ColorSettings> {
    const row = await this.db
      .prepare('SELECT * FROM tools_color_settings WHERE user_id = ?')
      .bind(this.userId)
      .first<{
        user_id: string
        strip_hash: number
        default_format: string
        default_ui_tab: string
        auto_save_history: number
        updated_at: number
      }>()

    if (!row) {
      return {
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'flat_ui',
        autoSaveHistory: true,
        updatedAt: Date.now(),
      }
    }

    return {
      stripHash: Boolean(row.strip_hash),
      defaultFormat: (row.default_format as ColorSettings['defaultFormat']) || 'hex',
      defaultUiTab: row.default_ui_tab || 'flat_ui',
      autoSaveHistory: Boolean(row.auto_save_history),
      updatedAt: row.updated_at,
    }
  }

  async updateSettings(partial: Partial<ColorSettings>): Promise<ColorSettings> {
    const current = await this.getSettings()
    const updated: ColorSettings = {
      ...current,
      ...partial,
      updatedAt: Date.now(),
    }

    await this.db
      .prepare(
        `INSERT INTO tools_color_settings (user_id, strip_hash, default_format, default_ui_tab, auto_save_history, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           strip_hash = excluded.strip_hash,
           default_format = excluded.default_format,
           default_ui_tab = excluded.default_ui_tab,
           auto_save_history = excluded.auto_save_history,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        updated.stripHash ? 1 : 0,
        updated.defaultFormat,
        updated.defaultUiTab,
        updated.autoSaveHistory ? 1 : 0,
        updated.updatedAt,
      )
      .run()

    return updated
  }

  // ==========================================
  // Favorites (Single Colors)
  // ==========================================

  async listFavorites(tag?: string): Promise<UserColorFavorite[]> {
    const results = await this.db
      .prepare(
        `SELECT * FROM tools_color_favorites
         WHERE user_id = ?
         ORDER BY sort ASC, created_at DESC`,
      )
      .bind(this.userId)
      .all<{
        user_id: string
        id: string
        name: string
        hex: string
        rgb_json: string
        cmyk_json: string
        lab_json: string
        tags_json: string
        note: string
        sort: number
        created_at: number
        updated_at: number
      }>()

    const list: UserColorFavorite[] = []
    for (const row of results.results || []) {
      let tags: string[] = []
      try {
        tags = JSON.parse(row.tags_json || '[]')
      } catch {
        tags = []
      }

      if (tag && !tags.includes(tag)) {
        continue
      }

      let rgb = { r: 0, g: 0, b: 0 }
      try {
        rgb = JSON.parse(row.rgb_json)
      } catch {
        rgb = hexToRgb(row.hex)
      }

      let cmyk
      if (row.cmyk_json) {
        try {
          cmyk = JSON.parse(row.cmyk_json)
        } catch {
          // ignore
        }
      }

      let lab
      if (row.lab_json) {
        try {
          lab = JSON.parse(row.lab_json)
        } catch {
          // ignore
        }
      }

      list.push({
        id: row.id,
        name: row.name,
        hex: row.hex,
        rgb,
        cmyk,
        lab,
        tags,
        note: row.note,
        sort: row.sort,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }

    return list
  }

  async getFavorite(id: string): Promise<UserColorFavorite | null> {
    const row = await this.db
      .prepare('SELECT * FROM tools_color_favorites WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<{
        user_id: string
        id: string
        name: string
        hex: string
        rgb_json: string
        cmyk_json: string
        lab_json: string
        tags_json: string
        note: string
        sort: number
        created_at: number
        updated_at: number
      }>()

    if (!row) return null

    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags_json || '[]')
    } catch {
      tags = []
    }

    let rgb = hexToRgb(row.hex)
    try {
      rgb = JSON.parse(row.rgb_json)
    } catch {
      // ignore
    }

    return {
      id: row.id,
      name: row.name,
      hex: row.hex,
      rgb,
      tags,
      note: row.note,
      sort: row.sort,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async createFavorite(data: {
    id?: string
    name?: string
    hex: string
    tags?: string[]
    note?: string
    sort?: number
  }): Promise<UserColorFavorite> {
    const id = data.id || `col_fav_${crypto.randomUUID().slice(0, 12)}`
    const now = Date.now()
    const rgb = hexToRgb(data.hex)
    const cmyk = rgbToCmyk(rgb)
    const lab = rgbToLab(rgb)
    const tags = data.tags || []
    const name = data.name || ''
    const note = data.note || ''
    const sort = data.sort || 0

    await this.db
      .prepare(
        `INSERT INTO tools_color_favorites
         (user_id, id, name, hex, rgb_json, cmyk_json, lab_json, tags_json, note, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        id,
        name,
        data.hex,
        JSON.stringify(rgb),
        JSON.stringify(cmyk),
        JSON.stringify(lab),
        JSON.stringify(tags),
        note,
        sort,
        now,
        now,
      )
      .run()

    return {
      id,
      name,
      hex: data.hex,
      rgb,
      cmyk,
      lab,
      tags,
      note,
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updateFavorite(
    id: string,
    data: {
      name?: string
      tags?: string[]
      note?: string
      sort?: number
    },
  ): Promise<UserColorFavorite | null> {
    const existing = await this.getFavorite(id)
    if (!existing) return null

    const now = Date.now()
    const name = data.name !== undefined ? data.name : existing.name
    const tags = data.tags !== undefined ? data.tags : existing.tags
    const note = data.note !== undefined ? data.note : existing.note
    const sort = data.sort !== undefined ? data.sort : existing.sort

    await this.db
      .prepare(
        `UPDATE tools_color_favorites
         SET name = ?, tags_json = ?, note = ?, sort = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .bind(name, JSON.stringify(tags), note, sort, now, this.userId, id)
      .run()

    return {
      ...existing,
      name,
      tags,
      note,
      sort,
      updatedAt: now,
    }
  }

  async deleteFavorite(id: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM tools_color_favorites WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  // ==========================================
  // Multi-Color Palettes (Palettes & Groups)
  // ==========================================

  async listPalettes(filter?: {
    sourceType?: string
    tag?: string
    onlyFavorites?: boolean
  }): Promise<UserColorPalette[]> {
    let sql = `SELECT * FROM tools_color_palettes WHERE user_id = ?`
    const params: (string | number)[] = [this.userId]

    if (filter?.sourceType) {
      sql += ` AND source_type = ?`
      params.push(filter.sourceType)
    }

    if (filter?.onlyFavorites) {
      sql += ` AND is_favorite = 1`
    }

    sql += ` ORDER BY sort ASC, created_at DESC`

    const results = await this.db
      .prepare(sql)
      .bind(...params)
      .all<{
        user_id: string
        id: string
        title: string
        colors_json: string
        source_type: string
        description: string
        tags_json: string
        likes_count: number
        preview_svg: string
        is_favorite: number
        sort: number
        created_at: number
        updated_at: number
      }>()

    const list: UserColorPalette[] = []
    for (const row of results.results || []) {
      let tags: string[] = []
      try {
        tags = JSON.parse(row.tags_json || '[]')
      } catch {
        tags = []
      }

      if (filter?.tag && !tags.includes(filter.tag)) {
        continue
      }

      let colors: PaletteColorItem[] = []
      try {
        colors = JSON.parse(row.colors_json || '[]')
      } catch {
        colors = []
      }

      list.push({
        id: row.id,
        title: row.title,
        colors,
        sourceType: (row.source_type as UserColorPalette['sourceType']) || 'custom',
        description: row.description,
        tags,
        likesCount: row.likes_count,
        previewSvg: row.preview_svg,
        isFavorite: Boolean(row.is_favorite),
        sort: row.sort,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }

    return list
  }

  async getPalette(id: string): Promise<UserColorPalette | null> {
    const row = await this.db
      .prepare('SELECT * FROM tools_color_palettes WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<{
        user_id: string
        id: string
        title: string
        colors_json: string
        source_type: string
        description: string
        tags_json: string
        likes_count: number
        preview_svg: string
        is_favorite: number
        sort: number
        created_at: number
        updated_at: number
      }>()

    if (!row) return null

    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags_json || '[]')
    } catch {
      tags = []
    }

    let colors: PaletteColorItem[] = []
    try {
      colors = JSON.parse(row.colors_json || '[]')
    } catch {
      colors = []
    }

    return {
      id: row.id,
      title: row.title,
      colors,
      sourceType: (row.source_type as UserColorPalette['sourceType']) || 'custom',
      description: row.description,
      tags,
      likesCount: row.likes_count,
      previewSvg: row.preview_svg,
      isFavorite: Boolean(row.is_favorite),
      sort: row.sort,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async createPalette(data: {
    id?: string
    title: string
    colors: PaletteColorItem[]
    sourceType?: UserColorPalette['sourceType']
    description?: string
    tags?: string[]
    likesCount?: number
    previewSvg?: string
    isFavorite?: boolean
    sort?: number
  }): Promise<UserColorPalette> {
    const id = data.id || `col_pal_${crypto.randomUUID().slice(0, 12)}`
    const now = Date.now()
    const sourceType = data.sourceType || 'custom'
    const description = data.description || ''
    const tags = data.tags || []
    const likesCount = data.likesCount || 0
    const previewSvg = data.previewSvg || ''
    const isFavorite = data.isFavorite !== undefined ? data.isFavorite : true
    const sort = data.sort || 0

    await this.db
      .prepare(
        `INSERT INTO tools_color_palettes
         (user_id, id, title, colors_json, source_type, description, tags_json, likes_count, preview_svg, is_favorite, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        id,
        data.title,
        JSON.stringify(data.colors),
        sourceType,
        description,
        JSON.stringify(tags),
        likesCount,
        previewSvg,
        isFavorite ? 1 : 0,
        sort,
        now,
        now,
      )
      .run()

    return {
      id,
      title: data.title,
      colors: data.colors,
      sourceType,
      description,
      tags,
      likesCount,
      previewSvg,
      isFavorite,
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updatePalette(
    id: string,
    data: {
      title?: string
      colors?: PaletteColorItem[]
      description?: string
      tags?: string[]
      likesCount?: number
      previewSvg?: string
      isFavorite?: boolean
      sort?: number
    },
  ): Promise<UserColorPalette | null> {
    const existing = await this.getPalette(id)
    if (!existing) return null

    const now = Date.now()
    const title = data.title !== undefined ? data.title : existing.title
    const colors = data.colors !== undefined ? data.colors : existing.colors
    const description = data.description !== undefined ? data.description : existing.description
    const tags = data.tags !== undefined ? data.tags : existing.tags
    const likesCount = data.likesCount !== undefined ? data.likesCount : existing.likesCount
    const previewSvg = data.previewSvg !== undefined ? data.previewSvg : existing.previewSvg
    const isFavorite = data.isFavorite !== undefined ? data.isFavorite : existing.isFavorite
    const sort = data.sort !== undefined ? data.sort : existing.sort

    await this.db
      .prepare(
        `UPDATE tools_color_palettes
         SET title = ?, colors_json = ?, description = ?, tags_json = ?, likes_count = ?, preview_svg = ?, is_favorite = ?, sort = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .bind(
        title,
        JSON.stringify(colors),
        description,
        JSON.stringify(tags),
        likesCount,
        previewSvg,
        isFavorite ? 1 : 0,
        sort,
        now,
        this.userId,
        id,
      )
      .run()

    return {
      ...existing,
      title,
      colors,
      description,
      tags,
      likesCount,
      previewSvg,
      isFavorite,
      sort,
      updatedAt: now,
    }
  }

  async deletePalette(id: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM tools_color_palettes WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  // ==========================================
  // History (Sliding window of last 100 entries)
  // ==========================================

  async listHistory(limit = 60): Promise<ColorHistoryItem[]> {
    const results = await this.db
      .prepare(
        `SELECT * FROM tools_color_history
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(this.userId, Math.min(100, Math.max(1, limit)))
      .all<{
        user_id: string
        id: string
        hex: string
        source: string
        created_at: number
      }>()

    return (results.results || []).map((row) => ({
      id: row.id,
      hex: row.hex,
      source: (row.source as ColorHistoryItem['source']) || 'studio',
      createdAt: row.created_at,
    }))
  }

  async addHistory(hex: string, source: ColorHistoryItem['source'] = 'studio'): Promise<ColorHistoryItem> {
    const id = `col_hist_${crypto.randomUUID().slice(0, 12)}`
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_color_history (user_id, id, hex, source, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(this.userId, id, hex, source, now)
      .run()

    // Truncate sliding window if user has more than 100 history items
    await this.db
      .prepare(
        `DELETE FROM tools_color_history
         WHERE user_id = ? AND id NOT IN (
           SELECT id FROM tools_color_history
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 100
         )`,
      )
      .bind(this.userId, this.userId)
      .run()

    return {
      id,
      hex,
      source,
      createdAt: now,
    }
  }

  async clearHistory(): Promise<boolean> {
    await this.db
      .prepare('DELETE FROM tools_color_history WHERE user_id = ?')
      .bind(this.userId)
      .run()
    return true
  }

  // ==========================================
  // Assets
  // ==========================================

  async recordAsset(
    id: string,
    assetType: string,
    fileFormat: string,
    fileSize: number,
    r2Key: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_color_assets (user_id, id, asset_type, file_format, file_size, r2_key, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        id,
        assetType,
        fileFormat,
        fileSize,
        r2Key,
        JSON.stringify(metadata || {}),
        now,
      )
      .run()
  }

  async getAsset(id: string): Promise<{
    id: string
    assetType: string
    fileFormat: string
    fileSize: number
    r2Key: string
    metadata: Record<string, unknown>
    createdAt: number
  } | null> {
    const row = await this.db
      .prepare('SELECT * FROM tools_color_assets WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<{
        user_id: string
        id: string
        asset_type: string
        file_format: string
        file_size: number
        r2_key: string
        metadata_json: string
        created_at: number
      }>()

    if (!row) return null

    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(row.metadata_json || '{}')
    } catch {
      metadata = {}
    }

    return {
      id: row.id,
      assetType: row.asset_type,
      fileFormat: row.file_format,
      fileSize: row.file_size,
      r2Key: row.r2_key,
      metadata,
      createdAt: row.created_at,
    }
  }

  async deleteAsset(id: string): Promise<string | null> {
    const asset = await this.getAsset(id)
    if (!asset) return null

    await this.db
      .prepare('DELETE FROM tools_color_assets WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .run()

    return asset.r2Key
  }
}
