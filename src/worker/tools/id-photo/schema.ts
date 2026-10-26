export const TOOLS_ID_PHOTO_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_id_photo_records (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    spec_id TEXT NOT NULL DEFAULT 'custom',
    spec_name TEXT NOT NULL DEFAULT '',
    width_px INTEGER NOT NULL,
    height_px INTEGER NOT NULL,
    width_mm REAL NOT NULL DEFAULT 0,
    height_mm REAL NOT NULL DEFAULT 0,
    dpi INTEGER NOT NULL DEFAULT 300,
    bg_color TEXT NOT NULL DEFAULT '#ffffff',
    options_json TEXT NOT NULL DEFAULT '{}',
    r2_key TEXT NOT NULL DEFAULT '',
    print_r2_key TEXT NOT NULL DEFAULT '',
    file_type TEXT NOT NULL DEFAULT 'jpg',
    file_size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_id_photo_records_user
     ON tools_id_photo_records(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_id_photo_records_spec
     ON tools_id_photo_records(user_id, spec_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_id_photo_specs (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'custom',
    country_code TEXT NOT NULL DEFAULT '',
    width_mm REAL NOT NULL,
    height_mm REAL NOT NULL,
    width_px INTEGER NOT NULL,
    height_px INTEGER NOT NULL,
    dpi INTEGER NOT NULL DEFAULT 300,
    bg_colors_json TEXT NOT NULL DEFAULT '["#ffffff"]',
    face_ratio_min REAL NOT NULL DEFAULT 0.6,
    face_ratio_max REAL NOT NULL DEFAULT 0.8,
    file_size_max_kb INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_id_photo_specs_user
     ON tools_id_photo_specs(user_id, category, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_id_photo_settings (
    user_id TEXT NOT NULL,
    default_spec_id TEXT NOT NULL DEFAULT 'cn_one_inch',
    default_bg_color TEXT NOT NULL DEFAULT '#ffffff',
    default_dpi INTEGER NOT NULL DEFAULT 300,
    default_export_format TEXT NOT NULL DEFAULT 'jpg',
    auto_save_history INTEGER NOT NULL DEFAULT 1,
    auto_face_align INTEGER NOT NULL DEFAULT 1,
    print_paper_size TEXT NOT NULL DEFAULT '6inch',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,
]

export const TOOLS_ID_PHOTO_REQUIRED_TABLES: readonly string[] = [
  'tools_id_photo_records',
  'tools_id_photo_specs',
  'tools_id_photo_settings',
]

export const TOOLS_ID_PHOTO_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_id_photo_records_user',
  'idx_tools_id_photo_records_spec',
  'idx_tools_id_photo_specs_user',
]

export const TOOLS_ID_PHOTO_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_id_photo_records: [
    'user_id',
    'id',
    'title',
    'spec_id',
    'spec_name',
    'width_px',
    'height_px',
    'width_mm',
    'height_mm',
    'dpi',
    'bg_color',
    'options_json',
    'r2_key',
    'print_r2_key',
    'file_type',
    'file_size',
    'created_at',
    'updated_at',
  ],
  tools_id_photo_specs: [
    'user_id',
    'id',
    'name',
    'category',
    'country_code',
    'width_mm',
    'height_mm',
    'width_px',
    'height_px',
    'dpi',
    'bg_colors_json',
    'face_ratio_min',
    'face_ratio_max',
    'file_size_max_kb',
    'is_favorite',
    'created_at',
    'updated_at',
  ],
  tools_id_photo_settings: [
    'user_id',
    'default_spec_id',
    'default_bg_color',
    'default_dpi',
    'default_export_format',
    'auto_save_history',
    'auto_face_align',
    'print_paper_size',
    'updated_at',
  ],
}
