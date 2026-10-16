import { getMeta, setMeta } from '../db/metadata'

export const MCP_SCOPES = {
  read: 'notes:read',
  write: 'notes:write',
  trash: 'notes:trash',
} as const

export const MCP_SUPPORTED_SCOPES = Object.values(MCP_SCOPES)

const MCP_ENABLED_KEY = 'mcp-enabled-v1'

export interface McpPreferences {
  writeEnabled: boolean
  trashEnabled: boolean
  /**
   * The server's own tools the reader has switched off, by the name the server registers them under.
   *
   * Kept as the switched-off set rather than the enabled one so that a tool a later build adds arrives
   * usable: a reader who has switched two tools off has not thereby switched off the fortieth.
   */
  disabledTools: string[]
  updatedAt: number
}

interface McpPreferencesRow {
  write_enabled: number
  trash_enabled: number
  disabled_tools: string
  updated_at: number
}

/** A ceiling on the exception list, so a row cannot grow past what one settings screen can draw. */
export const MAX_MCP_DISABLED_TOOLS = 200
const MAX_MCP_TOOL_NAME_CHARS = 64

/**
 * The switched-off list as it is stored, decoded rather than trusted.
 *
 * The column is written by this app and read by this app, but a restore from a backup and a boot onto a
 * database another branch spent are both in this program's future, so an unusable value reads as "nothing
 * switched off" rather than as a settings screen that cannot open.
 */
export function parseDisabledMcpTools(value: string | null | undefined): string[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().slice(0, MAX_MCP_TOOL_NAME_CHARS)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= MAX_MCP_DISABLED_TOOLS) break
  }
  return names
}

export async function isMcpEnabled(db: D1Database): Promise<boolean> {
  const stored = await getMeta(db, MCP_ENABLED_KEY)
  return stored !== '0'
}

export async function setMcpEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setMeta(db, MCP_ENABLED_KEY, enabled ? '1' : '0')
  enabledMemo.delete(db)
}

const enabledMemo = new WeakMap<D1Database, { value: Promise<boolean>; expiresAt: number }>()
const MCP_ENABLED_MEMO_MS = 5_000

/**
 * Every MCP HTTP request needs the switch, and the endpoint is hit once per tool call, so the
 * single-key read is memoized per isolate. Flipping the switch in this isolate drops the entry
 * immediately; another isolate converges within the window.
 */
export function isMcpEnabledOnce(db: D1Database): Promise<boolean> {
  const now = Date.now()
  const cached = enabledMemo.get(db)
  if (cached && cached.expiresAt > now) return cached.value
  const value = isMcpEnabled(db).catch((error) => {
    enabledMemo.delete(db)
    throw error
  })
  enabledMemo.set(db, { value, expiresAt: now + MCP_ENABLED_MEMO_MS })
  return value
}

export async function getMcpPreferences(db: D1Database, userId: string): Promise<McpPreferences> {
  const row = await db.prepare(
    `SELECT write_enabled, trash_enabled, disabled_tools, updated_at
       FROM mcp_preferences WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<McpPreferencesRow>()
  return row ? toPreferences(row) : defaultMcpPreferences()
}

const preferencesMemo = new WeakMap<D1Database, Map<string, { value: Promise<McpPreferences>; expiresAt: number }>>()
const PREFERENCES_MEMO_MS = 5_000

/**
 * The same read, memoized per isolate for a few seconds.
 *
 * Every MCP request needs these — to decide which tools to publish, and again to gate each write — and the
 * endpoint is hit once per tool call. Flipping a switch in this isolate drops nothing immediately, so the
 * window is short; another isolate converges within it too.
 */
export function getMcpPreferencesCached(db: D1Database, userId: string): Promise<McpPreferences> {
  let byUser = preferencesMemo.get(db)
  if (!byUser) {
    byUser = new Map()
    preferencesMemo.set(db, byUser)
  }
  const now = Date.now()
  const entry = byUser.get(userId)
  if (entry && entry.expiresAt > now) return entry.value
  const value = getMcpPreferences(db, userId)
  byUser.set(userId, { value, expiresAt: now + PREFERENCES_MEMO_MS })
  return value
}

export async function updateMcpPreferences(
  db: D1Database,
  userId: string,
  patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled' | 'disabledTools'>>,
): Promise<McpPreferences> {
  const current = await getMcpPreferences(db, userId)
  const next = { ...current, ...patch, updatedAt: Date.now() }
  await putMcpPreferences(db, userId, next)
  return next
}

export async function putMcpPreferences(
  db: D1Database,
  userId: string,
  value: McpPreferences,
): Promise<void> {
  await db.prepare(
    `INSERT INTO mcp_preferences (
       user_id, write_enabled, trash_enabled, disabled_tools, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id) DO UPDATE SET
       write_enabled = excluded.write_enabled,
       trash_enabled = excluded.trash_enabled,
       disabled_tools = excluded.disabled_tools,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    value.writeEnabled ? 1 : 0,
    value.trashEnabled ? 1 : 0,
    JSON.stringify(value.disabledTools),
    value.updatedAt,
  ).run()
}

export function grantedMcpScopes(
  requested: readonly string[],
  preferences: McpPreferences,
): string[] {
  const requestedSet = new Set(requested.length ? requested : [MCP_SCOPES.read])
  const granted: string[] = [MCP_SCOPES.read]
  if (preferences.writeEnabled && requestedSet.has(MCP_SCOPES.write)) granted.push(MCP_SCOPES.write)
  if (preferences.trashEnabled && requestedSet.has(MCP_SCOPES.trash)) granted.push(MCP_SCOPES.trash)
  return granted.filter((scope) => requestedSet.has(scope) || scope === MCP_SCOPES.read)
}

function defaultMcpPreferences(): McpPreferences {
  return {
    writeEnabled: false,
    trashEnabled: false,
    disabledTools: [],
    updatedAt: 0,
  }
}

function toPreferences(row: McpPreferencesRow): McpPreferences {
  return {
    writeEnabled: row.write_enabled === 1,
    trashEnabled: row.trash_enabled === 1,
    disabledTools: parseDisabledMcpTools(row.disabled_tools),
    updatedAt: row.updated_at,
  }
}
