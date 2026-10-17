// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_REQUIRED_COLUMNS, ASSISTANT_SCHEMA_STATEMENTS } from '../src/worker/assistant/schema'

/**
 * Deleting a note for good has to clear every chat row that names it.
 *
 * `src/worker/notes/store.ts` purged a trashed note through five note tables and, until this fix, not one
 * `chat_*` table. `chat_conversations.note_id`, `chat_artifacts.note_id`, `chat_memories.note_id` and
 * `chat_note_writes` kept the id of a note that no longer existed: the conversation chip pointed at a note
 * that 404'd, the artifact's "written from this thread" link could never be followed again, and a memory
 * once filed as a note claimed a source nobody could open. Four statements landed in both the single purge
 * and the batched one.
 *
 * The point of this guard is that it does not know those four names. It reads the chat schema and asks
 * which tables carry a column that points at a note, then requires both purge paths to handle each one — so
 * a fifth `note_id` column added to a chat table with no cascade fails here, in the change that adds it,
 * rather than in a database a month later. The action is read from the column as well: a `NOT NULL` pointer
 * cannot be nulled, so those rows have to go, and every statement has to stay scoped to the account it
 * belongs to. Nothing is whitelisted, because the rule is only about statements this tree already writes.
 */
const NOTES_STORE = path.join('src', 'worker', 'notes', 'store.ts')
/** The two purge paths: one note, and a page of the trash. */
const PURGE_FUNCTIONS = ['purge', 'trashPurgeStatements']
/** The column a chat table uses to point at a note. */
const NOTE_COLUMN = 'note_id'

