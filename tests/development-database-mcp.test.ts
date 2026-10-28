// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { mcpServerToolCatalog } from '../src/worker/mcp/server'
import { grantedMcpScopes, MCP_SCOPES } from '../src/worker/mcp/settings'

const databaseTools = [
  'list_connections',
  'list_tables',
  'search_tables',
  'get_table_schema',
  'get_table_ddl',
  'list_indexes',
  'get_table_foreign_keys',
  'preview_table',
  'get_table_row_count',
  'run_query',
  'explain_query',
]

describe('database MCP integration', () => {
  it('publishes the database tools in the shared catalog', () => {
    const catalog = mcpServerToolCatalog({ env: {} as Env, origin: 'https://example.test', ftsEnabled: false })
    const names = new Set(catalog.map((tool) => tool.name))
    for (const name of databaseTools) expect(names.has(name), name).toBe(true)
  })

  it('grants database reads by request and writes only when account writes are on', () => {
    const base = {
      writeEnabled: false,
      trashEnabled: false,
      todoReadEnabled: true,
      emailEnabled: false,
      disabledTools: [],
      updatedAt: 0,
    }
    expect(grantedMcpScopes([MCP_SCOPES.databaseRead], base)).toContain(MCP_SCOPES.databaseRead)
    expect(grantedMcpScopes([MCP_SCOPES.databaseWrite], base)).not.toContain(MCP_SCOPES.databaseWrite)
    expect(grantedMcpScopes([MCP_SCOPES.databaseWrite], { ...base, writeEnabled: true })).toContain(MCP_SCOPES.databaseWrite)
  })
})
