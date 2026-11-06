/**
 * D1 statements and invariants for the Prompt Optimizer (`tools_PromptOptimizer_*`).
 *
 * Every table carries `user_id` and every query in the store binds it. Rows that a reader edits are
 * keyed by `(user_id, id)`, so an id from another account can never address this account's row.
 */

export const TOOLS_PROMPT_OPTIMIZER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_settings (
    user_id TEXT PRIMARY KEY,
    default_text_model_id TEXT NOT NULL DEFAULT '',
    evaluation_model_id TEXT NOT NULL DEFAULT '',
    image_recognition_model_id TEXT NOT NULL DEFAULT '',
    image_model_id TEXT NOT NULL DEFAULT '',
    builtin_template_language TEXT NOT NULL DEFAULT 'zh',
    basic_sub_mode TEXT NOT NULL DEFAULT 'system',
    pro_sub_mode TEXT NOT NULL DEFAULT 'multi',
    image_sub_mode TEXT NOT NULL DEFAULT 'text2image',
    template_selection TEXT NOT NULL DEFAULT '{}',
    workspace_model_selection TEXT NOT NULL DEFAULT '{}',
    history_retention_days INTEGER NOT NULL DEFAULT 0,
    autosave_drafts INTEGER NOT NULL DEFAULT 1,
    test_group_default INTEGER NOT NULL DEFAULT 2,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_records (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    previous_id TEXT,
    record_type TEXT NOT NULL,
    workspace TEXT NOT NULL,
    original_prompt TEXT NOT NULL DEFAULT '',
    optimized_prompt TEXT NOT NULL DEFAULT '',
    reasoning TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    model_label TEXT NOT NULL DEFAULT '',
    template_id TEXT NOT NULL DEFAULT '',
    iteration_note TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_records_chain
     ON tools_PromptOptimizer_records(user_id, chain_id, version)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_records_time
     ON tools_PromptOptimizer_records(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_templates (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    template_type TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '1.0.0',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_templates_type
     ON tools_PromptOptimizer_templates(user_id, template_type, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_categories (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    color TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_categories_user
     ON tools_PromptOptimizer_categories(user_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_favorites (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    function_mode TEXT NOT NULL DEFAULT 'basic',
    optimization_mode TEXT NOT NULL DEFAULT '',
    image_sub_mode TEXT NOT NULL DEFAULT '',
    category_id TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    examples TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_favorites_user
     ON tools_PromptOptimizer_favorites(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_favorites_category
     ON tools_PromptOptimizer_favorites(user_id, category_id)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_favorite_tags (
    user_id TEXT NOT NULL,
    favorite_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, favorite_id, tag)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_favorite_tags_tag
     ON tools_PromptOptimizer_favorite_tags(user_id, tag)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_favorite_versions (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    favorite_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_favorite_versions
     ON tools_PromptOptimizer_favorite_versions(user_id, favorite_id, version)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_variables (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_contexts (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'system',
    messages TEXT NOT NULL DEFAULT '[]',
    variables TEXT NOT NULL DEFAULT '{}',
    tools TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_contexts_user
     ON tools_PromptOptimizer_contexts(user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_sessions (
    user_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, workspace)
  )`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_arena (
    user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_assets (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image',
    source TEXT NOT NULL DEFAULT 'upload',
    r2_key TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    prompt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_assets_user
     ON tools_PromptOptimizer_assets(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_evaluations (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    evaluation_type TEXT NOT NULL,
    score REAL,
    verdict TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    record_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_evaluations_user
     ON tools_PromptOptimizer_evaluations(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_PromptOptimizer_backups (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_PromptOptimizer_backups_user
     ON tools_PromptOptimizer_backups(user_id, created_at DESC)`,
]

export const TOOLS_PROMPT_OPTIMIZER_REQUIRED_TABLES: readonly string[] = [
  'tools_PromptOptimizer_settings',
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
  'tools_PromptOptimizer_assets',
  'tools_PromptOptimizer_evaluations',
  'tools_PromptOptimizer_backups',
]

export const TOOLS_PROMPT_OPTIMIZER_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_PromptOptimizer_records_chain',
  'idx_tools_PromptOptimizer_records_time',
  'idx_tools_PromptOptimizer_templates_type',
  'idx_tools_PromptOptimizer_categories_user',
  'idx_tools_PromptOptimizer_favorites_user',
  'idx_tools_PromptOptimizer_favorites_category',
  'idx_tools_PromptOptimizer_favorite_tags_tag',
  'idx_tools_PromptOptimizer_favorite_versions',
  'idx_tools_PromptOptimizer_contexts_user',
  'idx_tools_PromptOptimizer_assets_user',
  'idx_tools_PromptOptimizer_evaluations_user',
  'idx_tools_PromptOptimizer_backups_user',
]

export const TOOLS_PROMPT_OPTIMIZER_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_PromptOptimizer_settings: [
    'user_id',
    'default_text_model_id',
    'evaluation_model_id',
    'image_recognition_model_id',
    'image_model_id',
    'builtin_template_language',
    'basic_sub_mode',
    'pro_sub_mode',
    'image_sub_mode',
    'template_selection',
    'workspace_model_selection',
    'history_retention_days',
    'autosave_drafts',
    'test_group_default',
    'updated_at',
  ],
  tools_PromptOptimizer_records: [
    'id',
    'user_id',
    'chain_id',
    'version',
    'previous_id',
    'record_type',
    'workspace',
    'original_prompt',
    'optimized_prompt',
    'reasoning',
    'model_id',
    'model_label',
    'template_id',
    'iteration_note',
    'metadata',
    'created_at',
  ],
  tools_PromptOptimizer_templates: [
    'id',
    'user_id',
    'name',
    'content',
    'template_type',
    'language',
    'description',
    'version',
    'created_at',
    'updated_at',
  ],
  tools_PromptOptimizer_categories: ['id', 'user_id', 'name', 'description', 'parent_id', 'color', 'sort_order', 'created_at'],
  tools_PromptOptimizer_favorites: [
    'id',
    'user_id',
    'title',
    'content',
    'description',
    'function_mode',
    'optimization_mode',
    'image_sub_mode',
    'category_id',
    'use_count',
    'metadata',
    'examples',
    'created_at',
    'updated_at',
  ],
  tools_PromptOptimizer_favorite_tags: ['user_id', 'favorite_id', 'tag', 'created_at'],
  tools_PromptOptimizer_favorite_versions: ['id', 'user_id', 'favorite_id', 'version', 'title', 'content', 'description', 'metadata', 'created_at'],
  tools_PromptOptimizer_variables: ['user_id', 'name', 'value', 'description', 'created_at', 'updated_at'],
  tools_PromptOptimizer_contexts: ['id', 'user_id', 'title', 'mode', 'messages', 'variables', 'tools', 'tags', 'description', 'created_at', 'updated_at'],
  tools_PromptOptimizer_sessions: ['user_id', 'workspace', 'rev', 'state', 'updated_at'],
  tools_PromptOptimizer_arena: ['user_id', 'state', 'updated_at'],
  tools_PromptOptimizer_assets: ['id', 'user_id', 'kind', 'source', 'r2_key', 'mime', 'bytes', 'width', 'height', 'prompt', 'created_at'],
  tools_PromptOptimizer_evaluations: ['id', 'user_id', 'workspace', 'evaluation_type', 'score', 'verdict', 'payload', 'record_id', 'created_at'],
  tools_PromptOptimizer_backups: ['id', 'user_id', 'filename', 'r2_key', 'bytes', 'kind', 'created_at'],
}
