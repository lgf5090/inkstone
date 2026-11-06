/**
 * D1 persistence for the Prompt Optimizer, scoped by `user_id` on every statement.
 *
 * The store owns SQL and row shapes; deciding what an optimization means belongs in `ai.ts`, and
 * HTTP shapes belong in the route. Nothing here reads a model or calls a provider.
 */

import {
  DEFAULT_SETTINGS,
  PROMPT_OPTIMIZER_LIMITS,
  type ArenaState,
  type AssetRecord,
  type BackupRecord,
  type ContextPackage,
  type EvaluationRecord,
  type FavoriteCategory,
  type FavoritePrompt,
  type FavoriteStats,
  type FavoriteVersion,
  type PromptOptimizerSettings,
  type PromptOptimizerStats,
  type PromptRecord,
  type PromptRecordChain,
  type PromptTemplate,
  type RecordType,
  type VariableEntry,
  type Workspace,
  type WorkspaceSession,
} from '@shared/tools/prompt-optimizer/types'
import type {
  ArenaSaveInput,
  CategoryInput,
  ContextInput,
  FavoriteInput,
  SettingsPatch,
  VariableInput,
} from '@shared/tools/prompt-optimizer/schemas'
import { newId } from '../../lib/id'

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

interface SettingsRow {
  default_text_model_id: string
  evaluation_model_id: string
  image_recognition_model_id: string
  image_model_id: string
  builtin_template_language: string
  template_selection: string
  workspace_model_selection: string
  history_retention_days: number
  autosave_drafts: number
  test_group_default: number
  updated_at: number
}

interface RecordRow {
  id: string
  chain_id: string
  version: number
  previous_id: string | null
  record_type: string
  workspace: string
  original_prompt: string
  optimized_prompt: string
  reasoning: string
  model_id: string
  model_label: string
  template_id: string
  iteration_note: string
  metadata: string
  created_at: number
}

interface TemplateRow {
  id: string
  name: string
  content: string
  template_type: string
  language: string
  description: string
  version: string
  created_at: number
  updated_at: number
}

interface CategoryRow {
  id: string
  name: string
  description: string
  parent_id: string | null
  color: string
  sort_order: number
  created_at: number
}

interface FavoriteRow {
  id: string
  title: string
  content: string
  description: string
  function_mode: string
  optimization_mode: string
  image_sub_mode: string
  category_id: string | null
  use_count: number
  metadata: string
  examples: string
  created_at: number
  updated_at: number
}

interface FavoriteVersionRow {
  id: string
  favorite_id: string
  version: number
  title: string
  content: string
  description: string
  metadata: string
  created_at: number
}

interface VariableRow {
  name: string
  value: string
  description: string
  created_at: number
  updated_at: number
}

interface ContextRow {
  id: string
  title: string
  mode: string
  messages: string
  variables: string
  tools: string
  tags: string
  description: string
  created_at: number
  updated_at: number
}

interface SessionRow {
  workspace: string
  rev: number
  state: string
  updated_at: number
}

interface AssetRow {
  id: string
  kind: string
  source: string
  r2_key: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  prompt: string
  created_at: number
}

interface EvaluationRow {
  id: string
  workspace: string
  evaluation_type: string
  score: number | null
  verdict: string
  payload: string
  record_id: string
  created_at: number
}

interface BackupRow {
  id: string
  filename: string
  r2_key: string
  bytes: number
  kind: string
  created_at: number
}

interface TagRow {
  favorite_id: string
  tag: string
}

const recordOf = (row: RecordRow): PromptRecord => ({
  id: row.id,
  chainId: row.chain_id,
  version: row.version,
  previousId: row.previous_id,
  recordType: row.record_type as RecordType,
  workspace: row.workspace as Workspace,
  originalPrompt: row.original_prompt,
  optimizedPrompt: row.optimized_prompt,
  reasoning: row.reasoning,
  modelId: row.model_id,
  modelLabel: row.model_label,
  templateId: row.template_id,
  iterationNote: row.iteration_note,
  metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  createdAt: row.created_at,
})

const categoryOf = (row: CategoryRow): FavoriteCategory => ({
  id: row.id,
  name: row.name,
  description: row.description,
  parentId: row.parent_id,
  color: row.color,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
})

