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
  updatedAt: number
}

interface McpPreferencesRow {
  write_enabled: number
  trash_enabled: number
  updated_at: number
}

export async function isMcpEnabled(db: D1Database): Promise<boolean> {
  const stored = await getMeta(db, MCP_ENABLED_KEY)
  return stored !== '0'
}

export async function setMcpEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setMeta(db, MCP_ENABLED_KEY, enabled ? '1' : '0')
}

export async function getMcpPreferences(db: D1Database, userId: string): Promise<McpPreferences> {
  const row = await db.prepare(
    `SELECT write_enabled, trash_enabled, updated_at
       FROM mcp_preferences WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<McpPreferencesRow>()
  return row ? toPreferences(row) : defaultMcpPreferences()
}

export async function updateMcpPreferences(
  db: D1Database,
  userId: string,
  patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled'>>,
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
       user_id, write_enabled, trash_enabled, updated_at
     ) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       write_enabled = excluded.write_enabled,
       trash_enabled = excluded.trash_enabled,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    value.writeEnabled ? 1 : 0,
    value.trashEnabled ? 1 : 0,
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
    updatedAt: 0,
  }
}

function toPreferences(row: McpPreferencesRow): McpPreferences {
  return {
    writeEnabled: row.write_enabled === 1,
    trashEnabled: row.trash_enabled === 1,
    updatedAt: row.updated_at,
  }
}
