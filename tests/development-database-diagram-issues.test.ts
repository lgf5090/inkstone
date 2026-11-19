import { describe, expect, it } from 'vitest'
import type { ParsedTable, SchemaModel, TableIndexInfo } from '../src/shared/development/database/types'
import {
  buildRelationships,
  schemaToDiagram,
  type DiagramColumn,
  type DiagramDraft,
  type DiagramTable,
} from '../src/client/features/development/database/diagram'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'
import {
  validateDiagram,
  type DiagramIssue,
  type DiagramIssueCode,
} from '../src/client/features/development/database/diagram-issues'

type ColumnSpec = Partial<DiagramColumn> & { name: string }

function parsed(sql: string): ParsedTable {
  const result = parseCreateTable(sql)
  if (!result) throw new Error(`could not parse ${sql}`)
  return result
}

function indexInfo(
  table: string,
  name: string,
  columns: string[],
  unique = false,
  sql: string | null = null,
): TableIndexInfo {
  return {
    name,
    unique,
    columns,
    origin: 'c',
    sql: sql ?? `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${columns.join(', ')})`,
    table,
  }
}

function buildDraft(tables: string[], indexes: TableIndexInfo[] = []): DiagramDraft {
  const model: SchemaModel = { tables: tables.map(parsed), views: [], triggers: [], indexes }
  return schemaToDiagram(model)
}

function pk(name = 'id'): ColumnSpec {
  return { name, pk: true, pkPosition: 1 }
}

function diagramTable(
  name: string,
  columns: ColumnSpec[] = [],
  extra: Partial<DiagramTable> = {},
): DiagramTable {
  return {
    id: name,
    name,
    columns: columns.map((column, index) => ({
      id: `col:${name}:${index}`,
      type: 'TEXT',
      notNull: false,
      pk: false,
      pkPosition: 0,
      default: null,
      unique: false,
      check: null,
      collate: null,
      generated: null,
      autoIncrement: false,
      ...column,
    })),
    constraints: [],
    indexes: [],
    withoutRowid: false,
    strict: false,
    x: 0,
    y: 0,
    width: 200,
    ...extra,
  }
}

function literalDraft(tables: DiagramTable[]): DiagramDraft {
  return { tables, relationships: buildRelationships(tables) }
}

function issuesOf(issues: DiagramIssue[], code: DiagramIssueCode): DiagramIssue[] {
  return issues.filter((issue) => issue.code === code)
}

const CLEAN_INDEXES = [indexInfo('orders', 'idx_orders_code', ['code'])]
const CLEAN = buildDraft([
  'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)',
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), code TEXT, CONSTRAINT uq_orders_code UNIQUE (code))',
], CLEAN_INDEXES)

describe('validateDiagram', () => {
  it('returns no issues for a valid diagram', () => {
    expect(validateDiagram(CLEAN)).toEqual([])
  })

  it('returns no issues for an empty draft', () => {
    expect(validateDiagram({ tables: [], relationships: [] })).toEqual([])
  })

  it('keeps issue ids stable and unique', () => {
    const messy = literalDraft([
      diagramTable('users', [{ name: '' }, { name: '' }], {
        indexes: [
          { id: 'idx-a', name: 'idx', unique: false, columns: [], raw: null },
          { id: 'idx-b', name: 'IDX', unique: false, columns: [], raw: null },
        ],
        constraints: [
          { id: 'u1', kind: 'unique', name: '', raw: '', uniqueColumns: [] },
          { id: 'x1', kind: 'unknown', raw: 'EXCLUDE USING gist (a WITH =)' },
        ],
      }),
      diagramTable('log', [{ name: 'id' }], {
        constraints: [
          { id: 'fk-a', kind: 'foreign-key', name: 'fk', raw: '', columns: ['a', 'a'], refTable: 'users', refColumns: ['id', 'id'] },
          { id: 'fk-b', kind: 'foreign-key', name: 'fk', raw: '', columns: ['b'], refTable: 'missing', refColumns: ['id'] },
        ],
      }),
    ])
    const first = validateDiagram(messy)
    const second = validateDiagram(messy)
    expect(first.length).toBeGreaterThan(5)
    expect(second).toEqual(first)
    expect(new Set(first.map((issue) => issue.id)).size).toBe(first.length)
  })
})

