import { describe, expect, it } from 'vitest'
import type { ParsedColumn, ParsedTable, SchemaModel } from '../src/shared/development/database/types'
import {
  schemaToMarkdown,
  schemaToMermaid,
  type DocumentLabels,
} from '../src/client/features/development/database/export-doc'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'

const LABELS: DocumentLabels = {
  summary: 'Summary',
  databaseType: 'Database type',
  tableStructure: 'Table structure',
  relationships: 'Relationships',
  views: 'Views',
  indexes: 'Indexes',
  uniqueConstraints: 'Unique constraints',
  name: 'Name',
  type: 'Type',
  settings: 'Settings',
  references: 'References',
  note: 'Note',
  primaryKey: 'PK',
  notNull: 'not null',
  nullable: 'nullable',
  unique: 'unique',
  autoincrement: 'autoincrement',
  defaultLabel: 'default',
  diagram: 'Database Diagram',
  noTables: 'No tables in this schema.',
  viewDefinition: 'Definition',
}

function table(sql: string): ParsedTable {
  const parsed = parseCreateTable(sql)
  if (!parsed) throw new Error(`could not parse ${sql}`)
  return parsed
}

const USERS = table(
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT uq_users_tenant UNIQUE (id, tenant_id)
  )`,
)
const ORDERS = table(
  `CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    tenant_id INTEGER NOT NULL,
    code TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    CONSTRAINT uq_orders_user UNIQUE (user_id, tenant_id),
    CONSTRAINT fk_orders_user_tenant FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id)
  )`,
)

function schema(): SchemaModel {
  return {
    tables: [USERS, ORDERS],
    views: [
      {
        name: 'order_totals',
        sql: 'CREATE VIEW order_totals AS\nSELECT user_id, COUNT(*) AS total\nFROM orders\nGROUP BY user_id',
      },
    ],
    triggers: [],
    indexes: [
      {
        name: 'idx_orders_user',
        unique: false,
        columns: ['user_id'],
        origin: 'c',
        sql: 'CREATE INDEX idx_orders_user ON orders (user_id)',
        table: 'orders',
      },
      {
        name: 'idx_users_email',
        unique: true,
        columns: ['email'],
        origin: 'c',
        sql: 'CREATE UNIQUE INDEX idx_users_email ON users (email)',
        table: 'users',
      },
    ],
  }
}

function column(name: string, type = 'TEXT'): ParsedColumn {
  return {
    name,
    type,
    notNull: false,
    pk: false,
    pkPosition: 0,
    default: null,
    unique: false,
    autoIncrement: false,
  }
}

function oddSchema(): SchemaModel {
  return {
    tables: [
      {
        name: 'pipe|table',
        sql: '',
        columns: [column('a|b'), column('tick`name'), column('typeless', '')],
        tableConstraints: [],
        withoutRowid: false,
        strict: false,
      },
    ],
    views: [],
    triggers: [],
    indexes: [],
  }
}

const EMPTY: SchemaModel = { tables: [], views: [], triggers: [], indexes: [] }

describe('schemaToMermaid', () => {
  it('renders one entity block per table with its column types', () => {
    const mermaid = schemaToMermaid(schema())
    expect(mermaid.startsWith('erDiagram\n')).toBe(true)
    expect(mermaid).toContain('\tusers {\n\t\tINTEGER id\n\t\tINTEGER tenant_id\n\t\tTEXT email\n\t}')
    expect(mermaid).toContain('\torders {')
    expect(mermaid).toContain('\t\tTEXT code')
  })

  it('renders foreign keys with 1:1 and N:1 cardinality and local column labels', () => {
    const mermaid = schemaToMermaid(schema())
    expect(mermaid).toContain('orders }o--|| users : user_id')
    expect(mermaid).toContain('orders ||--|| users : "user_id, tenant_id"')
  })

  it('replaces characters that would break the diagram syntax and defaults empty types', () => {
    const mermaid = schemaToMermaid(oddSchema())
    expect(mermaid).toContain('\tpipe_table {\n\t\tTEXT a_b\n\t\tTEXT tick_name\n\t\tTEXT typeless\n\t}')
  })

  it('returns a bare diagram for an empty schema', () => {
    expect(schemaToMermaid(EMPTY)).toBe('erDiagram\n')
  })
})

