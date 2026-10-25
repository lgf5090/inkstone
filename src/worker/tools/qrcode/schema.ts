/**
 * D1 schema statements and invariants for the QR Code tool (`tools_qrcode_t_*`).
 */

export const TOOLS_QRCODE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_qrcode_t_records (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'text',
    content_raw TEXT NOT NULL,
    options_json TEXT NOT NULL,
    r2_key TEXT NOT NULL DEFAULT '',
    file_type TEXT NOT NULL DEFAULT 'png',
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 1000,
    height INTEGER NOT NULL DEFAULT 1000,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_qrcode_t_records_user
     ON tools_qrcode_t_records(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_qrcode_t_records_type
     ON tools_qrcode_t_records(user_id, content_type, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_qrcode_t_templates (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'minimal',
    preview_svg TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_qrcode_t_templates_cat
     ON tools_qrcode_t_templates(user_id, category, sort ASC)`,

  `CREATE TABLE IF NOT EXISTS tools_qrcode_t_settings (
    user_id TEXT NOT NULL,
    default_error_correction TEXT NOT NULL DEFAULT 'Q',
    default_size INTEGER NOT NULL DEFAULT 1000,
    default_format TEXT NOT NULL DEFAULT 'png',
    auto_save_history INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,
]

export const TOOLS_QRCODE_REQUIRED_TABLES: readonly string[] = [
  'tools_qrcode_t_records',
  'tools_qrcode_t_templates',
  'tools_qrcode_t_settings',
]

export const TOOLS_QRCODE_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_qrcode_t_records_user',
  'idx_tools_qrcode_t_records_type',
  'idx_tools_qrcode_t_templates_cat',
]

export const TOOLS_QRCODE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_qrcode_t_records: [
    'user_id',
    'id',
    'title',
    'content_type',
    'content_raw',
    'options_json',
    'r2_key',
    'file_type',
    'file_size',
    'width',
    'height',
    'created_at',
    'updated_at',
  ],
  tools_qrcode_t_templates: [
    'user_id',
    'id',
    'name',
    'category',
    'preview_svg',
    'options_json',
    'is_builtin',
    'sort',
    'created_at',
    'updated_at',
  ],
  tools_qrcode_t_settings: [
    'user_id',
    'default_error_correction',
    'default_size',
    'default_format',
    'auto_save_history',
    'updated_at',
  ],
}