const favoriteOf = (row: FavoriteRow, tags: string[]): FavoritePrompt => ({
  id: row.id,
  title: row.title,
  content: row.content,
  description: row.description,
  functionMode: row.function_mode,
  optimizationMode: row.optimization_mode,
  imageSubMode: row.image_sub_mode,
  categoryId: row.category_id,
  tags,
  useCount: row.use_count,
  metadata: parseJson(row.metadata, {}),
  examples: parseJson(row.examples, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const assetOf = (row: AssetRow): AssetRecord => ({
  id: row.id,
  kind: 'image',
  source: row.source === 'generated' ? 'generated' : 'upload',
  mime: row.mime,
  bytes: row.bytes,
  width: row.width,
  height: row.height,
  prompt: row.prompt,
  createdAt: row.created_at,
})

export class PromptOptimizerStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  private async count(table: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ total: number }>()
    return row?.total ?? 0
  }

  async getSettings(): Promise<PromptOptimizerSettings> {
    const row = await this.db
      .prepare(
        `SELECT default_text_model_id, evaluation_model_id, image_recognition_model_id, image_model_id,
                builtin_template_language, template_selection, workspace_model_selection,
                history_retention_days, autosave_drafts, test_group_default, updated_at
           FROM tools_PromptOptimizer_settings WHERE user_id = ?`,
      )
      .bind(this.userId)
      .first<SettingsRow>()
    if (!row) return { ...DEFAULT_SETTINGS }
    return {
      defaultTextModelId: row.default_text_model_id,
      evaluationModelId: row.evaluation_model_id,
      imageRecognitionModelId: row.image_recognition_model_id,
      imageModelId: row.image_model_id,
      builtinTemplateLanguage: row.builtin_template_language === 'en' ? 'en' : 'zh',
      templateSelection: parseJson(row.template_selection, {}),
      workspaceModelSelection: parseJson(row.workspace_model_selection, {}),
      historyRetentionDays: row.history_retention_days,
      autosaveDrafts: row.autosave_drafts === 1,
      testGroupDefault: row.test_group_default,
      updatedAt: row.updated_at,
    }
  }

  async saveSettings(patch: SettingsPatch): Promise<PromptOptimizerSettings> {
    const current = await this.getSettings()
    const next: PromptOptimizerSettings = { ...current, ...patch, updatedAt: Date.now() }
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_settings
           (user_id, default_text_model_id, evaluation_model_id, image_recognition_model_id, image_model_id,
            builtin_template_language, template_selection,
            workspace_model_selection, history_retention_days, autosave_drafts, test_group_default, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           default_text_model_id = excluded.default_text_model_id,
           evaluation_model_id = excluded.evaluation_model_id,
           image_recognition_model_id = excluded.image_recognition_model_id,
           image_model_id = excluded.image_model_id,
           builtin_template_language = excluded.builtin_template_language,
           template_selection = excluded.template_selection,
           workspace_model_selection = excluded.workspace_model_selection,
           history_retention_days = excluded.history_retention_days,
           autosave_drafts = excluded.autosave_drafts,
           test_group_default = excluded.test_group_default,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        next.defaultTextModelId,
        next.evaluationModelId,
        next.imageRecognitionModelId,
        next.imageModelId,
        next.builtinTemplateLanguage,
        JSON.stringify(next.templateSelection),
        JSON.stringify(next.workspaceModelSelection),
        next.historyRetentionDays,
        next.autosaveDrafts ? 1 : 0,
        next.testGroupDefault,
        next.updatedAt,
      )
      .run()
    return next
  }

  async createRecord(input: {
    chainId: string
    recordType: RecordType
    workspace: Workspace
    originalPrompt: string
    optimizedPrompt: string
    reasoning?: string
    modelId?: string
    modelLabel?: string
    templateId?: string
    iterationNote?: string
    metadata?: Record<string, unknown>
  }): Promise<PromptRecord> {
    const previous = await this.db
      .prepare(
        `SELECT id, version FROM tools_PromptOptimizer_records
          WHERE user_id = ? AND chain_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .bind(this.userId, input.chainId)
      .first<{ id: string; version: number }>()
    const record: PromptRecord = {
      id: newId(),
      chainId: input.chainId,
      version: (previous?.version ?? 0) + 1,
      previousId: previous?.id ?? null,
      recordType: input.recordType,
      workspace: input.workspace,
      originalPrompt: input.originalPrompt,
      optimizedPrompt: input.optimizedPrompt,
      reasoning: input.reasoning ?? '',
      modelId: input.modelId ?? '',
      modelLabel: input.modelLabel ?? '',
      templateId: input.templateId ?? '',
      iterationNote: input.iterationNote ?? '',
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
    }
    await this.insertRecord(record)
    return record
  }

  async insertRecord(record: PromptRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_records
           (id, user_id, chain_id, version, previous_id, record_type, workspace, original_prompt,
            optimized_prompt, reasoning, model_id, model_label, template_id, iteration_note, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        this.userId,
        record.chainId,
        record.version,
        record.previousId,
        record.recordType,
        record.workspace,
        record.originalPrompt,
        record.optimizedPrompt,
        record.reasoning,
        record.modelId,
        record.modelLabel,
        record.templateId,
        record.iterationNote,
        JSON.stringify(record.metadata),
        record.createdAt,
      )
      .run()
  }

  async listChains(options: { search?: string; workspace?: string; limit?: number; offset?: number } = {}): Promise<PromptRecordChain[]> {
    const limit = Math.min(options.limit ?? PROMPT_OPTIMIZER_LIMITS.historyMaxChains, PROMPT_OPTIMIZER_LIMITS.historyMaxChains)
    const offset = Math.max(0, options.offset ?? 0)
    const conditions = ['r.user_id = ?']
    const params: (string | number)[] = [this.userId]
    if (options.workspace) {
      conditions.push(`EXISTS (SELECT 1 FROM tools_PromptOptimizer_records w
        WHERE w.user_id = r.user_id AND w.chain_id = r.chain_id AND w.workspace = ?)`)
      params.push(options.workspace)
    }
    const search = options.search?.trim().toLowerCase() ?? ''
    if (search) {
      const pattern = `%${search}%`
      conditions.push(`EXISTS (SELECT 1 FROM tools_PromptOptimizer_records s
        WHERE s.user_id = r.user_id AND s.chain_id = r.chain_id
          AND (lower(s.original_prompt) LIKE ? OR lower(s.optimized_prompt) LIKE ? OR lower(s.iteration_note) LIKE ?))`)
      params.push(pattern, pattern, pattern)
    }
    const chainRows = await this.db
      .prepare(
        `SELECT r.chain_id AS chain_id, MAX(r.created_at) AS last_at
           FROM tools_PromptOptimizer_records r
          WHERE ${conditions.join(' AND ')}
          GROUP BY r.chain_id
          ORDER BY last_at DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<{ chain_id: string; last_at: number }>()
    const chainIds = (chainRows.results ?? []).map((row) => row.chain_id)
    if (!chainIds.length) return []
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_PromptOptimizer_records
          WHERE user_id = ? AND chain_id IN (${chainIds.map(() => '?').join(',')})
          ORDER BY version ASC`,
      )
      .bind(this.userId, ...chainIds)
      .all<RecordRow>()
    const grouped = new Map<string, PromptRecord[]>()
    for (const row of rows.results ?? []) {
      const record = recordOf(row)
      const list = grouped.get(record.chainId)
      if (list) list.push(record)
      else grouped.set(record.chainId, [record])
    }
    return chainIds.flatMap((chainId) => {
      const versions = grouped.get(chainId)
      if (!versions?.length) return []
      return [{
        chainId,
        rootRecord: versions[0]!,
        currentRecord: versions[versions.length - 1]!,
        versions,
      }]
    })
  }

  async deleteChain(chainId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_records WHERE user_id = ? AND chain_id = ?`)
      .bind(this.userId, chainId)
      .run()
  }

  async clearHistory(): Promise<void> {
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_records WHERE user_id = ?`).bind(this.userId).run()
  }

  async pruneHistory(olderThanMs: number): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_records WHERE user_id = ? AND created_at < ?`)
      .bind(this.userId, olderThanMs)
      .run()
    return result.meta?.changes ?? 0
  }

  async listTemplates(): Promise<PromptTemplate[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_templates WHERE user_id = ? ORDER BY updated_at DESC`)
      .bind(this.userId)
      .all<TemplateRow>()
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      content: parseJson(row.content, ''),
      metadata: {
        version: row.version,
        lastModified: row.updated_at,
        description: row.description,
        templateType: row.template_type as PromptTemplate['metadata']['templateType'],
        language: row.language === 'en' ? 'en' : row.language === 'zh' ? 'zh' : undefined,
      },
      isBuiltin: false,
      userId: this.userId,
    }))
  }

  async getTemplate(id: string): Promise<PromptTemplate | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_templates WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .first<TemplateRow>()
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      content: parseJson(row.content, ''),
      metadata: {
        version: row.version,
        lastModified: row.updated_at,
        description: row.description,
        templateType: row.template_type as PromptTemplate['metadata']['templateType'],
        language: row.language === 'en' ? 'en' : row.language === 'zh' ? 'zh' : undefined,
      },
      isBuiltin: false,
      userId: this.userId,
    }
  }

  async saveTemplate(template: PromptTemplate): Promise<PromptTemplate> {
    const existing = await this.getTemplate(template.id)
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_templates
           (id, user_id, name, content, template_type, language, description, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           name = excluded.name,
           content = excluded.content,
           template_type = excluded.template_type,
           language = excluded.language,
           description = excluded.description,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .bind(
        template.id,
        this.userId,
        template.name,
        JSON.stringify(template.content),
        template.metadata.templateType,
        template.metadata.language ?? '',
        template.metadata.description ?? '',
        template.metadata.version || '1.0.0',
        existing?.metadata.lastModified ?? now,
        now,
      )
      .run()
    return (await this.getTemplate(template.id))!
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_templates WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()
  }

  async listCategories(): Promise<FavoriteCategory[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_PromptOptimizer_categories
          WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC`,
      )
      .bind(this.userId)
      .all<CategoryRow>()
    return (rows.results ?? []).map(categoryOf)
  }

  async saveCategory(input: CategoryInput, id?: string): Promise<FavoriteCategory> {
    const categoryId = id ?? newId()
    const existing = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_categories WHERE user_id = ? AND id = ?`)
      .bind(this.userId, categoryId)
      .first<CategoryRow>()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_categories
           (id, user_id, name, description, parent_id, color, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           parent_id = excluded.parent_id,
           color = excluded.color,
           sort_order = excluded.sort_order`,
      )
      .bind(
        categoryId,
        this.userId,
        input.name,
        input.description,
        input.parentId ?? null,
        input.color,
        input.sortOrder,
        existing?.created_at ?? Date.now(),
      )
      .run()
    return categoryOf((await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_categories WHERE user_id = ? AND id = ?`)
      .bind(this.userId, categoryId)
      .first<CategoryRow>())!)
  }

  async deleteCategory(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_categories WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .run()
    await this.db
      .prepare(
        `UPDATE tools_PromptOptimizer_favorites SET category_id = NULL WHERE user_id = ? AND category_id = ?`,
      )
      .bind(this.userId, id)
      .run()
  }

  private async tagsFor(favoriteIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    if (!favoriteIds.length) return map
    const placeholders = favoriteIds.map(() => '?').join(',')
    const rows = await this.db
      .prepare(
        `SELECT favorite_id, tag FROM tools_PromptOptimizer_favorite_tags
          WHERE user_id = ? AND favorite_id IN (${placeholders}) ORDER BY tag ASC`,
      )
      .bind(this.userId, ...favoriteIds)
      .all<TagRow>()
    for (const row of rows.results ?? []) {
      const list = map.get(row.favorite_id)
      if (list) list.push(row.tag)
      else map.set(row.favorite_id, [row.tag])
    }
    return map
  }

  async listFavorites(options: { search?: string; categoryId?: string; tag?: string; limit?: number; offset?: number } = {}): Promise<FavoritePrompt[]> {
    const conditions = ['f.user_id = ?']
    const params: string[] = [this.userId]
    if (options.categoryId) {
      conditions.push('f.category_id = ?')
      params.push(options.categoryId)
    }
    if (options.tag) {
      conditions.push(`EXISTS (SELECT 1 FROM tools_PromptOptimizer_favorite_tags t
        WHERE t.user_id = f.user_id AND t.favorite_id = f.id AND t.tag = ?)`)
      params.push(options.tag)
    }
    const search = options.search?.trim().toLowerCase() ?? ''
    if (search) {
      const pattern = `%${search}%`
      conditions.push(`(lower(f.title) LIKE ? OR lower(f.content) LIKE ? OR lower(f.description) LIKE ?
        OR EXISTS (SELECT 1 FROM tools_PromptOptimizer_favorite_tags s
          WHERE s.user_id = f.user_id AND s.favorite_id = f.id AND lower(s.tag) LIKE ?))`)
      params.push(pattern, pattern, pattern, pattern)
    }
    const limit = options.limit ?? PROMPT_OPTIMIZER_LIMITS.favoritesPageSize * 4
    const offset = Math.max(0, options.offset ?? 0)
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_PromptOptimizer_favorites f
          WHERE ${conditions.join(' AND ')}
          ORDER BY f.updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<FavoriteRow>()
    const items = rows.results ?? []
    const tags = await this.tagsFor(items.map((row) => row.id))
    return items.map((row) => favoriteOf(row, tags.get(row.id) ?? []))
  }

  async getFavorite(id: string): Promise<FavoritePrompt | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_favorites WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .first<FavoriteRow>()
    if (!row) return null
    return favoriteOf(row, (await this.tagsFor([id])).get(id) ?? [])
  }

  async saveFavorite(input: FavoriteInput, id?: string): Promise<FavoritePrompt> {
    const favoriteId = id ?? newId()
    const existing = await this.getFavorite(favoriteId)
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_favorites
           (id, user_id, title, content, description, function_mode, optimization_mode, image_sub_mode,
            category_id, use_count, metadata, examples, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           description = excluded.description,
           function_mode = excluded.function_mode,
           optimization_mode = excluded.optimization_mode,
           image_sub_mode = excluded.image_sub_mode,
           category_id = excluded.category_id,
           metadata = excluded.metadata,
           examples = excluded.examples,
           updated_at = excluded.updated_at`,
      )
      .bind(
        favoriteId,
        this.userId,
        input.title,
        input.content,
        input.description,
        input.functionMode,
        input.optimizationMode ?? '',
        input.imageSubMode ?? '',
        input.categoryId ?? null,
        existing?.useCount ?? 0,
        JSON.stringify(input.metadata),
        JSON.stringify(input.examples ?? []),
        existing?.createdAt ?? now,
        now,
      )
      .run()
    if (existing && existing.content !== input.content) {
      await this.addFavoriteVersion(existing, (await this.countFavoriteVersions(favoriteId)) + 1)
    }
    await this.replaceTags(favoriteId, input.tags)
    for (const version of input.versions ?? []) {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_favorite_versions
             (id, user_id, favorite_id, version, title, content, description, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          version.id || newId(),
          this.userId,
          favoriteId,
          version.version,
          version.title,
          version.content,
          version.description,
          JSON.stringify(version.metadata),
          version.createdAt,
        )
        .run()
    }
    return (await this.getFavorite(favoriteId))!
  }

  private async replaceTags(favoriteId: string, tags: string[]): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_favorite_tags WHERE user_id = ? AND favorite_id = ?`)
      .bind(this.userId, favoriteId)
      .run()
    for (const tag of [...new Set(tags.map((value) => value.trim()).filter(Boolean))]) {
      await this.db
        .prepare(
          `INSERT INTO tools_PromptOptimizer_favorite_tags (user_id, favorite_id, tag, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(this.userId, favoriteId, tag, Date.now())
        .run()
    }
  }

  async deleteFavorite(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_favorites WHERE user_id = ? AND id = ?`).bind(this.userId, id).run()
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_favorite_tags WHERE user_id = ? AND favorite_id = ?`).bind(this.userId, id).run()
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_favorite_versions WHERE user_id = ? AND favorite_id = ?`).bind(this.userId, id).run()
  }

  async touchFavorite(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tools_PromptOptimizer_favorites
            SET use_count = use_count + 1, updated_at = updated_at
          WHERE user_id = ? AND id = ?`,
      )
      .bind(this.userId, id)
      .run()
  }

  async countFavoriteVersions(favoriteId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM tools_PromptOptimizer_favorite_versions
          WHERE user_id = ? AND favorite_id = ?`,
      )
      .bind(this.userId, favoriteId)
      .first<{ total: number }>()
    return row?.total ?? 0
  }

  async addFavoriteVersion(favorite: FavoritePrompt, version: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_favorite_versions
           (id, user_id, favorite_id, version, title, content, description, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        this.userId,
        favorite.id,
        version,
        favorite.title,
        favorite.content,
        favorite.description,
        JSON.stringify(favorite.metadata),
        Date.now(),
      )
      .run()
  }

  async favoriteStats(): Promise<FavoriteStats> {
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM tools_PromptOptimizer_favorites WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ total: number }>()
    const tags = await this.db
      .prepare(
        `SELECT tag, COUNT(*) AS total FROM tools_PromptOptimizer_favorite_tags
          WHERE user_id = ? GROUP BY tag ORDER BY total DESC, tag ASC LIMIT 50`,
      )
      .bind(this.userId)
      .all<{ tag: string; total: number }>()
    const categories = await this.db
      .prepare(
        `SELECT c.id AS id, c.name AS name, COUNT(f.id) AS total
           FROM tools_PromptOptimizer_categories c
           LEFT JOIN tools_PromptOptimizer_favorites f
             ON f.user_id = c.user_id AND f.category_id = c.id
          WHERE c.user_id = ?
          GROUP BY c.id, c.name ORDER BY total DESC, c.name ASC`,
      )
      .bind(this.userId)
      .all<{ id: string; name: string; total: number }>()
    return {
      total: totalRow?.total ?? 0,
      tags: (tags.results ?? []).map((row) => ({ tag: row.tag, count: row.total })),
      categories: (categories.results ?? []).map((row) => ({ id: row.id, name: row.name, count: row.total })),
    }
  }

  async listFavoriteVersions(favoriteId: string): Promise<FavoriteVersion[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM tools_PromptOptimizer_favorite_versions
          WHERE user_id = ? AND favorite_id = ? ORDER BY version DESC`,
      )
      .bind(this.userId, favoriteId)
      .all<FavoriteVersionRow>()
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      favoriteId: row.favorite_id,
      version: row.version,
      title: row.title,
      content: row.content,
      description: row.description,
      metadata: parseJson(row.metadata, {}),
      createdAt: row.created_at,
    }))
  }

  async listVariables(): Promise<VariableEntry[]> {
    const rows = await this.db
      .prepare(`SELECT name, value, description, created_at, updated_at FROM tools_PromptOptimizer_variables
                WHERE user_id = ? ORDER BY name ASC`)
      .bind(this.userId)
      .all<VariableRow>()
    return (rows.results ?? []).map((row) => ({
      name: row.name,
      value: row.value,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async saveVariable(input: VariableInput): Promise<VariableEntry> {
    const existing = await this.db
      .prepare(`SELECT created_at FROM tools_PromptOptimizer_variables WHERE user_id = ? AND name = ?`)
      .bind(this.userId, input.name)
      .first<{ created_at: number }>()
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_variables (user_id, name, value, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET
           value = excluded.value, description = excluded.description, updated_at = excluded.updated_at`,
      )
      .bind(this.userId, input.name, input.value, input.description, existing?.created_at ?? now, now)
      .run()
    return {
      name: input.name,
      value: input.value,
      description: input.description,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    }
  }

  async deleteVariable(name: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_PromptOptimizer_variables WHERE user_id = ? AND name = ?`)
      .bind(this.userId, name)
      .run()
  }

  async listContexts(): Promise<ContextPackage[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_contexts WHERE user_id = ? ORDER BY updated_at DESC`)
      .bind(this.userId)
      .all<ContextRow>()
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      mode: row.mode === 'user' ? 'user' : 'system',
      messages: parseJson(row.messages, []),
      variables: parseJson(row.variables, {}),
      tools: parseJson(row.tools, []),
      tags: parseJson(row.tags, []),
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async saveContext(input: ContextInput, id?: string): Promise<ContextPackage> {
    const contextId = id ?? newId()
    const existing = await this.db
      .prepare(`SELECT created_at FROM tools_PromptOptimizer_contexts WHERE user_id = ? AND id = ?`)
      .bind(this.userId, contextId)
      .first<{ created_at: number }>()
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_contexts
           (id, user_id, title, mode, messages, variables, tools, tags, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           title = excluded.title, mode = excluded.mode, messages = excluded.messages,
           variables = excluded.variables, tools = excluded.tools, tags = excluded.tags,
           description = excluded.description, updated_at = excluded.updated_at`,
      )
      .bind(
        contextId,
        this.userId,
        input.title,
        input.mode,
        JSON.stringify(input.messages),
        JSON.stringify(input.variables),
        JSON.stringify(input.tools),
        JSON.stringify(input.tags),
        input.description,
        existing?.created_at ?? now,
        now,
      )
      .run()
    return {
      id: contextId,
      title: input.title,
      mode: input.mode,
      messages: input.messages,
      variables: input.variables,
      tools: input.tools,
      tags: input.tags,
      description: input.description,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    }
  }

  async deleteContext(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_contexts WHERE user_id = ? AND id = ?`).bind(this.userId, id).run()
  }

  async getSession(workspace: string): Promise<WorkspaceSession | null> {
    const row = await this.db
      .prepare(`SELECT workspace, rev, state, updated_at FROM tools_PromptOptimizer_sessions WHERE user_id = ? AND workspace = ?`)
      .bind(this.userId, workspace)
      .first<SessionRow>()
    if (!row) return null
    return {
      workspace: row.workspace as Workspace,
      rev: row.rev,
      state: parseJson(row.state, {}),
      updatedAt: row.updated_at,
    }
  }

  async saveSession(workspace: string, rev: number, state: Record<string, unknown>): Promise<WorkspaceSession> {
    const current = await this.getSession(workspace)
    if (current && current.rev !== rev) {
      throw new SessionConflictError(current)
    }
    const nextRev = (current?.rev ?? 0) + 1
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_sessions (user_id, workspace, rev, state, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace) DO UPDATE SET
           rev = excluded.rev, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(this.userId, workspace, nextRev, JSON.stringify(state), now)
      .run()
    return { workspace: workspace as Workspace, rev: nextRev, state, updatedAt: now }
  }

  async getArena(): Promise<ArenaState | null> {
    const row = await this.db
      .prepare(`SELECT state FROM tools_PromptOptimizer_arena WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ state: string }>()
    return row ? parseJson<ArenaState | null>(row.state, null) : null
  }

  async saveArena(input: ArenaSaveInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_arena (user_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(this.userId, JSON.stringify(input), Date.now())
      .run()
  }

  async insertAsset(row: {
    id: string
    kind: 'image'
    source: 'upload' | 'generated'
    r2Key: string
    mime: string
    bytes: number
    width: number | null
    height: number | null
    prompt: string
  }): Promise<AssetRecord> {
    const createdAt = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_assets
           (id, user_id, kind, source, r2_key, mime, bytes, width, height, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        this.userId,
        row.kind,
        row.source,
        row.r2Key,
        row.mime,
        row.bytes,
        row.width,
        row.height,
        row.prompt,
        createdAt,
      )
      .run()
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      mime: row.mime,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      prompt: row.prompt,
      createdAt,
    }
  }

  async getAsset(id: string): Promise<(AssetRecord & { r2Key: string }) | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_assets WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .first<AssetRow>()
    if (!row) return null
    return { ...assetOf(row), r2Key: row.r2_key }
  }

  async listAssets(limit = 200): Promise<AssetRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_assets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(this.userId, limit)
      .all<AssetRow>()
    return (rows.results ?? []).map(assetOf)
  }

  async deleteAsset(id: string): Promise<(AssetRecord & { r2Key: string }) | null> {
    const asset = await this.getAsset(id)
    if (!asset) return null
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_assets WHERE user_id = ? AND id = ?`).bind(this.userId, id).run()
    return asset
  }

  async insertEvaluation(row: {
    id?: string
    workspace: string
    evaluationType: EvaluationRecord['evaluationType']
    score: number | null
    verdict: string
    payload: Record<string, unknown>
    recordId?: string
  }): Promise<EvaluationRecord> {
    const record: EvaluationRecord = {
      id: row.id ?? newId(),
      workspace: row.workspace,
      evaluationType: row.evaluationType,
      score: row.score,
      verdict: row.verdict,
      payload: row.payload,
      recordId: row.recordId ?? '',
      createdAt: Date.now(),
    }
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_evaluations
           (id, user_id, workspace, evaluation_type, score, verdict, payload, record_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        this.userId,
        record.workspace,
        record.evaluationType,
        record.score,
        record.verdict,
        JSON.stringify(record.payload),
        record.recordId,
        record.createdAt,
      )
      .run()
    return record
  }

  async insertBackup(row: { id?: string; filename: string; r2Key: string; bytes: number; kind: 'manual' }): Promise<BackupRecord> {
    const record: BackupRecord = {
      id: row.id ?? newId(),
      filename: row.filename,
      bytes: row.bytes,
      kind: row.kind,
      createdAt: Date.now(),
    }
    await this.db
      .prepare(
        `INSERT INTO tools_PromptOptimizer_backups (id, user_id, filename, r2_key, bytes, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(record.id, this.userId, record.filename, row.r2Key, record.bytes, record.kind, record.createdAt)
      .run()
    return record
  }

  async listBackups(limit = PROMPT_OPTIMIZER_LIMITS.backupsMax): Promise<BackupRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(this.userId, limit)
      .all<BackupRow>()
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      filename: row.filename,
      bytes: row.bytes,
      kind: 'manual',
      createdAt: row.created_at,
    }))
  }

  async getBackup(id: string): Promise<(BackupRecord & { r2Key: string }) | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tools_PromptOptimizer_backups WHERE user_id = ? AND id = ?`)
      .bind(this.userId, id)
      .first<BackupRow>()
    if (!row) return null
    return {
      id: row.id,
      filename: row.filename,
      bytes: row.bytes,
      kind: 'manual',
      createdAt: row.created_at,
      r2Key: row.r2_key,
    }
  }

  async deleteBackup(id: string): Promise<(BackupRecord & { r2Key: string }) | null> {
    const backup = await this.getBackup(id)
    if (!backup) return null
    await this.db.prepare(`DELETE FROM tools_PromptOptimizer_backups WHERE user_id = ? AND id = ?`).bind(this.userId, id).run()
    return backup
  }

  async stats(): Promise<PromptOptimizerStats> {
    const [historyRecords, favorites, templates, evaluations, assets, backups] = await Promise.all([
      this.count('tools_PromptOptimizer_records'),
      this.count('tools_PromptOptimizer_favorites'),
      this.count('tools_PromptOptimizer_templates'),
      this.count('tools_PromptOptimizer_evaluations'),
      this.count('tools_PromptOptimizer_assets'),
      this.count('tools_PromptOptimizer_backups'),
    ])
    const chains = await this.db
      .prepare(`SELECT COUNT(DISTINCT chain_id) AS total FROM tools_PromptOptimizer_records WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ total: number }>()
    return {
      historyChains: chains?.total ?? 0,
      historyRecords,
      favorites,
      templates,
      evaluations,
      assets,
      backups,
    }
  }

  async exportAll(): Promise<Record<string, unknown>> {
    const [settings, records, templates, categories, favorites, versions, variables, contexts, sessions, evaluations, assets, backups] =
      await Promise.all([
        this.getSettings(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_records WHERE user_id = ?`).bind(this.userId).all<RecordRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_templates WHERE user_id = ?`).bind(this.userId).all<TemplateRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_categories WHERE user_id = ?`).bind(this.userId).all<CategoryRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_favorites WHERE user_id = ?`).bind(this.userId).all<FavoriteRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_favorite_versions WHERE user_id = ?`).bind(this.userId).all<FavoriteVersionRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_variables WHERE user_id = ?`).bind(this.userId).all<VariableRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_contexts WHERE user_id = ?`).bind(this.userId).all<ContextRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_sessions WHERE user_id = ?`).bind(this.userId).all<SessionRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_evaluations WHERE user_id = ?`).bind(this.userId).all<EvaluationRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_assets WHERE user_id = ?`).bind(this.userId).all<AssetRow>(),
        this.db.prepare(`SELECT * FROM tools_PromptOptimizer_backups WHERE user_id = ?`).bind(this.userId).all<BackupRow>(),
      ])
    const tags = await this.db
      .prepare(`SELECT favorite_id, tag FROM tools_PromptOptimizer_favorite_tags WHERE user_id = ?`)
      .bind(this.userId)
      .all<TagRow>()
    return {
      format: 'inkstone-prompt-optimizer',
      version: 1,
      exportedAt: Date.now(),
      settings,
      records: records.results ?? [],
      templates: templates.results ?? [],
      categories: categories.results ?? [],
      favorites: favorites.results ?? [],
      favoriteVersions: versions.results ?? [],
      favoriteTags: tags.results ?? [],
      variables: variables.results ?? [],
      contexts: contexts.results ?? [],
      sessions: sessions.results ?? [],
      evaluations: evaluations.results ?? [],
      assets: assets.results ?? [],
      backups: backups.results ?? [],
    }
  }

  async exportScope(scope: 'all' | 'history' | 'favorites', filter: { search?: string; workspace?: string } = {}): Promise<Record<string, unknown>> {
    if (scope === 'all') return await this.exportAll()
    const all = await this.exportAll()
    if (scope === 'history') {
      const search = filter.search?.trim().toLowerCase() ?? ''
      const rows = (all.records as Record<string, unknown>[]).filter((row) => {
        if (filter.workspace && row.workspace !== filter.workspace) return false
        if (!search) return true
        return ['original_prompt', 'optimized_prompt', 'iteration_note'].some((key) => String(row[key] ?? '').toLowerCase().includes(search))
      })
      const ids = new Set(rows.map((row) => String(row.id ?? '')))
      return {
        format: all.format,
        version: all.version,
        exportedAt: all.exportedAt,
        records: rows,
        evaluations: (all.evaluations as Record<string, unknown>[]).filter((row) => ids.has(String(row.record_id ?? ''))),
      }
    }
    return {
      format: all.format,
      version: all.version,
      exportedAt: all.exportedAt,
      favorites: all.favorites,
      categories: all.categories,
      favoriteTags: all.favoriteTags,
      favoriteVersions: all.favoriteVersions,
    }
  }

  async clearContent(): Promise<void> {
    const tables = [
      'tools_PromptOptimizer_records',
      'tools_PromptOptimizer_templates',
      'tools_PromptOptimizer_categories',
      'tools_PromptOptimizer_favorites',
      'tools_PromptOptimizer_favorite_tags',
      'tools_PromptOptimizer_favorite_versions',
      'tools_PromptOptimizer_variables',
      'tools_PromptOptimizer_contexts',
      'tools_PromptOptimizer_sessions',
      'tools_PromptOptimizer_arena',
      'tools_PromptOptimizer_evaluations',
      'tools_PromptOptimizer_assets',
      'tools_PromptOptimizer_backups',
    ]
    for (const table of tables) {
      await this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(this.userId).run()
    }
  }

  async importAll(payload: Record<string, unknown>): Promise<{ imported: Record<string, number> }> {
    const counts: Record<string, number> = {}
    const statements: D1PreparedStatement[] = []
    const rowsOf = (key: string): Record<string, unknown>[] => {
      const value = payload[key]
      return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
    }
    const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
    const number = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    const json = (value: unknown, fallback = '{}') => (typeof value === 'string' ? value : JSON.stringify(value ?? JSON.parse(fallback)))

    const settings = payload.settings as Record<string, unknown> | undefined
    if (settings && typeof settings === 'object') {
      const current = await this.getSettings()
      const next: PromptOptimizerSettings = {
        ...current,
        defaultTextModelId: text(settings.defaultTextModelId),
        evaluationModelId: text(settings.evaluationModelId),
        imageRecognitionModelId: text(settings.imageRecognitionModelId),
        imageModelId: text(settings.imageModelId),
        builtinTemplateLanguage: settings.builtinTemplateLanguage === 'en' ? 'en' : 'zh',
        templateSelection: (settings.templateSelection as Record<string, string>) ?? {},
        workspaceModelSelection: (settings.workspaceModelSelection as Record<string, string>) ?? {},
        historyRetentionDays: number(settings.historyRetentionDays),
        autosaveDrafts: settings.autosaveDrafts !== false,
        testGroupDefault: number(settings.testGroupDefault, 2),
        updatedAt: Date.now(),
      }
      statements.push(this.db.prepare(
        `INSERT INTO tools_PromptOptimizer_settings
           (user_id, default_text_model_id, evaluation_model_id, image_recognition_model_id, image_model_id,
            builtin_template_language, template_selection, workspace_model_selection, history_retention_days,
            autosave_drafts, test_group_default, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           default_text_model_id = excluded.default_text_model_id,
           evaluation_model_id = excluded.evaluation_model_id,
           image_recognition_model_id = excluded.image_recognition_model_id,
           image_model_id = excluded.image_model_id,
           builtin_template_language = excluded.builtin_template_language,
           template_selection = excluded.template_selection,
           workspace_model_selection = excluded.workspace_model_selection,
           history_retention_days = excluded.history_retention_days,
           autosave_drafts = excluded.autosave_drafts,
           test_group_default = excluded.test_group_default,
           updated_at = excluded.updated_at`,
      ).bind(
        this.userId,
        next.defaultTextModelId,
        next.evaluationModelId,
        next.imageRecognitionModelId,
        next.imageModelId,
        next.builtinTemplateLanguage,
        JSON.stringify(next.templateSelection),
        JSON.stringify(next.workspaceModelSelection),
        next.historyRetentionDays,
        next.autosaveDrafts ? 1 : 0,
        next.testGroupDefault,
        next.updatedAt,
      ))
      counts.settings = 1
    }

    for (const row of rowsOf('records')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_records
             (id, user_id, chain_id, version, previous_id, record_type, workspace, original_prompt,
              optimized_prompt, reasoning, model_id, model_label, template_id, iteration_note, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.chain_id) || text(row.chainId) || newId(),
          number(row.version, 1),
          text(row.previous_id) || text(row.previousId) || null,
          text(row.record_type) || text(row.recordType, 'optimize'),
          text(row.workspace, 'basic_system'),
          text(row.original_prompt) || text(row.originalPrompt),
          text(row.optimized_prompt) || text(row.optimizedPrompt),
          text(row.reasoning),
          text(row.model_id) || text(row.modelId),
          text(row.model_label) || text(row.modelLabel),
          text(row.template_id) || text(row.templateId),
          text(row.iteration_note) || text(row.iterationNote),
          json(row.metadata, '{}'),
          number(row.created_at) || number(row.createdAt),
        ))
      counts.records = (counts.records ?? 0) + 1
    }

    for (const row of rowsOf('templates')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_templates
             (id, user_id, name, content, template_type, language, description, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.name, 'Template'),
          json(row.content, '""'),
          text(row.template_type) || 'optimize',
          text(row.language),
          text(row.description),
          text(row.version, '1.0.0'),
          number(row.created_at) || Date.now(),
          number(row.updated_at) || Date.now(),
        ))
      counts.templates = (counts.templates ?? 0) + 1
    }

    for (const row of rowsOf('categories')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_categories
             (id, user_id, name, description, parent_id, color, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.name, 'Category'),
          text(row.description),
          text(row.parent_id) || null,
          text(row.color),
          number(row.sort_order),
          number(row.created_at) || Date.now(),
        ))
      counts.categories = (counts.categories ?? 0) + 1
    }

    for (const row of rowsOf('favorites')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_favorites
             (id, user_id, title, content, description, function_mode, optimization_mode, image_sub_mode,
              category_id, use_count, metadata, examples, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.title, 'Favorite'),
          text(row.content),
          text(row.description),
          text(row.function_mode, 'basic'),
          text(row.optimization_mode),
          text(row.image_sub_mode),
          text(row.category_id) || null,
          number(row.use_count),
          json(row.metadata, '{}'),
          json(row.examples, '[]'),
          number(row.created_at) || Date.now(),
          number(row.updated_at) || Date.now(),
        ))
      counts.favorites = (counts.favorites ?? 0) + 1
    }

    for (const row of rowsOf('favoriteTags')) {
      statements.push(this.db
        .prepare(`INSERT OR REPLACE INTO tools_PromptOptimizer_favorite_tags (user_id, favorite_id, tag, created_at) VALUES (?, ?, ?, ?)`)
        .bind(this.userId, text(row.favorite_id), text(row.tag), number(row.created_at) || Date.now()))
      counts.favoriteTags = (counts.favoriteTags ?? 0) + 1
    }

    for (const row of rowsOf('favoriteVersions')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_favorite_versions
             (id, user_id, favorite_id, version, title, content, description, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.favorite_id),
          number(row.version, 1),
          text(row.title),
          text(row.content),
          text(row.description),
          json(row.metadata, '{}'),
          number(row.created_at) || Date.now(),
        ))
      counts.favoriteVersions = (counts.favoriteVersions ?? 0) + 1
    }

    for (const row of rowsOf('variables')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_variables (user_id, name, value, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          this.userId,
          text(row.name),
          text(row.value),
          text(row.description),
          number(row.created_at) || Date.now(),
          number(row.updated_at) || Date.now(),
        ))
      counts.variables = (counts.variables ?? 0) + 1
    }

    for (const row of rowsOf('contexts')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_contexts
             (id, user_id, title, mode, messages, variables, tools, tags, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.title, 'Context'),
          text(row.mode, 'system'),
          json(row.messages, '[]'),
          json(row.variables, '{}'),
          json(row.tools, '[]'),
          json(row.tags, '[]'),
          text(row.description),
          number(row.created_at) || Date.now(),
          number(row.updated_at) || Date.now(),
        ))
      counts.contexts = (counts.contexts ?? 0) + 1
    }

    for (const row of rowsOf('sessions')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_sessions (user_id, workspace, rev, state, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(this.userId, text(row.workspace), number(row.rev, 1), json(row.state, '{}'), number(row.updated_at) || Date.now()))
      counts.sessions = (counts.sessions ?? 0) + 1
    }

    for (const row of rowsOf('evaluations')) {
      statements.push(this.db
        .prepare(
          `INSERT OR REPLACE INTO tools_PromptOptimizer_evaluations
             (id, user_id, workspace, evaluation_type, score, verdict, payload, record_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          text(row.id) || newId(),
          this.userId,
          text(row.workspace),
          text(row.evaluation_type, 'result'),
          typeof row.score === 'number' ? row.score : null,
          text(row.verdict),
          json(row.payload, '{}'),
          text(row.record_id),
          number(row.created_at) || Date.now(),
        ))
      counts.evaluations = (counts.evaluations ?? 0) + 1
    }

    // One D1 batch is one transaction: a rejected row rolls the whole restore back instead of leaving
    // a half-imported account behind.
    if (statements.length) await this.db.batch(statements)
    return { imported: counts }
  }
}

export class SessionConflictError extends Error {
  constructor(readonly current: WorkspaceSession) {
    super('This workspace changed in another window')
    this.name = 'SessionConflictError'
  }
}
