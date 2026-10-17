// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_SCHEMA_STATEMENTS } from '../src/worker/assistant/schema'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'

/**
 * A correlated subquery has to name a column the index can start from.
 *
 * `assistant/store.ts`'s conversation list counted each thread's messages with
 * `(SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id)`. `idx_chat_messages_conversation`
 * leads with `user_id`, so the subquery could not use it: every conversation on the page read every message
 * row of every account. Measured on a real database the list took 4.8 s, and 2.7 ms once `m.user_id =
 * c.user_id` was added.
 *
 * This is deliberately not a SQL parser, and the doc comment says so rather than pretending otherwise:
 * deriving "can SQLite reach an index here" in general needs an optimizer. What is implemented is the shape
 * the bug was written in — a reference to an indexed table that is *inside* something (a subquery, whether
 * it correlates or not) or introduced by a `JOIN`, i.e. a reference whose predicates are easy to read off
 * the same fragment — over the two stores that own the note and chat tables. For each such reference the
 * fragment must constrain at least one column that an index (or the table's primary key) starts with, and
 * those columns come from the schema text, so a new index or a new table is read the same way.
 *
 * Two things are allowed, both with a reason. A fragment whose predicate arrives as `${q.where}` counts as
 * constraining the leading column, because the `Query` helper's first clause is always the account's — the
 * premise is checked below rather than trusted, and it fails here the day that stops being true. And one
 * site is recorded as a live violation of the same class, which is what the last test is for.
 */
const FILES = ['src/worker/assistant/store.ts', 'src/worker/notes/store.ts']
/** The helper whose `where` clause stands in for a tenant predicate this scan cannot see. */
const INTERPOLATED_WHERE = /\$\{\s*q\.where\s*\}/
/** SQL words that sit where an alias would, so they are not read as one. */
const NOT_AN_ALIAS = /^(where|order|group|limit|having|join|on|set|values|union|select|left|right|inner|cross|natural|using|lateral|and|or|not|as|filter|returning)$/i

/** One indexed reference the scan looked at, and whether it can reach an index. */
interface Ref {
  file: string
  scope: string
  table: string
  /** The columns that would have let the index be used, for the message. */
  entryColumns: string[]
  line: number
  ok: boolean
}

/**
 * References this scan cannot see an index for, each with the reason it is allowed to stay.
 *
 * `getConversation` is a real instance of the bug this guard was written after: it reads one conversation,
 * but its message count still runs a full scan of `chat_messages`, and the route calls it on nearly every
 * turn. It is recorded, not excused — adding the tenant predicate deletes the entry, and an entry whose
 * site no longer misses fails here just the same.
 */
const RECORDED_MISSES = new Map<string, string>([
])

const keyOf = (ref: Ref): string => `${ref.file} # ${ref.scope} # ${ref.table}`

function describeRef(ref: Ref): string {
  return `${ref.scope}() reads ${ref.table} without constraining ${ref.entryColumns.join(' or ')}`
}

function relative(file: string): string {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

/**
 * The columns an index on each table can start from.
 *
 * Read from the DDL text: a `CREATE INDEX … ON table(col, …)` contributes its first column, and so does a
 * primary key, single-column or composite. A reference that names none of them cannot be answered from any
 * key the table has, which is the whole rule.
 */
function entryColumns(statements: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const add = (table: string, column: string | undefined): void => {
    if (!column) return
    const key = table.toLowerCase()
    const list = map.get(key) ?? []
    const value = column.trim().replace(/^"|"$/g, '').toLowerCase()
    if (value && !list.includes(value)) list.push(value)
    map.set(key, list)
  }
  for (const statement of statements) {
    for (const match of statement.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)) {
      add(match[1]!, match[2]!.split(',')[0]?.trim().split(/\s+/)[0])
    }
    const table = /^\s*CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*$/i.exec(statement.trim())
    if (!table) continue
    const composite = /PRIMARY KEY\s*\(([^)]*)\)/i.exec(table[2]!)
    if (composite) {
      add(table[1]!, composite[1]!.split(',')[0]?.trim())
      continue
    }
    for (const line of table[2]!.split('\n')) {
      const single = /^(\w+)\s+[^,]*PRIMARY KEY$/i.exec(line.trim().replace(/,$/, ''))
      if (single) {
        add(table[1]!, single[1])
        break
      }
    }
  }
  return map
}

