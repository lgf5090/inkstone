/**
 * D1 database schema statements and required invariants for Color Assistant (`tools_color_*`).
 */

export const TOOLS_COLOR_SCHEMA_STATEMENTS: readonly string[] = [
  // 1. Color Settings
  `CREATE TABLE IF NOT EXISTS tools_color_settings (
    user_id TEXT NOT NULL,
    strip_hash INTEGER NOT NULL DEFAULT 0,
    default_format TEXT NOT NULL DEFAULT 'hex',
    default_ui_tab TEXT NOT NULL DEFAULT 'flat_ui',
    auto_save_history INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  // 2. Color Favorites (Single colors)
  `CREATE TABLE IF NOT EXISTS tools_color_favorites (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    hex TEXT NOT NULL,
    rgb_json TEXT NOT NULL,
    cmyk_json TEXT NOT NULL DEFAULT '',
    lab_json TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_color_favorites_user
     ON tools_color_favorites(user_id, sort ASC, created_at DESC)`,

  // 3. Multi-color Palettes (Color Hunt, MyColorSpace, AI, Custom sets)
  `CREATE TABLE IF NOT EXISTS tools_color_palettes (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    colors_json TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'custom',
    description TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    likes_count INTEGER NOT NULL DEFAULT 0,
    preview_svg TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_color_palettes_user
     ON tools_color_palettes(user_id, source_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_color_palettes_fav
     ON tools_color_palettes(user_id, is_favorite, sort ASC, created_at DESC)`,

  // 4. Color History
  `CREATE TABLE IF NOT EXISTS tools_color_history (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    hex TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'studio',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_color_history_user
     ON tools_color_history(user_id, created_at DESC)`,

  // 5. Assets (Posters, Cards, Gradient images, ASE files)
  `CREATE TABLE IF NOT EXISTS tools_color_assets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    file_format TEXT NOT NULL DEFAULT 'png',
    file_size INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_color_assets_user
     ON tools_color_assets(user_id, asset_type, created_at DESC)`,
]

export const TOOLS_COLOR_REQUIRED_TABLES: readonly string[] = [
  'tools_color_settings',
  'tools_color_favorites',
  'tools_color_palettes',
  'tools_color_history',
  'tools_color_assets',
]

export const TOOLS_COLOR_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_color_favorites_user',
  'idx_tools_color_palettes_user',
  'idx_tools_color_palettes_fav',
  'idx_tools_color_history_user',
  'idx_tools_color_assets_user',
]

export const TOOLS_COLOR_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_color_settings: [
    'user_id',
    'strip_hash',
    'default_format',
    'default_ui_tab',
    'auto_save_history',
    'updated_at',
  ],
  tools_color_favorites: [
    'user_id',
    'id',
    'name',
    'hex',
    'rgb_json',
    'cmyk_json',
    'lab_json',
    'tags_json',
    'note',
    'sort',
    'created_at',
    'updated_at',
  ],
  tools_color_palettes: [
    'user_id',
    'id',
    'title',
    'colors_json',
    'source_type',
    'description',
    'tags_json',
    'likes_count',
    'preview_svg',
    'is_favorite',
    'sort',
    'created_at',
    'updated_at',
  ],
  tools_color_history: [
    'user_id',
    'id',
    'hex',
    'source',
    'created_at',
  ],
  tools_color_assets: [
    'user_id',
    'id',
    'asset_type',
    'file_format',
    'file_size',
    'r2_key',
    'metadata_json',
    'created_at',
  ],
}