describe('table issues', () => {
  it('flags an empty table name', () => {
    const issues = issuesOf(validateDiagram(literalDraft([diagramTable('', [pk()])])), 'table_empty_name')
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'error', tableId: '', params: { index: 1 } }),
    ])
  })

  it('flags duplicate table names case-insensitively and counts empty names', () => {
    const draft = literalDraft([
      diagramTable('Users', [pk()]),
      diagramTable('users', [pk()]),
      diagramTable('', [pk()]),
      diagramTable('  ', [pk()]),
    ])
    const issues = issuesOf(validateDiagram(draft), 'table_duplicate_name')
    expect(issues).toHaveLength(4)
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
  })

  it('accepts unique table names', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'table_duplicate_name')).toEqual([])
    expect(issuesOf(validateDiagram(CLEAN), 'table_empty_name')).toEqual([])
  })
})

describe('column issues', () => {
  it('flags an empty column name', () => {
    const draft = literalDraft([diagramTable('widgets', [pk(), { name: '' }])])
    expect(issuesOf(validateDiagram(draft), 'column_empty_name')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'widgets', params: { table: 'widgets', index: 2 } }),
    ])
  })

  it('flags duplicate column names case-insensitively', () => {
    const draft = literalDraft([diagramTable('widgets', [pk(), { name: 'Email' }, { name: 'email' }])])
    const issues = issuesOf(validateDiagram(draft), 'column_duplicate_name')
    expect(issues).toHaveLength(2)
    expect(issues.map((issue) => issue.column)).toEqual(['Email', 'email'])
  })

  it('accepts distinct column names', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'column_duplicate_name')).toEqual([])
    expect(issuesOf(validateDiagram(CLEAN), 'column_empty_name')).toEqual([])
  })

  it('does not treat empty column names as duplicates', () => {
    const draft = literalDraft([diagramTable('widgets', [pk(), { name: '' }, { name: '  ' }])])
    expect(issuesOf(validateDiagram(draft), 'column_duplicate_name')).toEqual([])
  })
})

describe('primary key issues', () => {
  it('warns when a table has no primary key', () => {
    const draft = literalDraft([diagramTable('logs', [{ name: 'message' }])])
    expect(issuesOf(validateDiagram(draft), 'no_primary_key')).toEqual([
      expect.objectContaining({ severity: 'warning', tableId: 'logs', params: { table: 'logs' } }),
    ])
  })

  it('accepts tables with a primary key', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'no_primary_key')).toEqual([])
  })
})