/** What one purge statement does to one chat table's note pointer. */
interface Handling {
  action: 'null-out' | 'delete'
  scoped: boolean
  sql: string
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/** Every chat table that names a note, read out of the DDL rather than from a list in this file. */
function noteReferences(statements: readonly string[]): { table: string; nullable: boolean }[] {
  const found: { table: string; nullable: boolean }[] = []
  for (const statement of statements) {
    const body = /^\s*CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*$/i.exec(statement.trim())
    if (!body) continue
    const table = body[1]!
    if (!table.startsWith('chat_')) continue
    for (const line of body[2]!.split('\n')) {
      const column = /^(\w+)\s+(\w+[^,]*)/i.exec(line.trim().replace(/,$/, ''))
      if (!column || column[1]!.toLowerCase() !== NOTE_COLUMN) continue
      found.push({ table, nullable: !/\bNOT NULL\b/i.test(column[2]!) })
    }
  }
  return found
}

/** The same set read out of the repair list, so the two halves of the schema cannot disagree. */
function noteTablesFromRequiredColumns(columns: Record<string, readonly string[]>): string[] {
  return Object.entries(columns)
    .filter(([table, list]) => table.startsWith('chat_') && list.includes(NOTE_COLUMN))
    .map(([table]) => table)
    .sort()
}

/** Every SQL string written inside one named function of the store. */
function statementsIn(sourceText: string, name: string): string[] {
  const source = ts.createSourceFile(NOTES_STORE, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const isSql = (node: ts.Node): boolean => (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
    && /\b(?:UPDATE|DELETE\s+FROM)\b/i.test(node.getText())
  const collect = (node: ts.Node): void => {
    const isTarget = (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
      && !!node.name && node.name.getText() === name
    if (isTarget) {
      // Only under the declaration: a statement written in another method of the same file must not be
      // credited to this purge path, which is what makes the two paths audited separately.
      const inner = (current: ts.Node): void => {
        if (isSql(current)) found.push(current.getText().slice(1, -1))
        ts.forEachChild(current, inner)
      }
      inner(node)
      return
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  return found
}

/** What a list of statements does to each chat table it touches. */
function handlings(statements: string[]): Map<string, Handling[]> {
  const map = new Map<string, Handling[]>()
  for (const sql of statements) {
    const target = /(?:UPDATE\s+|DELETE\s+FROM\s+)(\w+)/i.exec(sql)
    if (!target) continue
    const table = target[1]!.toLowerCase()
    if (!table.startsWith('chat_')) continue
    if (!new RegExp(`\\b${NOTE_COLUMN}\\b`, 'i').test(sql)) continue
    const nullOut = new RegExp(`SET\\s+${NOTE_COLUMN}\\s*=\\s*NULL`, 'i').test(sql)
    const deletes = /^\s*DELETE\s+FROM/m.test(sql)
    if (!nullOut && !deletes) continue
    const scoped = /\bWHERE\b/i.test(sql) && /\buser_id\b/i.test(sql)
    map.set(table, [...(map.get(table) ?? []), { action: deletes ? 'delete' : 'null-out', scoped, sql: sql.replace(/\s+/g, ' ').trim() }])
  }
  return map
}

/**
 * Every gap between the pointers the schema declares and what the two purge paths do about them.
 *
 * A line is a problem the next deploy would ship: a chat table that names a note and is left pointing at
 * nothing when the note is purged.
 */
function cascadeGaps(statements: readonly string[], storeText: string): string[] {
  const lines: string[] = []
  for (const reference of noteReferences(statements)) {
    for (const name of PURGE_FUNCTIONS) {
      const where = `${name}()`
      const candidates = handlings(statementsIn(storeText, name)).get(reference.table.toLowerCase()) ?? []
      if (!candidates.length) {
        lines.push(`${where} leaves ${reference.table}.${NOTE_COLUMN} pointing at a purged note — null it out, or delete the rows`)
        continue
      }
      if (candidates.some((candidate) => candidate.scoped && (reference.nullable || candidate.action === 'delete'))) continue
      const offender = candidates.find((candidate) => !reference.nullable && candidate.action !== 'delete')
        ?? candidates.find((candidate) => !candidate.scoped)
      if (!reference.nullable && offender && offender.action !== 'delete') {
        lines.push(`${where} nulls ${reference.table}.${NOTE_COLUMN}, which the schema declares NOT NULL — delete the rows instead`)
      } else {
        lines.push(`${where} touches ${reference.table} without a user_id predicate — a purge is one account's ${offender ? `(reading: ${offender.sql.slice(0, 60)})` : 'own'}`)
      }
    }
  }
  return lines
}

const SCHEMA_STATEMENTS = [...ASSISTANT_SCHEMA_STATEMENTS]
const STORE_TEXT = read(NOTES_STORE)
const GAPS = cascadeGaps(SCHEMA_STATEMENTS, STORE_TEXT)
const REFERENCES = noteReferences(SCHEMA_STATEMENTS).map((reference) => reference.table).sort()

describe('a purged note is cleared out of every chat table that names it', () => {
  it('reads note pointers out of the chat schema, not out of this file', () => {
    expect(REFERENCES, 'the schema declares no chat table that names a note, so the scan is reading nothing').toHaveLength(4)
    expect(REFERENCES).toEqual(['chat_artifacts', 'chat_conversations', 'chat_memories', 'chat_note_writes'])
    // The DDL and the repair list describe the same columns; a divergence between them is its own bug.
    expect(noteTablesFromRequiredColumns(ASSISTANT_REQUIRED_COLUMNS)).toEqual(REFERENCES)
    // `chat_note_writes` is the pointer the schema forbids nulling, which is why its rows go.
    expect(noteReferences(SCHEMA_STATEMENTS).filter((reference) => !reference.nullable).map((reference) => reference.table))
      .toEqual(['chat_note_writes'])
    // And the notes store really owns both purge paths the rule is about.
    for (const name of PURGE_FUNCTIONS) {
      expect(statementsIn(STORE_TEXT, name).length, `${name}() holds no statements to read`).toBeGreaterThan(3)
    }
    expect(handlings(statementsIn(STORE_TEXT, 'purge')).size, 'the single purge handles no chat table').toBe(4)
    expect(handlings(statementsIn(STORE_TEXT, 'trashPurgeStatements')).size, 'the batched purge handles no chat table').toBe(4)
  })

  it('fails when a chat table that names a note is not cleaned by both purge paths', () => {
    expect(GAPS, `${GAPS.length} cascade gap(s).`).toEqual([])
  })

  it('fires on a new note pointer with no cascade', () => {
    // Positive control, first half: the change this guard exists to stop — a fifth `note_id` column in the
    // chat schema with nothing written in the notes store about it. Both purge paths have to go red.
    const withNewPointer = cascadeGaps([
      ...SCHEMA_STATEMENTS,
      `CREATE TABLE IF NOT EXISTS chat_note_pins (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id, conversation_id)
  )`,
    ], STORE_TEXT)
    expect(withNewPointer.filter((line) => line.includes('chat_note_pins')).map((line) => line.split(' — ')[0]))
      .toEqual([
        'purge() leaves chat_note_pins.note_id pointing at a purged note',
        'trashPurgeStatements() leaves chat_note_pins.note_id pointing at a purged note',
      ])
  })

  it('fires when one purge path stops covering a pointer it covers today', () => {
    // Positive control, second half: the audit is not trusting the four names it happens to find. Take one
    // statement out and only that path's gap appears — so a cascade added to the single purge but not to
    // the batch cannot pass either.
    const withoutMemories = STORE_TEXT.replace(
      /`UPDATE chat_memories SET note_id = NULL[\s\S]*?`,/,
      '',
    )
    expect(withoutMemories, 'the planted edit found nothing to remove').not.toBe(STORE_TEXT)
    expect(cascadeGaps(SCHEMA_STATEMENTS, withoutMemories).map((line) => line.split(' — ')[0])).toEqual([
      'purge() leaves chat_memories.note_id pointing at a purged note',
    ])

    const withoutBatch = STORE_TEXT.replace(
      /`UPDATE chat_memories SET note_id = NULL WHERE user_id = \?1 AND note_id \$\{inTrash\}`/,
      '',
    )
    expect(withoutBatch, 'the planted edit found nothing to remove').not.toBe(STORE_TEXT)
    expect(cascadeGaps(SCHEMA_STATEMENTS, withoutBatch).map((line) => line.split(' — ')[0])).toEqual([
      'trashPurgeStatements() leaves chat_memories.note_id pointing at a purged note',
    ])
  })

  it('reads the column shape and the account scope out of the statement it audits', () => {
    // Positive control, third half: a cascade that exists but is written the wrong way. Nulling a pointer
    // the schema forbids nulling fails, and so does a statement that names no account — a D1 batch is
    // built per connection, and an unscoped delete reaches every reader's rows.
    const notNullNulled = cascadeGaps([`CREATE TABLE IF NOT EXISTS chat_note_pins (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`], `
    async function purge(note) {
      db.prepare(\`UPDATE chat_note_pins SET note_id = NULL WHERE user_id = ?1 AND note_id = ?2\`)
      db.prepare(\`UPDATE chat_note_pins SET note_id = NULL WHERE user_id = ?1 AND note_id = ?2\`)
    }
  `)
    expect(notNullNulled.map((line) => line.split(' — ')[0])).toEqual([
      'purge() nulls chat_note_pins.note_id, which the schema declares NOT NULL',
      'trashPurgeStatements() leaves chat_note_pins.note_id pointing at a purged note',
    ])

    const unscoped = cascadeGaps([`CREATE TABLE IF NOT EXISTS chat_note_refs (
    user_id TEXT NOT NULL,
    note_id TEXT,
    PRIMARY KEY (user_id, note_id)
  )`], `
    async function purge(note) {
      db.prepare(\`UPDATE chat_note_refs SET note_id = NULL WHERE note_id = ?2\`)
    }
    function trashPurgeStatements() {
      db.prepare(\`UPDATE chat_note_refs SET note_id = NULL WHERE note_id = ?2\`)
    }
  `)
    expect(unscoped.every((line) => line.includes('without a user_id predicate'))).toBe(true)

    // The same two columns written the right way clear the audit, so the rule is about the shape.
    const correct = cascadeGaps([`CREATE TABLE IF NOT EXISTS chat_note_refs (
    user_id TEXT NOT NULL,
    note_id TEXT,
    PRIMARY KEY (user_id, note_id)
  )`, `CREATE TABLE IF NOT EXISTS chat_note_pins (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`], `
    async function purge(note) {
      db.prepare(\`UPDATE chat_note_refs SET note_id = NULL WHERE user_id = ?1 AND note_id = ?2\`)
      db.prepare(\`DELETE FROM chat_note_pins WHERE user_id = ?1 AND note_id = ?2\`)
    }
    function trashPurgeStatements() {
      db.prepare(\`UPDATE chat_note_refs SET note_id = NULL WHERE user_id = ?1 AND note_id \${inTrash}\`)
      db.prepare(\`DELETE FROM chat_note_pins WHERE user_id = ?1 AND note_id \${inTrash}\`)
    }
  `)
    expect(correct).toEqual([])
  })
})