/** The function or method a node was written in, so a whitelist entry names something searchable. */
function scopeName(node: ts.Node): string {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText()
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.getText()
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent
      && ts.isVariableDeclaration(current.parent)) return current.parent.name.getText()
    current = current.parent
  }
  return 'module'
}

/**
 * Every reference the rule covers in one file.
 *
 * A reference is only read when it sits inside parentheses — a subquery, correlated or not — or when a
 * `JOIN` introduced it. The top-level `FROM` of a store query is not in that set: those statements bind the
 * account in their own `WHERE`, and the shape the bug was written in is the one where a fragment borrows an
 * outer row and forgets whose it is.
 */
function referencesIn(file: string, sourceText: string, entries: Map<string, string[]>): Ref[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Ref[] = []
  const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const raw = node.getText()
      if (/\bselect\b/i.test(raw) && /\b(from|join)\b/i.test(raw)) {
        const sql = raw.slice(1, -1)
        const scope = scopeName(node)
        for (const match of sql.matchAll(/\b(FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?([a-z]\w*))?/gi)) {
          const table = match[2]!.toLowerCase()
          const columns = entries.get(table)
          if (!columns || !columns.length) continue
          const raw2 = match[3]
          const alias = raw2 && !NOT_AN_ALIAS.test(raw2) ? raw2 : undefined
          const start = match.index ?? 0
          let depth = 0
          for (let index = 0; index < start; index += 1) {
            if (sql[index] === '(') depth += 1
            else if (sql[index] === ')') depth -= 1
          }
          const joined = /^join$/i.test(match[1]!)
          if (depth === 0 && !joined) continue
          // The fragment runs to the parenthesis that closes it, or to the end of the statement.
          let end = sql.length
          let open = 0
          for (let index = start + match[0].length; index < sql.length; index += 1) {
            if (sql[index] === '(') open += 1
            else if (sql[index] === ')') {
              if (open === 0) {
                end = index
                break
              }
              open -= 1
            }
          }
          const fragment = sql.slice(start, end)
          const wanted = columns.map((column) => (alias ? `${alias}.${column}` : column))
          const hit = wanted.some((token) => new RegExp(`\\b${token.replace(/\./g, '\\.')}\\b`, 'i').test(fragment))
          found.push({
            file,
            scope,
            table,
            entryColumns: wanted,
            line: line(node),
            // `${q.where}` is the helper's own account clause: `Query` pushes `user_id = ?1` first, always,
            // which is checked against the source in the test below rather than assumed here.
            ok: hit || INTERPOLATED_WHERE.test(fragment),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const ENTRIES = entryColumns([...ASSISTANT_SCHEMA_STATEMENTS, ...SCHEMA_STATEMENTS])
const SCANNED = FILES.flatMap((file) => referencesIn(file, fs.readFileSync(file, 'utf8'), ENTRIES))
const MISSES = SCANNED.filter((ref) => !ref.ok)

describe('an indexed reference names the column its index starts from', () => {
  it('reads the schema it claims to derive from', () => {
    // Both directions of the failure this guard could have: an empty derivation, and a table it forgot.
    expect(ENTRIES.size, 'no index or primary key was read, so the scan cannot be trusted').toBeGreaterThan(30)
    expect(ENTRIES.get('chat_messages'), 'the table the bug was written in is missing').toEqual(['user_id'])
    expect(ENTRIES.get('notes'), 'the notes table lost its key').toContain('id')
    expect(SCANNED.length, 'not one indexed reference was read').toBeGreaterThan(10)
    expect(SCANNED.filter((ref) => ref.ok).length, 'every reference misses, so the rule is not reading the fix').toBeGreaterThan(5)
    // The premise behind the `${q.where}` allowance, checked rather than trusted.
    const query = fs.readFileSync(FILES[0]!, 'utf8')
    expect(query, 'Query no longer scopes every read to one account, so the allowance is void').toMatch(/clauses\.push\(`user_id = \?1`\)/)
  })

  it('fails when a subquery or join cannot reach an index', () => {
    const offenders = MISSES
      .filter((ref) => !RECORDED_MISSES.has(keyOf(ref)))
      .map((ref) => `${ref.file}:${ref.line} ${describeRef(ref)} — add the predicate, or record the site with why it cannot be answered from an index`)
    expect(offenders, `${offenders.length} indexed reference(s) cannot use an index.`).toEqual([])
  })

  it('keeps the recorded misses on the books until they are fixed', () => {
    const keys = new Set(MISSES.map(keyOf))
    const paid = [...RECORDED_MISSES.keys()].filter((key) => !keys.has(key))
    expect(paid, `this reference now reaches an index — the fix landed, delete the entry: ${paid.join(', ')}`).toEqual([])
    for (const [key, reason] of RECORDED_MISSES) expect(reason.length, `${key} has no reason written`).toBeGreaterThan(40)
    // Both correlated message counts now name the column their index starts with, so neither may show up
    // as a live miss. The positive control below is what proves the rule can still see one.
    expect([...keys].filter((key) => key.endsWith('# chat_messages')), 'a message count stopped using the index again').toEqual([])
  })

  it('fires on a count that forgets the column the index starts with, and clears when it names one', () => {
    // Positive control. The planted file is the conversation list as it was written before the fix, and the
    // planted schema says which column its own index leads with — so this asserts the rule, not the name of
    // a table this repository happens to have.
    const plantedSchema = entryColumns([
      `CREATE TABLE IF NOT EXISTS chat_events (
    user_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT,
    PRIMARY KEY (user_id, id)
  )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_events_stream
     ON chat_events(user_id, stream_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS chat_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    body TEXT
  )`,
    ])
    const missing = `
      async function list() {
        return await this.rows(
          \`SELECT s.id, (SELECT count(*) FROM chat_events e WHERE e.stream_id = s.id) AS n
             FROM chat_streams s WHERE s.user_id = ?1\`,
        )
      }
    `
    expect(referencesIn('planted.ts', missing, plantedSchema).map(describeRef)).toEqual([
      'list() reads chat_events without constraining e.user_id',
    ])

    // Naming the leading column is what the fix did, and the only thing the rule asks for.
    const fixed = missing.replace('WHERE e.stream_id = s.id', 'WHERE e.user_id = s.user_id AND e.stream_id = s.id')
    expect(referencesIn('planted.ts', fixed, plantedSchema).map((ref) => ref.ok)).toEqual([true])

    // A predicate on the key's own column is enough, so this is about reaching an index at all and not
    // about the account column: `chat_notes` is keyed by `id`, and the join names it.
    const byKey = `
      async function lookup() {
        return await this.rows(\`SELECT p.id FROM chat_payloads p JOIN chat_notes n ON n.id = p.note_id\`)
      }
    `
    expect(referencesIn('planted.ts', byKey, plantedSchema).map((ref) => [ref.table, ref.ok])).toEqual([['chat_notes', true]])

    // And a top-level FROM is out of scope, as documented: the statement binds the account itself.
    const topLevel = `
      async function all() {
        return await this.rows(\`SELECT count(*) FROM chat_events WHERE user_id = ?1\`)
      }
    `
    expect(referencesIn('planted.ts', topLevel, plantedSchema)).toEqual([])

    // A `JOIN` at the top level is still read, because a joined fragment never inherits the outer `WHERE`.
    const unscopedJoin = `
      async function joined() {
        return await this.rows(\`SELECT s.id FROM chat_streams s JOIN chat_events e ON e.stream_id = s.id\`)
      }
    `
    expect(referencesIn('planted.ts', unscopedJoin, plantedSchema).map(describeRef)).toEqual([
      'joined() reads chat_events without constraining e.user_id',
    ])
  })
})