describe('schemaToMarkdown', () => {
  it('writes the title, summary and database type', () => {
    const markdown = schemaToMarkdown(schema(), LABELS)
    expect(markdown.startsWith('# Schema documentation')).toBe(true)
    expect(markdown).toContain('## Summary')
    expect(markdown).toContain('- [Database type](#database-type)')
    expect(markdown).toContain('- [Table structure](#table-structure)')
    expect(markdown).toContain('  - [`users`](#users)')
    expect(markdown).toContain('- [Relationships](#relationships)')
    expect(markdown).toContain('- [Views](#views)')
    expect(markdown).toContain('- [Database Diagram](#database-diagram)')
    expect(markdown).toContain('## Database type\n\n- SQLite')
  })

  it('uses the provided title', () => {
    const markdown = schemaToMarkdown(schema(), LABELS, { title: 'Shop' })
    expect(markdown.startsWith('# Shop documentation')).toBe(true)
  })

  it('renders a column table with settings and foreign key references', () => {
    const markdown = schemaToMarkdown(schema(), LABELS)
    expect(markdown).toContain('### `users`')
    expect(markdown).toContain('### `orders`')
    expect(markdown).toContain('| Name | Type | Settings | References | Note |')
    expect(markdown).toContain('| `id` | INTEGER | PK, autoincrement |')
    expect(markdown).toContain('| `email` | TEXT | not null, unique |')
    expect(markdown).toContain("| `status` | TEXT | not null, default: 'new' |")
    expect(markdown).toContain('fk_orders_user_tenant')
    expect(markdown).toContain('orders.user_id → users.id')
  })

  it('renders index and unique constraint tables', () => {
    const markdown = schemaToMarkdown(schema(), LABELS)
    expect(markdown).toContain('#### Indexes')
    expect(markdown).toContain('| `idx_orders_user` |  | `user_id` |')
    expect(markdown).toContain('| `idx_users_email` | ✓ | `email` |')
    expect(markdown).toContain('#### Unique constraints')
    expect(markdown).toContain('| `uq_orders_user` | `user_id`, `tenant_id` |')
    expect(markdown).toContain('| `uq_users_email` | `email` |')
  })

  it('lists relationships and views, and ends with the Mermaid diagram', () => {
    const markdown = schemaToMarkdown(schema(), LABELS)
    expect(markdown).toContain('## Relationships')
    expect(markdown).toContain('`fk_orders_user_tenant`, 1:1')
    expect(markdown).toContain('(N:1)')
    expect(markdown).toContain('## Views')
    expect(markdown).toContain('### `order_totals`')
    expect(markdown).toContain('#### Definition')
    expect(markdown).toContain('```sql\nCREATE VIEW order_totals')
    expect(markdown).toContain('## Database Diagram\n\n```mermaid\nerDiagram')
    expect(markdown.lastIndexOf('```mermaid')).toBeGreaterThan(markdown.lastIndexOf('```sql'))
    expect(markdown.endsWith('```')).toBe(true)
  })

  it('escapes pipes in table cells and backticks in identifiers', () => {
    const markdown = schemaToMarkdown(oddSchema(), LABELS)
    expect(markdown).toContain('### `pipe|table`')
    expect(markdown).toContain('| `a\\|b` | TEXT |')
    expect(markdown).toContain('| ``tick`name`` | TEXT |')
  })

  it('reports an empty schema without crashing', () => {
    const markdown = schemaToMarkdown(EMPTY, LABELS)
    expect(markdown).toBe('# Schema documentation\n\nNo tables in this schema.')
  })
})