describe('foreign key issues', () => {
  it('flags a foreign key whose target table is missing', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES ghost (id))',
    ])
    const issues = issuesOf(validateDiagram(draft), 'fk_missing_table')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      tableId: 'orders',
      params: { table: 'orders', column: 'user_id', target: 'ghost' },
    })
    expect(issues[0]!.relationshipId).toBeTruthy()
  })

  it('accepts a foreign key whose target table exists', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'fk_missing_table')).toEqual([])
    expect(issuesOf(validateDiagram(CLEAN), 'fk_missing_column')).toEqual([])
  })

  it('flags a foreign key whose local column is missing', () => {
    const users = diagramTable('users', [pk()])
    const orders = diagramTable('orders', [pk()], {
      constraints: [
        { id: 'fk-local', kind: 'foreign-key', raw: '', columns: ['ghost_id'], refTable: 'users', refColumns: ['id'] },
      ],
    })
    expect(issuesOf(validateDiagram(literalDraft([users, orders])), 'fk_missing_column')).toEqual([
      expect.objectContaining({
        severity: 'error',
        tableId: 'orders',
        column: 'ghost_id',
        params: { table: 'orders', column: 'ghost_id', target: 'users', side: 'local' },
      }),
    ])
  })

  it('flags a foreign key whose target column is missing', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (ghost))',
    ])
    const issues = issuesOf(validateDiagram(draft), 'fk_missing_column')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ column: 'ghost', params: expect.objectContaining({ side: 'target' }) })
    expect(issuesOf(validateDiagram(draft), 'fk_target_not_key')).toEqual([])
  })

  it('flags a composite foreign key with a mismatched target arity', () => {
    const draft = buildDraft([
      'CREATE TABLE tenants (id INTEGER PRIMARY KEY, code TEXT, CONSTRAINT uq_tenants UNIQUE (id, code))',
      'CREATE TABLE memberships (id INTEGER PRIMARY KEY, tenant_id INTEGER, role TEXT, CONSTRAINT fk_memberships FOREIGN KEY (tenant_id, role) REFERENCES tenants (id))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_arity_mismatch')).toEqual([
      expect.objectContaining({
        severity: 'error',
        tableId: 'memberships',
        params: { table: 'memberships', target: 'tenants', localCount: 2, targetCount: 1 },
      }),
    ])
  })

  it('accepts a composite foreign key whose arity matches', () => {
    const draft = buildDraft([
      'CREATE TABLE tenants (id INTEGER PRIMARY KEY, code TEXT, CONSTRAINT uq_tenants UNIQUE (id, code))',
      'CREATE TABLE memberships (id INTEGER PRIMARY KEY, tenant_id INTEGER, role TEXT, CONSTRAINT fk_memberships FOREIGN KEY (tenant_id, role) REFERENCES tenants (id, code))',
    ])
    expect(validateDiagram(draft)).toEqual([])
  })

  it('flags repeated local columns in a foreign key', () => {
    const draft = buildDraft([
      'CREATE TABLE tenants (id INTEGER PRIMARY KEY, code TEXT, CONSTRAINT uq_tenants UNIQUE (id, code))',
      'CREATE TABLE memberships (id INTEGER PRIMARY KEY, tenant_id INTEGER, FOREIGN KEY (tenant_id, tenant_id) REFERENCES tenants (id, code))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_duplicate_columns')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'memberships', column: 'tenant_id' }),
    ])
  })

  it('warns when the target columns are not a key', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_name TEXT REFERENCES users (name))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_target_not_key')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        tableId: 'orders',
        params: { table: 'orders', target: 'users', columns: 'name' },
      }),
    ])
  })

  it('warns when a composite foreign key targets a non-unique column pair', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY, tenant_id INTEGER)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, tenant_id INTEGER, FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_target_not_key')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ target: 'users', columns: 'id, tenant_id' }) }),
    ])
  })

  it('accepts targets that are the primary key or a unique column', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), email TEXT REFERENCES users (email))',
    ])
    expect(validateDiagram(draft)).toEqual([])
  })

  it('accepts a composite target covered by a unique constraint', () => {
    const draft = buildDraft([
      'CREATE TABLE tenants (id INTEGER PRIMARY KEY, code TEXT, CONSTRAINT uq_tenants UNIQUE (id, code))',
      'CREATE TABLE memberships (id INTEGER PRIMARY KEY, tenant_id INTEGER, role TEXT, FOREIGN KEY (tenant_id, role) REFERENCES tenants (id, code))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_target_not_key')).toEqual([])
  })

  it('warns when two foreign keys in one table share a name', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, a_id INTEGER, b_id INTEGER, CONSTRAINT fk_owner FOREIGN KEY (a_id) REFERENCES users (id), CONSTRAINT fk_owner FOREIGN KEY (b_id) REFERENCES users (id))',
    ])
    const issues = issuesOf(validateDiagram(draft), 'fk_duplicate_name')
    expect(issues).toHaveLength(2)
    expect(issues.every((issue) => issue.severity === 'warning' && issue.params?.name === 'fk_owner')).toBe(true)
  })

  it('accepts distinct foreign key names', () => {
    const draft = buildDraft([
      'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, a_id INTEGER, b_id INTEGER, CONSTRAINT fk_a FOREIGN KEY (a_id) REFERENCES users (id), CONSTRAINT fk_b FOREIGN KEY (b_id) REFERENCES users (id))',
    ])
    expect(validateDiagram(draft)).toEqual([])
  })

  it('reports a cycle once with sorted table names', () => {
    const draft = buildDraft([
      'CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b (id))',
      'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_circular')).toEqual([
      expect.objectContaining({ severity: 'info', tableId: 'a', params: { tables: 'a, b' } }),
    ])
  })

  it('reports a self reference as a cycle', () => {
    const draft = buildDraft([
      'CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes (id))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_circular')).toEqual([
      expect.objectContaining({ severity: 'info', tableId: 'nodes', params: { tables: 'nodes' } }),
    ])
  })

  it('reports separate cycles separately', () => {
    const draft = buildDraft([
      'CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b (id))',
      'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id))',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, d_id INTEGER REFERENCES d (id))',
      'CREATE TABLE d (id INTEGER PRIMARY KEY, c_id INTEGER REFERENCES c (id))',
    ])
    expect(issuesOf(validateDiagram(draft), 'fk_circular').map((issue) => issue.params?.tables)).toEqual([
      'a, b',
      'c, d',
    ])
  })

  it('accepts acyclic foreign keys', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'fk_circular')).toEqual([])
  })
})

