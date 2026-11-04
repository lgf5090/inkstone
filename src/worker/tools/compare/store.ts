/**
 * D1 storage for the compare tool (`tools_compare_*`), scoped by `user_id` on every statement.
 *
 * An asset names bytes in R2; a project names two assets and the options they were compared with; a
 * run is one line in the ledger. Nothing here reads or writes a file's content — the R2 object is
 * streamed by the route — so a listing never pays for bytes it will not draw.
 */
import type {
  CompareAsset,
  CompareKind,
  CompareProject,
  CompareProjectInput,
  CompareProjectListItem,
  CompareRunInput,
  CompareStats,
  CompareStatsRows,
  CompareSummary,
  StatsRange,
  TextCompareOptions,
} from '@shared/tools/compare/types'
import { normalizeTextOptions } from '@shared/tools/compare/types'
import { ApiError } from '../../lib/errors'
import { shapeStats } from './stats'

export interface StoredAsset extends CompareAsset {
  r2_key: string
}

interface AssetRow {
  id: string
  user_id: string
  kind: CompareKind
  filename: string
  mime: string
  size: number
  encoding: string | null
  sha256: string | null
  r2_key: string
  created_at: number
}

interface ProjectRow {
  id: number
  user_id: string
  name: string
  kind: CompareKind
  left_label: string | null
  right_label: string | null
  options_json: string
  summary_json: string
  left_asset_id: string | null
  right_asset_id: string | null
  share_slug: string | null
  created_at: number
  updated_at: number
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toAsset(row: AssetRow): CompareAsset {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    encoding: row.encoding,
    sha256: row.sha256,
    created_at: row.created_at,
  }
}

function toStoredAsset(row: AssetRow): StoredAsset {
  return { ...toAsset(row), r2_key: row.r2_key }
}

