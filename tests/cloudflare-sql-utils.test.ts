import { describe, expect, it } from 'vitest'
import {
  buildCreateTableSql,
  findStatementRangeAt,
  isSimpleIdent,
  isWriteSql,
  quoteIdent,
  scanSqlStatementRanges,
  splitSqlStatements,
} from '../src/shared/cloudflare/sql-utils'

describe('statement splitting', () => {
  it('splits on top-level semicolons and keeps trailing punctuation', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;'])
    expect(splitSqlStatements('  ; ; SELECT 1')).toEqual(['SELECT 1'])
  })

  it('does not split inside strings, comments or parentheses', () => {
    const sql = [
      "SELECT 'a;b' AS value;",
      '-- a comment; with a semicolon',
      'SELECT count(*) FROM (SELECT 1; SELECT 2);',
      '/* block; comment */ SELECT 3;',
    ].join('\n')
    const statements = splitSqlStatements(sql)
    expect(statements).toHaveLength(3)
    expect(statements[0]).toContain("'a;b'")
    expect(statements[1]).toContain('-- a comment; with a semicolon')
    expect(statements[1]).toContain('SELECT count(*)')
    expect(statements[2]).toContain('/* block; comment */ SELECT 3;')
  })

  it('keeps a trigger body together, including inner semicolons', () => {
    const sql = [
      'CREATE TRIGGER audit_insert AFTER INSERT ON notes BEGIN',
      '  UPDATE notes SET touched = 1 WHERE id = NEW.id;',
      '  INSERT INTO audit_log (note_id) VALUES (NEW.id);',
      'END;',
      'SELECT 1;',
    ].join('\n')
    const statements = splitSqlStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('INSERT INTO audit_log')
    expect(statements[0]!.endsWith('END;')).toBe(true)
  })

  it('does not confuse a CASE ... END inside a trigger with the trigger END', () => {
    const sql = [
      'CREATE TEMP TRIGGER categorize AFTER INSERT ON notes BEGIN',
      "  UPDATE notes SET label = CASE WHEN NEW.kind = 'a' THEN 'x;y' ELSE 'z' END;",
      '  INSERT INTO audit_log (note_id) VALUES (NEW.id);',
      'END;',
      'SELECT 2;',
    ].join('\n')
    const statements = splitSqlStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('INSERT INTO audit_log')
    expect(statements[1]).toBe('SELECT 2;')
  })

  it('reports statement ranges with comments included', () => {
    const sql = '-- first\nSELECT 1;\n\nSELECT 2;'
    const ranges = scanSqlStatementRanges(sql)
    expect(ranges).toHaveLength(2)
    expect(sql.slice(ranges[0]!.from, ranges[0]!.to)).toBe('-- first\nSELECT 1;')
    expect(sql.slice(ranges[1]!.from, ranges[1]!.to)).toBe('SELECT 2;')
  })
})

describe('write detection', () => {
  it('recognizes every guarded verb', () => {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE', 'TRUNCATE']) {
      expect(isWriteSql(`${verb} something`)).toBe(true)
      expect(isWriteSql(`  /* note */ ${verb.toLowerCase()} something`)).toBe(true)
    }
  })

  it('leaves reads and words inside strings alone', () => {
    expect(isWriteSql('SELECT * FROM notes')).toBe(false)
    expect(isWriteSql("SELECT 'DELETE FROM notes' AS sample")).toBe(false)
    expect(isWriteSql('WITH recent AS (SELECT * FROM notes) SELECT * FROM recent')).toBe(false)
  })

  it('refuses the verbs that change the file or the connection', () => {
    for (const verb of ['ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'SET']) {
      expect(isWriteSql(`${verb} something`)).toBe(true)
    }
  })

  it('lets a reader inspect a table through a pragma but not retune the database', () => {
    expect(isWriteSql("PRAGMA table_info('notes')")).toBe(false)
    expect(isWriteSql('PRAGMA main.table_info(notes)')).toBe(false)
    expect(isWriteSql('PRAGMA table_list')).toBe(false)
    expect(isWriteSql('/* note */ PRAGMA index_list(notes)')).toBe(false)
    expect(isWriteSql('PRAGMA journal_mode = WAL')).toBe(true)
    expect(isWriteSql('PRAGMA writable_schema = ON')).toBe(true)
    expect(isWriteSql('PRAGMA user_version = 5')).toBe(true)
  })

  it('checks every statement and rejects writes hidden behind a CTE', () => {
    expect(isWriteSql('SELECT 1; DELETE FROM notes;')).toBe(true)
    expect(isWriteSql('WITH doomed AS (SELECT id FROM notes) DELETE FROM notes WHERE id IN (SELECT id FROM doomed)')).toBe(true)
    expect(isWriteSql('EXPLAIN QUERY PLAN SELECT * FROM notes')).toBe(false)
    expect(isWriteSql('EXPLAIN DELETE FROM notes')).toBe(true)
  })
})

describe('caret statement ranges', () => {
  const sql = 'SELECT 1;\n  \nSELECT 2;'

  it('returns the statement under the caret', () => {
    const range = findStatementRangeAt(sql, sql.indexOf('SELECT 2') + 3)
    expect(range).not.toBeNull()
    expect(sql.slice(range!.from, range!.to)).toBe('SELECT 2;')
  })

  it('gives whitespace between statements to the next one', () => {
    const whitespace = sql.indexOf('\n  \n') + 1
    const range = findStatementRangeAt(sql, whitespace)
    expect(range).not.toBeNull()
    expect(sql.slice(range!.from, range!.to)).toBe('SELECT 2;')
  })

  it('returns the last statement at the end of the document', () => {
    const range = findStatementRangeAt(sql, sql.length)
    expect(range).not.toBeNull()
    expect(sql.slice(range!.from, range!.to)).toBe('SELECT 2;')
  })

  it('returns the whole trigger when the caret is in its body', () => {
    const trigger = 'CREATE TRIGGER t AFTER INSERT ON x BEGIN\n  SELECT 1;\nEND;'
    const range = findStatementRangeAt(trigger, trigger.indexOf('SELECT 1'))
    expect(range).not.toBeNull()
    expect(range!.from).toBe(0)
    expect(range!.to).toBe(trigger.length)
  })

  it('ignores positions outside the text', () => {
    expect(findStatementRangeAt('', 0)).toBeNull()
    expect(findStatementRangeAt('SELECT 1', -1)).toBeNull()
    expect(findStatementRangeAt('SELECT 1', 20)).toBeNull()
  })
})

describe('identifier helpers', () => {
  it('quotes identifiers and doubles embedded quotes', () => {
    expect(quoteIdent('notes')).toBe('"notes"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })

  it('accepts only simple identifiers', () => {
    expect(isSimpleIdent('notes_2')).toBe(true)
    expect(isSimpleIdent('2notes')).toBe(false)
    expect(isSimpleIdent('note-2')).toBe(false)
  })

  it('builds a create-table statement from the builder rows', () => {
    expect(buildCreateTableSql('notes', [
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'untitled'" },
    ])).toBe('CREATE TABLE "notes" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "title" TEXT NOT NULL DEFAULT \'untitled\'\n);')
  })
})
