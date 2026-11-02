import { DEFAULT_CALCULATOR_SETTINGS, HISTORY_LIMIT, MEMORY_LIMIT } from '@shared/tools/calculator/contract'
import type {
  CalculatorAsset,
  CalculatorSettings,
  CurrencyRates,
  GraphSession,
  HistoryEntry,
  MemoryEntry,
  UnitPreference,
} from '@shared/tools/calculator/types'

interface SettingsRow {
  user_id: string
  default_view: string
  angle_mode: string
  graph_theme: string
  graph_line_width: number
  graph_x_min: number
  graph_x_max: number
  graph_y_min: number
  graph_y_max: number
  updated_at: number
}

interface HistoryRow {
  id: string
  mode: string
  expression: string
  result: string
  tokens_json: string
  commands_json: string
  radix: number
  created_at: number
}

interface MemoryRow {
  id: string
  value_json: string
  sort: number
  created_at: number
}

interface GraphRow {
  equations_json: string
  variables_json: string
  viewport_json: string
  updated_at: number
}

interface PreferenceRow {
  category_id: string
  from_unit_id: number
  to_unit_id: number
  updated_at: number
}

interface AssetRow {
  id: string
  kind: string
  file_format: string
  mime_type: string
  file_size: number
  r2_key: string
  metadata_json: string
  created_at: number
}

function parseJson<T>(text: string, fallback: T, context: string): T {
  try {
    return JSON.parse(text) as T
  } catch (error) {
    console.warn(`[inkstone] Calculator ${context} is corrupt; using the default:`, error instanceof Error ? error.message : error)
    return fallback
  }
}

function toSettings(row: SettingsRow | null): CalculatorSettings {
  if (!row) return { ...DEFAULT_CALCULATOR_SETTINGS, updatedAt: Date.now() }
  return {
    defaultView: (row.default_view as CalculatorSettings['defaultView']) || DEFAULT_CALCULATOR_SETTINGS.defaultView,
    angleMode: (row.angle_mode as CalculatorSettings['angleMode']) || DEFAULT_CALCULATOR_SETTINGS.angleMode,
    graphTheme: row.graph_theme === 'light' ? 'light' : 'match_app',
    graphLineWidth: Math.min(4, Math.max(1, row.graph_line_width || 2)),
    graphXMin: Number.isFinite(row.graph_x_min) ? row.graph_x_min : -10,
    graphXMax: Number.isFinite(row.graph_x_max) ? row.graph_x_max : 10,
    graphYMin: Number.isFinite(row.graph_y_min) ? row.graph_y_min : -10,
    graphYMax: Number.isFinite(row.graph_y_max) ? row.graph_y_max : 10,
    updatedAt: row.updated_at,
  }
}

function toHistory(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    mode: row.mode === 'scientific' ? 'scientific' : 'standard',
    expression: row.expression,
    result: row.result,
    tokens: parseJson(row.tokens_json, [], 'history tokens'),
    commands: parseJson(row.commands_json, [], 'history commands'),
    radix: row.radix === 16 || row.radix === 8 || row.radix === 2 ? row.radix : 10,
    createdAt: row.created_at,
  }
}

function toMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    value: parseJson(row.value_json, { n: '0', d: '1' }, 'memory value'),
    sort: row.sort,
    createdAt: row.created_at,
  }
}

function toAsset(row: AssetRow): CalculatorAsset {
  return {
    id: row.id,
    kind: row.kind as CalculatorAsset['kind'],
    fileFormat: row.file_format as CalculatorAsset['fileFormat'],
    mimeType: row.mime_type,
    fileSize: row.file_size,
    r2Key: row.r2_key,
    metadata: parseJson(row.metadata_json, {}, 'asset metadata'),
    createdAt: row.created_at,
  }
}