function toProject(row: ProjectRow, left: CompareAsset | null, right: CompareAsset | null): CompareProject {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    left_label: row.left_label,
    right_label: row.right_label,
    options: normalizeTextOptions(parseJson<Partial<TextCompareOptions>>(row.options_json, {})),
    summary: parseJson<CompareSummary>(row.summary_json, {}),
    left_asset: left,
    right_asset: right,
    share_slug: row.share_slug,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export interface SharedProject {
  project: CompareProject
  left: StoredAsset | null
  right: StoredAsset | null
}

export class CompareStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async createAsset(input: {
    id: string
    kind: CompareKind
    filename: string
    mime: string
    size: number
    encoding: string | null
    sha256: string | null
    r2Key: string
  }): Promise<StoredAsset> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare(`INSERT INTO tools_compare_assets
        (id, user_id, kind, filename, mime, size, encoding, sha256, r2_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.id, this.userId, input.kind, input.filename, input.mime, input.size, input.encoding, input.sha256, input.r2Key, now)
      .run()
    return {
      id: input.id,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      size: input.size,
      encoding: input.encoding,
      sha256: input.sha256,
      created_at: now,
      r2_key: input.r2Key,
    }
  }

  async getAsset(id: string): Promise<StoredAsset | null> {
    const row = await this.db
      .prepare('SELECT * FROM tools_compare_assets WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<AssetRow>()
    return row ? toStoredAsset(row) : null
  }

  /** Assets of the signed-in reader, in the order given; ids they do not own are simply absent. */
  async assetsByIds(ids: readonly string[]): Promise<Map<string, StoredAsset>> {
    const unique = [...new Set(ids)]
    if (!unique.length) return new Map()
    const placeholders = unique.map(() => '?').join(', ')
    const result = await this.db
      .prepare(`SELECT * FROM tools_compare_assets WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(this.userId, ...unique)
      .all<AssetRow>()
    return new Map((result.results ?? []).map((row) => [row.id, toStoredAsset(row)]))
  }

  async deleteAsset(id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM tools_compare_assets WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .run()
  }

  async createProject(input: CompareProjectInput): Promise<CompareProject> {
    const assetIds = [input.left_asset_id, input.right_asset_id].filter((id): id is string => Boolean(id))
    const assets = await this.assetsByIds(assetIds)
    if (assetIds.length !== assets.size) throw ApiError.badRequest('Unknown attachment')
    const now = Math.floor(Date.now() / 1000)
    const result = await this.db
      .prepare(`INSERT INTO tools_compare_projects
        (user_id, name, kind, left_label, right_label, options_json, summary_json, left_asset_id, right_asset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        this.userId,
        input.name,
        input.kind,
        input.left_label ?? null,
        input.right_label ?? null,
        JSON.stringify(input.options ?? {}),
        JSON.stringify(input.summary ?? {}),
        input.left_asset_id ?? null,
        input.right_asset_id ?? null,
        now,
        now,
      )
      .run()
    const id = Number(result.meta.last_row_id)
    const project = await this.getProject(id)
    if (!project) throw new ApiError(500, 'internal', 'The saved comparison could not be read back')
    return project
  }

  async listProjects(options: { limit: number; offset: number; kind: CompareKind | null; search: string | null }): Promise<{ items: CompareProjectListItem[]; total: number }> {
    const clauses = ['p.user_id = ?']
    const params: unknown[] = [this.userId]
    if (options.kind) {
      clauses.push('p.kind = ?')
      params.push(options.kind)
    }
    if (options.search) {
      clauses.push('p.name LIKE ?')
      params.push(`%${options.search.replace(/[%_]/g, '')}%`)
    }
    const where = clauses.join(' AND ')
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM tools_compare_projects p WHERE ${where}`)
      .bind(...params)
      .first<{ total: number }>()
    const rows = await this.db
      .prepare(`SELECT p.*, la.filename AS left_filename, ra.filename AS right_filename
        FROM tools_compare_projects p
        LEFT JOIN tools_compare_assets la ON la.user_id = p.user_id AND la.id = p.left_asset_id
        LEFT JOIN tools_compare_assets ra ON ra.user_id = p.user_id AND ra.id = p.right_asset_id
        WHERE ${where}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ? OFFSET ?`)
      .bind(...params, options.limit, options.offset)
      .all<ProjectRow & { left_filename: string | null; right_filename: string | null }>()
    const items = (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      left_label: row.left_label,
      right_label: row.right_label,
      summary: parseJson<CompareSummary>(row.summary_json, {}),
      left_filename: row.left_filename,
      right_filename: row.right_filename,
      share_slug: row.share_slug,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
    return { items, total: totalRow?.total ?? 0 }
  }

  async getProject(id: number): Promise<CompareProject | null> {
    const row = await this.db
      .prepare('SELECT * FROM tools_compare_projects WHERE user_id = ? AND id = ?')
      .bind(this.userId, id)
      .first<ProjectRow>()
    if (!row) return null
    const assets = await this.assetsByIds([row.left_asset_id, row.right_asset_id].filter((value): value is string => Boolean(value)))
    return toProject(
      row,
      row.left_asset_id ? assets.get(row.left_asset_id) ?? null : null,
      row.right_asset_id ? assets.get(row.right_asset_id) ?? null : null,
    )
  }

  async updateProject(id: number, patch: { name?: string; options?: Partial<TextCompareOptions>; summary?: CompareSummary }): Promise<CompareProject> {
    const current = await this.getProject(id)
    if (!current) throw ApiError.notFound('Comparison not found')
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .prepare(`UPDATE tools_compare_projects
        SET name = ?, options_json = ?, summary_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ?`)
      .bind(
        patch.name ?? current.name,
        JSON.stringify({ ...current.options, ...(patch.options ?? {}) }),
        JSON.stringify(patch.summary ?? current.summary),
        now,
        this.userId,
        id,
      )
      .run()
    return (await this.getProject(id))!
  }

  /** Removes the project and any asset only it referenced; the returned keys are the R2 objects to drop. */
  async deleteProject(id: number): Promise<string[]> {
    const project = await this.getProject(id)
    if (!project) throw ApiError.notFound('Comparison not found')
    await this.db.prepare('DELETE FROM tools_compare_projects WHERE user_id = ? AND id = ?').bind(this.userId, id).run()
    const candidateIds = [project.left_asset?.id, project.right_asset?.id].filter((value): value is string => Boolean(value))
    const orphaned: string[] = []
    for (const assetId of candidateIds) {
      const stillUsed = await this.db
        .prepare(`SELECT COUNT(*) AS total FROM tools_compare_projects
          WHERE user_id = ? AND (left_asset_id = ? OR right_asset_id = ?)`)
        .bind(this.userId, assetId, assetId)
        .first<{ total: number }>()
      if (stillUsed?.total) continue
      const asset = await this.getAsset(assetId)
      if (!asset) continue
      await this.deleteAsset(assetId)
      orphaned.push(asset.r2_key)
    }
    return orphaned
  }

  async setShareSlug(id: number, slug: string): Promise<void> {
    await this.db
      .prepare('UPDATE tools_compare_projects SET share_slug = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(slug, Math.floor(Date.now() / 1000), this.userId, id)
      .run()
  }

  async clearShareSlug(id: number): Promise<void> {
    await this.db
      .prepare('UPDATE tools_compare_projects SET share_slug = NULL, updated_at = ? WHERE user_id = ? AND id = ?')
      .bind(Math.floor(Date.now() / 1000), this.userId, id)
      .run()
  }

  /** The public view of a shared comparison, with no user scope: the slug is the grant. */
  static async findSharedProject(db: D1Database, slug: string): Promise<SharedProject | null> {
    const row = await db
      .prepare('SELECT * FROM tools_compare_projects WHERE share_slug = ?')
      .bind(slug)
      .first<ProjectRow>()
    if (!row) return null
    const assetRows = row.left_asset_id || row.right_asset_id
      ? await db
        .prepare(`SELECT * FROM tools_compare_assets
          WHERE user_id = ? AND id IN (?, ?)`)
        .bind(row.user_id, row.left_asset_id ?? '', row.right_asset_id ?? '')
        .all<AssetRow>()
      : { results: [] as AssetRow[] }
    const assets = new Map((assetRows.results ?? []).map((asset) => [asset.id, toStoredAsset(asset)]))
    return {
      project: toProject(
        row,
        row.left_asset_id ? assets.get(row.left_asset_id) ?? null : null,
        row.right_asset_id ? assets.get(row.right_asset_id) ?? null : null,
      ),
      left: row.left_asset_id ? assets.get(row.left_asset_id) ?? null : null,
      right: row.right_asset_id ? assets.get(row.right_asset_id) ?? null : null,
    }
  }

  /** The R2 key and owner of a shared comparison's side, for the public asset route. */
  static async sharedAsset(db: D1Database, slug: string, side: 'left' | 'right'): Promise<StoredAsset | null> {
    const shared = await CompareStore.findSharedProject(db, slug)
    if (!shared) return null
    return side === 'left' ? shared.left : shared.right
  }

  async recordRun(input: CompareRunInput): Promise<void> {
    await this.db
      .prepare(`INSERT INTO tools_compare_runs
        (user_id, kind, mode, left_name, right_name, left_ext, right_ext, added_lines, removed_lines,
         changed_blocks, identical, left_bytes, right_bytes, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        this.userId,
        input.kind,
        input.mode,
        input.left_name ?? null,
        input.right_name ?? null,
        input.left_ext ?? null,
        input.right_ext ?? null,
        input.added_lines ?? 0,
        input.removed_lines ?? 0,
        input.changed_blocks ?? 0,
        input.identical ? 1 : 0,
        input.left_bytes ?? 0,
        input.right_bytes ?? 0,
        input.duration_ms ?? 0,
        Math.floor(Date.now() / 1000),
      )
      .run()
  }

  async stats(range: StatsRange): Promise<CompareStats> {
    const days = range === '7d' ? 7 : 30
    const since = Math.floor(Date.now() / 1000) - days * 86_400
    const scope = 'user_id = ? AND created_at >= ?'
    const [totals, kinds, extensions, trend] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*) AS total,
            SUM(identical) AS identical,
            SUM(added_lines + removed_lines) AS changed_lines,
            SUM(CASE WHEN added_lines + removed_lines > 0 THEN 1 ELSE 0 END) AS changed_runs
          FROM tools_compare_runs WHERE ${scope}`)
        .bind(this.userId, since)
        .first<{ total: number; identical: number | null; changed_lines: number | null; changed_runs: number | null }>(),
      this.db
        .prepare(`SELECT kind, COUNT(*) AS count FROM tools_compare_runs WHERE ${scope} GROUP BY kind`)
        .bind(this.userId, since)
        .all<{ kind: string; count: number }>(),
      this.db
        .prepare(`SELECT COALESCE(NULLIF(left_ext, ''), NULLIF(right_ext, '')) AS ext, COUNT(*) AS count
          FROM tools_compare_runs WHERE ${scope} AND COALESCE(NULLIF(left_ext, ''), NULLIF(right_ext, '')) IS NOT NULL
          GROUP BY ext ORDER BY count DESC LIMIT 20`)
        .bind(this.userId, since)
        .all<{ ext: string; count: number }>(),
      this.db
        .prepare(`SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day, COUNT(*) AS count
          FROM tools_compare_runs WHERE ${scope} GROUP BY day`)
        .bind(this.userId, since)
        .all<{ day: string; count: number }>(),
    ])

    const byKind: Record<string, number> = {}
    for (const row of kinds.results ?? []) byKind[row.kind] = row.count
    const raw: CompareStatsRows = {
      total: totals?.total ?? 0,
      identical: totals?.identical ?? 0,
      byKind,
      changedLinesTotal: totals?.changed_lines ?? 0,
      changedRuns: totals?.changed_runs ?? 0,
      extensions: (extensions.results ?? []).map((row) => ({ ext: row.ext, count: row.count })),
      trend: (trend.results ?? []).map((row) => ({ day: row.day, count: row.count })),
    }
    return shapeStats(range, raw)
  }
}
