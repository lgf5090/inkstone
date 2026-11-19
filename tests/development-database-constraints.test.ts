import { describe, expect, it } from 'vitest'
import {
  REF_ACTIONS,
  constraintSignature,
  normalizeRefAction,
  parseTableConstraint,
  sameConstraint,
  serializeConstraint,
  splitIdentifierList,
} from '../src/client/features/development/database/constraints'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'

describe('parseTableConstraint', () => {
  it('parses a composite foreign key with actions', () => {
    const parsed = parseTableConstraint(
      'CONSTRAINT fk_orders_users FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users" ("id", "tenant_id") ON UPDATE CASCADE ON DELETE SET NULL',
    )
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      kind: 'foreign-key',
      name: 'fk_orders_users',
      columns: ['user_id', 'tenant_id'],
      refTable: 'users',
      refColumns: ['id', 'tenant_id'],
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    })
  })

  it('parses an unnamed single column foreign key', () => {
    const parsed = parseTableConstraint('FOREIGN KEY (user_id) REFERENCES users (id)')
    expect(parsed).toMatchObject({
      kind: 'foreign-key',
      columns: ['user_id'],
      refTable: 'users',
      refColumns: ['id'],
    })
    expect(parsed?.onUpdate).toBeUndefined()
    expect(parsed?.onDelete).toBeUndefined()
  })

  it('parses a foreign key without referenced columns', () => {
    const parsed = parseTableConstraint('FOREIGN KEY (user_id) REFERENCES users')
    expect(parsed).toMatchObject({ kind: 'foreign-key', columns: ['user_id'], refTable: 'users' })
    expect(parsed?.refColumns).toBeUndefined()
  })

  it('parses named unique and check constraints', () => {
    expect(parseTableConstraint('CONSTRAINT uq_email UNIQUE ("email", "tenant_id")')).toMatchObject({
      kind: 'unique',
      name: 'uq_email',
      uniqueColumns: ['email', 'tenant_id'],
    })
    expect(parseTableConstraint('CHECK ("price" > 0)')).toMatchObject({
      kind: 'check',
      expression: '"price" > 0',
    })
    expect(parseTableConstraint('CHECK ((a > 0) AND (b < 10))')).toMatchObject({
      kind: 'check',
      expression: '(a > 0) AND(b < 10)',
    })
  })

  it('ignores primary key constraints because columns carry that state', () => {
    expect(parseTableConstraint('PRIMARY KEY ("a", "b")')).toBeNull()
    expect(parseTableConstraint('CONSTRAINT pk PRIMARY KEY ("a")')).toBeNull()
  })

  it('keeps unsupported clauses as unknown instead of dropping them', () => {
    const raw = 'FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED'
    const parsed = parseTableConstraint(raw)
    expect(parsed).toMatchObject({ kind: 'unknown', raw })
    expect(serializeConstraint(parsed!)).toBe(raw)
  })

  it('treats unrecognized table constraints as unknown', () => {
    const raw = 'EXCLUDE USING gist (room WITH =)'
    expect(parseTableConstraint(raw)).toMatchObject({ kind: 'unknown', raw })
  })

  it('handles quoted and bracket identifiers', () => {
    const parsed = parseTableConstraint(
      'FOREIGN KEY ([user id]) REFERENCES "user table" (`id`) ON DELETE CASCADE',
    )
    expect(parsed).toMatchObject({
      kind: 'foreign-key',
      columns: ['user id'],
      refTable: 'user table',
      refColumns: ['id'],
      onDelete: 'CASCADE',
    })
  })
})

describe('serializeConstraint', () => {
  it('round-trips a structured foreign key', () => {
    const sql = serializeConstraint({
      id: 'c1',
      kind: 'foreign-key',
      name: 'fk_orders_users',
      raw: '',
      columns: ['user_id', 'tenant_id'],
      refTable: 'users',
      refColumns: ['id', 'tenant_id'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    })
    expect(sql).toBe(
      'CONSTRAINT "fk_orders_users" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users" ("id", "tenant_id") ON UPDATE RESTRICT ON DELETE CASCADE',
    )
    const reparsed = parseTableConstraint(sql)
    expect(sameConstraint(reparsed!, {
      id: 'c2',
      kind: 'foreign-key',
      name: 'fk_orders_users',
      raw: '',
      columns: ['user_id', 'tenant_id'],
      refTable: 'users',
      refColumns: ['id', 'tenant_id'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    })).toBe(true)
  })

  it('round-trips unique and check constraints', () => {
    const unique = serializeConstraint({
      id: 'c1',
      kind: 'unique',
      name: 'uq',
      raw: '',
      uniqueColumns: ['email', 'tenant'],
    })
    expect(unique).toBe('CONSTRAINT "uq" UNIQUE ("email", "tenant")')
    expect(parseTableConstraint(unique)).toMatchObject({ kind: 'unique', uniqueColumns: ['email', 'tenant'] })

    const check = serializeConstraint({
      id: 'c2',
      kind: 'check',
      raw: '',
      expression: '"price" > 0',
    })
    expect(check).toBe('CHECK ("price" > 0)')
    expect(parseTableConstraint(check)).toMatchObject({ kind: 'check', expression: '"price" > 0' })
  })

  it('returns the raw text for unknown constraints', () => {
    const raw = 'EXCLUDE USING gist (room WITH =)'
    expect(serializeConstraint({ id: 'c', kind: 'unknown', raw })).toBe(raw)
  })
})

describe('helpers', () => {
  it('splits identifier lists', () => {
    expect(splitIdentifierList('"user id", tenant_id, [group]')).toEqual(['user id', 'tenant_id', 'group'])
    expect(splitIdentifierList('')).toEqual([])
  })

  it('normalizes reference actions', () => {
    expect(normalizeRefAction('cascade')).toBe('CASCADE')
    expect(normalizeRefAction(' set   null ')).toBe('SET NULL')
    expect(normalizeRefAction('bogus')).toBe('NO ACTION')
    expect(REF_ACTIONS).toContain(normalizeRefAction('No Action'))
  })

  it('compares constraints without depending on ids or raw text', () => {
    const left = parseTableConstraint('FOREIGN KEY (a) REFERENCES b (id)')!
    const right = parseTableConstraint('foreign key ("a") references "b" ("id")')!
    expect(constraintSignature(left)).toBe(constraintSignature(right))
    expect(sameConstraint(left, right)).toBe(true)
  })
})

describe('column level references', () => {
  it('captures on update and on delete actions', () => {
    const table = parseCreateTable(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE ON UPDATE SET NULL)',
    )
    expect(table?.columns[1]?.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'SET NULL',
    })
  })
})