export class CalculatorStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async getSettings(): Promise<CalculatorSettings> {
    const row = await this.db
      .prepare('SELECT * FROM calculator_settings WHERE user_id = ?')
      .bind(this.userId)
      .first<SettingsRow>()
    return toSettings(row)
  }

  async updateSettings(partial: Partial<CalculatorSettings>): Promise<CalculatorSettings> {
    const current = await this.getSettings()
    const updated: CalculatorSettings = { ...current, ...partial, updatedAt: Date.now() }
    await this.db
      .prepare(
        `INSERT INTO calculator_settings
           (user_id, default_view, angle_mode, graph_theme, graph_line_width, graph_x_min, graph_x_max, graph_y_min, graph_y_max, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           default_view = excluded.default_view,
           angle_mode = excluded.angle_mode,
           graph_theme = excluded.graph_theme,
           graph_line_width = excluded.graph_line_width,
           graph_x_min = excluded.graph_x_min,
           graph_x_max = excluded.graph_x_max,
           graph_y_min = excluded.graph_y_min,
           graph_y_max = excluded.graph_y_max,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        updated.defaultView,
        updated.angleMode,
        updated.graphTheme,
        updated.graphLineWidth,
        updated.graphXMin,
        updated.graphXMax,
        updated.graphYMin,
        updated.graphYMax,
        updated.updatedAt ?? Date.now(),
      )
      .run()
    return updated
  }

  async listHistory(mode?: 'standard' | 'scientific'): Promise<HistoryEntry[]> {
    const sql = mode
      ? 'SELECT * FROM calculator_history WHERE user_id = ? AND mode = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM calculator_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    const statement = this.db.prepare(sql)
    const bound = mode ? statement.bind(this.userId, mode, HISTORY_LIMIT) : statement.bind(this.userId, HISTORY_LIMIT)
    const rows = await bound.all<HistoryRow>()
    return (rows.results ?? []).map(toHistory)
  }

  async appendHistory(entry: HistoryEntry): Promise<HistoryEntry[]> {
    const trim = this.db.prepare(
      `DELETE FROM calculator_history
        WHERE user_id = ? AND mode = ? AND id NOT IN (
          SELECT id FROM calculator_history
           WHERE user_id = ? AND mode = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
        )`,
    )
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO calculator_history
             (user_id, id, mode, expression, result, tokens_json, commands_json, radix, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO NOTHING`,
        )
        .bind(
          this.userId,
          entry.id,
          entry.mode,
          entry.expression,
          entry.result,
          JSON.stringify(entry.tokens),
          JSON.stringify(entry.commands),
          entry.radix,
          entry.createdAt,
        ),
      trim.bind(this.userId, entry.mode, this.userId, entry.mode, HISTORY_LIMIT),
    ])
    return this.listHistory()
  }

  async deleteHistory(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM calculator_history WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async clearHistory(mode?: 'standard' | 'scientific'): Promise<void> {
    if (mode) await this.db.prepare('DELETE FROM calculator_history WHERE user_id = ? AND mode = ?').bind(this.userId, mode).run()
    else await this.db.prepare('DELETE FROM calculator_history WHERE user_id = ?').bind(this.userId).run()
  }

  async listMemory(): Promise<MemoryEntry[]> {
    const rows = await this.db
      .prepare('SELECT id, value_json, sort, created_at FROM calculator_memory WHERE user_id = ? ORDER BY sort ASC, created_at DESC LIMIT ?')
      .bind(this.userId, MEMORY_LIMIT)
      .all<MemoryRow>()
    return (rows.results ?? []).map(toMemory)
  }

  async replaceMemory(entries: readonly MemoryEntry[]): Promise<MemoryEntry[]> {
    const limited = entries.slice(0, MEMORY_LIMIT)
    await this.db.prepare('DELETE FROM calculator_memory WHERE user_id = ?').bind(this.userId).run()
    for (let start = 0; start < limited.length; start += 40) {
      const statements = limited.slice(start, start + 40).map((entry, offset) => this.db
        .prepare('INSERT INTO calculator_memory (user_id, id, value_json, sort, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(this.userId, entry.id, JSON.stringify(entry.value), start + offset, entry.createdAt))
      await this.db.batch(statements)
    }
    return this.listMemory()
  }

  async clearMemory(): Promise<void> {
    await this.db.prepare('DELETE FROM calculator_memory WHERE user_id = ?').bind(this.userId).run()
  }

  async getGraph(): Promise<GraphSession> {
    const row = await this.db
      .prepare('SELECT equations_json, variables_json, viewport_json, updated_at FROM calculator_graph_sessions WHERE user_id = ?')
      .bind(this.userId)
      .first<GraphRow>()
    if (!row) return { equations: [], variables: [], viewport: { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, updatedAt: Date.now() }
    return {
      equations: parseJson(row.equations_json, [], 'graph equations'),
      variables: parseJson(row.variables_json, [], 'graph variables'),
      viewport: parseJson(row.viewport_json, { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, 'graph viewport'),
      updatedAt: row.updated_at,
    }
  }

  async updateGraph(graph: GraphSession): Promise<GraphSession> {
    const updatedAt = Date.now()
    await this.db
      .prepare(
        `INSERT INTO calculator_graph_sessions (user_id, equations_json, variables_json, viewport_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           equations_json = excluded.equations_json,
           variables_json = excluded.variables_json,
           viewport_json = excluded.viewport_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        JSON.stringify(graph.equations),
        JSON.stringify(graph.variables),
        JSON.stringify(graph.viewport),
        updatedAt,
      )
      .run()
    return { ...graph, updatedAt }
  }

  async listUnitPreferences(): Promise<UnitPreference[]> {
    const rows = await this.db
      .prepare('SELECT category_id, from_unit_id, to_unit_id, updated_at FROM calculator_unit_preferences WHERE user_id = ?')
      .bind(this.userId)
      .all<PreferenceRow>()
    return (rows.results ?? []).map((row) => ({
      categoryId: row.category_id,
      fromUnitId: row.from_unit_id,
      toUnitId: row.to_unit_id,
      updatedAt: row.updated_at,
    }))
  }

  async replaceUnitPreferences(entries: readonly UnitPreference[]): Promise<UnitPreference[]> {
    const statements = [this.db.prepare('DELETE FROM calculator_unit_preferences WHERE user_id = ?').bind(this.userId)]
    const now = Date.now()
    for (const entry of entries) {
      statements.push(
        this.db
          .prepare('INSERT INTO calculator_unit_preferences (user_id, category_id, from_unit_id, to_unit_id, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(this.userId, entry.categoryId, entry.fromUnitId, entry.toUnitId, now),
      )
    }
    await this.db.batch(statements)
    return this.listUnitPreferences()
  }

  async getCurrencyRates(): Promise<CurrencyRates | null> {
    const row = await this.db
      .prepare('SELECT base, rates_json, fetched_at FROM calculator_currency_rates WHERE base = ?')
      .bind('EUR')
      .first<{ base: string; rates_json: string; fetched_at: number }>()
    if (!row) return null
    const stored = parseJson<Record<string, unknown>>(row.rates_json, {}, 'currency rates')
    const envelope = stored.rates && typeof stored.rates === 'object' ? stored.rates as Record<string, number> : null
    const rates = envelope ?? stored as Record<string, number>
    const publishedAt = typeof stored.publishedAt === 'number' ? stored.publishedAt : row.fetched_at
    return {
      base: row.base,
      rates,
      fetchedAt: publishedAt,
      cachedAt: row.fetched_at,
      stale: false,
      source: 'ECB',
    }
  }

  async saveCurrencyRates(rates: CurrencyRates): Promise<CurrencyRates> {
    await this.db
      .prepare(
        `INSERT INTO calculator_currency_rates (base, rates_json, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(base) DO UPDATE SET rates_json = excluded.rates_json, fetched_at = excluded.fetched_at`,
      )
      .bind(rates.base, JSON.stringify({ rates: rates.rates, publishedAt: rates.fetchedAt }), rates.cachedAt)
      .run()
    return rates
  }

  async listAssets(kind?: string): Promise<CalculatorAsset[]> {
    const sql = kind
      ? 'SELECT id, kind, file_format, mime_type, file_size, r2_key, metadata_json, created_at FROM calculator_assets WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 50'
      : 'SELECT id, kind, file_format, mime_type, file_size, r2_key, metadata_json, created_at FROM calculator_assets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    const statement = this.db.prepare(sql)
    const bound = kind ? statement.bind(this.userId, kind) : statement.bind(this.userId)
    const rows = await bound.all<AssetRow>()
    return (rows.results ?? []).map(toAsset)
  }

  async getAsset(id: string): Promise<CalculatorAsset | null> {
    const row = await this.db
      .prepare('SELECT id, kind, file_format, mime_type, file_size, r2_key, metadata_json, created_at FROM calculator_assets WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<AssetRow>()
    return row ? toAsset(row) : null
  }

  async createAsset(asset: CalculatorAsset): Promise<CalculatorAsset> {
    await this.db
      .prepare(
        `INSERT INTO calculator_assets (user_id, id, kind, file_format, mime_type, file_size, r2_key, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.userId,
        asset.id,
        asset.kind,
        asset.fileFormat,
        asset.mimeType,
        asset.fileSize,
        asset.r2Key,
        JSON.stringify(asset.metadata),
        asset.createdAt,
      )
      .run()
    return asset
  }

  async deleteAsset(id: string): Promise<CalculatorAsset | null> {
    const asset = await this.getAsset(id)
    if (!asset) return null
    await this.db.prepare('DELETE FROM calculator_assets WHERE user_id = ? AND id = ?').bind(this.userId, id).run()
    return asset
  }
}
