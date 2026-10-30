import { z } from 'zod'
import { DATABASE_ID_RE } from './schemas'
import { MAX_SQL_LENGTH } from './types'

const connectionId = z.string().regex(DATABASE_ID_RE).describe('Connection id from list_connections')
const table = z.string().trim().min(1).max(200).describe('Table or view name')
const params = z.array(z.unknown()).max(1_000).describe('Optional positional values for ? placeholders')

export interface DatabaseToolDef {
  name: string
  description: string
  schema: z.ZodType
  write?: boolean
}

export const DATABASE_TOOL_DEFS: readonly DatabaseToolDef[] = [
  {
    name: 'list_connections',
    description: 'List the saved database connections. Other tools need a connectionId.',
    schema: z.object({}),
  },
  {
    name: 'list_tables',
    description: 'List tables, views and triggers in one connection.',
    schema: z.object({ connectionId }),
  },
  {
    name: 'search_tables',
    description: 'Search table, view and trigger names by keyword.',
    schema: z.object({ connectionId, keyword: z.string().trim().min(1).max(200) }),
  },
  {
    name: 'get_table_schema',
    description: 'Read a table schema: columns, indexes and foreign keys.',
    schema: z.object({ connectionId, table }),
  },
  {
    name: 'get_table_ddl',
    description: 'Read the original CREATE statement for a table, view or trigger.',
    schema: z.object({ connectionId, table }),
  },
  {
    name: 'list_indexes',
    description: 'List indexes in a connection, optionally for one table.',
    schema: z.object({ connectionId, table: table.optional() }),
  },
  {
    name: 'get_table_foreign_keys',
    description: 'Read the foreign keys declared by a table.',
    schema: z.object({ connectionId, table }),
  },
  {
    name: 'preview_table',
    description: 'Preview rows from a table. Default 50 rows, maximum 200.',
    schema: z.object({ connectionId, table, limit: z.number().int().min(1).max(200).optional() }),
  },
  {
    name: 'get_table_row_count',
    description: 'Count the rows in a table.',
    schema: z.object({ connectionId, table }),
  },
  {
    name: 'run_query',
    description:
      'Run one SQL statement. Reading does not need confirmation. INSERT, UPDATE, DELETE, DDL and PRAGMA require confirm: true after the user explicitly agrees. Destructive statements (DROP, TRUNCATE, or DELETE/UPDATE without WHERE) are refused; ask the reader to run those from the query editor. Results are capped at 200 rows.',
    schema: z.object({
      connectionId,
      sql: z.string().min(1).max(MAX_SQL_LENGTH),
      params: params.optional(),
      confirm: z.boolean().optional(),
    }),
    write: true,
  },
  {
    name: 'explain_query',
    description: 'Run EXPLAIN QUERY PLAN for one SQL statement.',
    schema: z.object({ connectionId, sql: z.string().min(1).max(MAX_SQL_LENGTH) }),
  },
]

export function databaseToolDef(name: string): DatabaseToolDef | undefined {
  return DATABASE_TOOL_DEFS.find((tool) => tool.name === name)
}