describe('index issues', () => {
  it('flags an empty index name', () => {
    const draft = literalDraft([
      diagramTable('users', [pk()], {
        indexes: [{ id: 'idx-a', name: '', unique: false, columns: ['id'], raw: 'CREATE INDEX x ON users (id)' }],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'index_empty_name')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'users', params: { table: 'users', index: 1 } }),
    ])
  })

  it('flags duplicate index names case-insensitively', () => {
    const draft = literalDraft([
      diagramTable('users', [pk(), { name: 'email' }, { name: 'name' }], {
        indexes: [
          { id: 'idx-a', name: 'idx_email', unique: false, columns: ['email'], raw: 'CREATE INDEX idx_email ON users (email)' },
          { id: 'idx-b', name: 'IDX_EMAIL', unique: false, columns: ['name'], raw: 'CREATE INDEX IDX_EMAIL ON users (name)' },
        ],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'index_duplicate_name')).toHaveLength(2)
  })

  it('accepts unique index names', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'index_duplicate_name')).toEqual([])
    expect(issuesOf(validateDiagram(CLEAN), 'index_empty_name')).toEqual([])
  })

  it('flags an index with neither columns nor SQL', () => {
    const draft = literalDraft([
      diagramTable('users', [pk()], {
        indexes: [{ id: 'idx-a', name: 'idx_broken', unique: false, columns: [], raw: null }],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'index_no_columns')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'users', params: { table: 'users', name: 'idx_broken' } }),
    ])
  })

  it('does not flag expression indexes', () => {
    const draft = literalDraft([
      diagramTable('users', [pk(), { name: 'email' }], {
        indexes: [{
          id: 'idx-a',
          name: 'idx_lower_email',
          unique: false,
          columns: [],
          raw: 'CREATE INDEX idx_lower_email ON users (lower(email))',
        }],
      }),
    ])
    expect(validateDiagram(draft)).toEqual([])
  })
})

describe('unique constraint issues', () => {
  it('flags a unique constraint whose name is empty', () => {
    const draft = literalDraft([
      diagramTable('users', [pk(), { name: 'email' }], {
        constraints: [{ id: 'u1', kind: 'unique', name: '', raw: '', uniqueColumns: ['email'] }],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'unique_empty_name')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'users', params: { table: 'users', index: 1 } }),
    ])
  })

  it('accepts unnamed unique constraints', () => {
    const draft = literalDraft([
      diagramTable('users', [pk(), { name: 'email' }], {
        constraints: [{ id: 'u1', kind: 'unique', raw: '', uniqueColumns: ['email'] }],
      }),
    ])
    expect(validateDiagram(draft)).toEqual([])
  })

  it('flags duplicate unique constraint names', () => {
    const draft = literalDraft([
      diagramTable('users', [pk(), { name: 'email' }, { name: 'name' }], {
        constraints: [
          { id: 'u1', kind: 'unique', name: 'uq_user', raw: '', uniqueColumns: ['email'] },
          { id: 'u2', kind: 'unique', name: 'UQ_USER', raw: '', uniqueColumns: ['name'] },
        ],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'unique_duplicate_name')).toHaveLength(2)
  })

  it('flags a unique constraint without columns', () => {
    const draft = literalDraft([
      diagramTable('users', [pk()], {
        constraints: [{ id: 'u1', kind: 'unique', name: 'uq_user', raw: '', uniqueColumns: [] }],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'unique_no_columns')).toEqual([
      expect.objectContaining({ severity: 'error', tableId: 'users', params: { table: 'users', name: 'uq_user' } }),
    ])
  })

  it('accepts named unique constraints with columns', () => {
    expect(issuesOf(validateDiagram(CLEAN), 'unique_no_columns')).toEqual([])
    expect(issuesOf(validateDiagram(CLEAN), 'unique_duplicate_name')).toEqual([])
  })
})

describe('unknown constraint issues', () => {
  it('reports unsupported constraints as info', () => {
    const raw = 'EXCLUDE USING gist (room WITH =)'
    const draft = literalDraft([
      diagramTable('rooms', [pk()], {
        constraints: [{ id: 'c1', kind: 'unknown', raw }],
      }),
    ])
    expect(issuesOf(validateDiagram(draft), 'constraint_unknown')).toEqual([
      expect.objectContaining({ severity: 'info', tableId: 'rooms', params: { table: 'rooms', raw } }),
    ])
  })

  it('accepts supported constraints', () => {
    const draft = buildDraft(['CREATE TABLE rooms (id INTEGER PRIMARY KEY, CHECK (id > 0))'])
    expect(validateDiagram(draft)).toEqual([])
  })
})