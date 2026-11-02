export const CALCULATOR_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS calculator_settings (
    user_id TEXT NOT NULL,
    default_view TEXT NOT NULL DEFAULT 'standard',
    angle_mode TEXT NOT NULL DEFAULT 'deg',
    graph_theme TEXT NOT NULL DEFAULT 'match_app',
    graph_line_width INTEGER NOT NULL DEFAULT 2,
    graph_x_min REAL NOT NULL DEFAULT -10,
    graph_x_max REAL NOT NULL DEFAULT 10,
    graph_y_min REAL NOT NULL DEFAULT -10,
    graph_y_max REAL NOT NULL DEFAULT 10,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS calculator_history (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    mode TEXT NOT NULL,
    expression TEXT NOT NULL,
    result TEXT NOT NULL,
    tokens_json TEXT NOT NULL DEFAULT '[]',
    commands_json TEXT NOT NULL DEFAULT '[]',
    radix INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calculator_history_user_mode
     ON calculator_history(user_id, mode, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS calculator_memory (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    value_json TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calculator_memory_user
     ON calculator_memory(user_id, sort ASC, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS calculator_graph_sessions (
    user_id TEXT NOT NULL,
    equations_json TEXT NOT NULL DEFAULT '[]',
    variables_json TEXT NOT NULL DEFAULT '[]',
    viewport_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS calculator_unit_preferences (
    user_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    from_unit_id INTEGER NOT NULL,
    to_unit_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, category_id)
  )`,

  `CREATE TABLE IF NOT EXISTS calculator_currency_rates (
    base TEXT NOT NULL,
    rates_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (base)
  )`,

  `CREATE TABLE IF NOT EXISTS calculator_assets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_format TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calculator_assets_user
     ON calculator_assets(user_id, kind, created_at DESC)`,
]

export const CALCULATOR_REQUIRED_TABLES: readonly string[] = [
  'calculator_settings',
  'calculator_history',
  'calculator_memory',
  'calculator_graph_sessions',
  'calculator_unit_preferences',
  'calculator_currency_rates',
  'calculator_assets',
]

export const CALCULATOR_REQUIRED_INDEXES: readonly string[] = [
  'idx_calculator_history_user_mode',
  'idx_calculator_memory_user',
  'idx_calculator_assets_user',
]

export const CALCULATOR_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  calculator_settings: [
    'user_id',
    'default_view',
    'angle_mode',
    'graph_theme',
    'graph_line_width',
    'graph_x_min',
    'graph_x_max',
    'graph_y_min',
    'graph_y_max',
    'updated_at',
  ],
  calculator_history: [
    'user_id',
    'id',
    'mode',
    'expression',
    'result',
    'tokens_json',
    'commands_json',
    'radix',
    'created_at',
  ],
  calculator_memory: ['user_id', 'id', 'value_json', 'sort', 'created_at'],
  calculator_graph_sessions: ['user_id', 'equations_json', 'variables_json', 'viewport_json', 'updated_at'],
  calculator_unit_preferences: ['user_id', 'category_id', 'from_unit_id', 'to_unit_id', 'updated_at'],
  calculator_currency_rates: ['base', 'rates_json', 'fetched_at'],
  calculator_assets: [
    'user_id',
    'id',
    'kind',
    'file_format',
    'mime_type',
    'file_size',
    'r2_key',
    'metadata_json',
    'created_at',
  ],
}
