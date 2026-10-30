/**
 * SQL text helpers shared by the D1 editor and the storage routes.
 *
 * The editor needs to know which statement a caret is in, and the route has to reject writes without
 * trusting the editor's own switch. Both answers depend on the same tokenizer, so it lives here once.
 * The scanner understands strings, comments, parentheses and `CREATE TRIGGER ... BEGIN ... END`
 * bodies; everything else can be answered from its token stream.
 */

const WRITE_VERBS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'REPLACE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'SET',
])

/**
 * The pragmas that only read.
 *
 * `PRAGMA` is both halves of this editor's vocabulary: `table_info` is how a reader inspects a table,
 * while `journal_mode = WAL` or `writable_schema = ON` changes the database. The verb cannot be banned
 * as a whole, so the name decides — and a name nobody listed here is treated as a write, which is the
 * safe direction for a guard that runs before the statement does.
 */
const READ_ONLY_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'encoding',
  'page_count',
  'page_size',
  'freelist_count',
  'integrity_check',
  'quick_check',
])

export interface SqlStatementRange {
  from: number
  to: number
}

export interface SqlColumnDefinition {
  name: string
  type: string
  primaryKey?: boolean
  notNull?: boolean
  defaultValue?: string
}

/** Quote an identifier for SQLite. Only validated identifiers should reach this. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function isSimpleIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

interface ScanState {
  start: number | null
  inString: "'" | '"' | '`' | null
  inLineComment: boolean
  inBlockComment: boolean
  parenDepth: number
  createPending: boolean
  inTrigger: boolean
  beginDepth: number
  caseDepth: number
  word: string
}

function freshState(): ScanState {
  return {
    start: null,
    inString: null,
    inLineComment: false,
    inBlockComment: false,
    parenDepth: 0,
    createPending: false,
    inTrigger: false,
    beginDepth: 0,
    caseDepth: 0,
    word: '',
  }
}

function resetStatementState(state: ScanState): void {
  state.parenDepth = 0
  state.createPending = false
  state.inTrigger = false
  state.beginDepth = 0
  state.caseDepth = 0
  state.word = ''
}

function applyWord(state: ScanState, word: string): void {
  const upper = word.toUpperCase()
  if (state.parenDepth !== 0) return
  if (upper === 'CREATE') {
    state.createPending = true
    return
  }
  if ((upper === 'TEMP' || upper === 'TEMPORARY') && state.createPending) return
  if (upper === 'TRIGGER' && state.createPending) {
    state.inTrigger = true
    state.createPending = false
    return
  }
  state.createPending = false
  if (!state.inTrigger) return
  if (upper === 'CASE') {
    state.caseDepth += 1
  } else if (upper === 'BEGIN') {
    state.beginDepth += 1
  } else if (upper === 'END') {
    if (state.caseDepth > 0) state.caseDepth -= 1
    else if (state.beginDepth > 0) state.beginDepth -= 1
  }
}

function insideTriggerBody(state: ScanState): boolean {
  return state.inTrigger && state.beginDepth > 0
}

/** The ranges of every statement, comments included and the terminal semicolon kept. */
export function scanSqlStatementRanges(sql: string): SqlStatementRange[] {
  const ranges: SqlStatementRange[] = []
  const state = freshState()

  const begin = (index: number) => {
    if (state.start === null) state.start = index
  }
  const flushWord = () => {
    if (!state.word) return
    applyWord(state, state.word)
    state.word = ''
  }

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!
    const next = sql[index + 1]

    if (state.inString) {
      if (char === state.inString) {
        if (next === state.inString) index += 1
        else state.inString = null
      }
      continue
    }
    if (state.inLineComment) {
      if (char === '\n') state.inLineComment = false
      continue
    }
    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false
        index += 1
      }
      continue
    }

    if (char === '-' && next === '-') {
      begin(index)
      state.inLineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      begin(index)
      state.inBlockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      begin(index)
      flushWord()
      state.inString = char
      continue
    }
    if (char === '(') {
      begin(index)
      flushWord()
      state.parenDepth += 1
      continue
    }
    if (char === ')') {
      begin(index)
      flushWord()
      state.parenDepth = Math.max(0, state.parenDepth - 1)
      continue
    }

    if (/[A-Za-z0-9_]/.test(char)) {
      begin(index)
      state.word += char
      continue
    }

    flushWord()
    if (char === ';' && state.parenDepth === 0 && !insideTriggerBody(state)) {
      if (state.start !== null) ranges.push({ from: state.start, to: index + 1 })
      state.start = null
      resetStatementState(state)
      continue
    }
    if (!/\s/.test(char)) begin(index)
  }

  flushWord()
  if (state.start !== null && sql.slice(state.start).trim()) {
    ranges.push({ from: state.start, to: sql.length })
  }
  return ranges
}

/**
 * Split SQL text into statements, keeping trigger bodies intact.
 *
 * A semicolon inside a string, a comment, parentheses or a trigger body does not end a statement.
 */
export function splitSqlStatements(sql: string): string[] {
  return scanSqlStatementRanges(sql)
    .map((range) => sql.slice(range.from, range.to).trim())
    .filter((statement) => statement.length > 0)
}

/** The statement the caret at `position` belongs to; whitespace between statements belongs to the next. */
export function findStatementRangeAt(sql: string, position: number): SqlStatementRange | null {
  if (!Number.isFinite(position) || position < 0 || position > sql.length) return null
  const ranges = scanSqlStatementRanges(sql)
  if (ranges.length === 0) return null
  for (const range of ranges) {
    if (position >= range.from && position < range.to) return range
  }
  const next = ranges.find((range) => position < range.from)
  return next ?? ranges[ranges.length - 1] ?? null
}

interface SqlWord {
  value: string
  depth: number
}

function topLevelWords(statement: string): SqlWord[] {
  const words: SqlWord[] = []
  let inString: "'" | '"' | '`' | null = null
  let inLineComment = false
  let inBlockComment = false
  let depth = 0
  let word = ''
  const flush = () => {
    if (word) words.push({ value: word.toUpperCase(), depth })
    word = ''
  }
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!
    const next = statement[index + 1]
    if (inString) {
      if (char === inString) {
        if (next === inString) index += 1
        else inString = null
      }
      continue
    }
    if (inLineComment) {
      if (char === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') {
      flush()
      inLineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      flush()
      inBlockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      flush()
      inString = char
      continue
    }
    if (char === '(') {
      flush()
      depth += 1
      continue
    }
    if (char === ')') {
      flush()
      depth = Math.max(0, depth - 1)
      continue
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      word += char
      continue
    }
    flush()
  }
  flush()
  return words
}

function statementIsWrite(statement: string): boolean {
  const words = topLevelWords(statement)
  const first = words[0]?.value
  if (!first) return false
  if (first === 'PRAGMA') {
    // `PRAGMA schema.name` puts the schema first; either depth-0 word may be the pragma's own name.
    const names = [words[1]?.value, words[2]?.value].filter((name): name is string => Boolean(name))
    return !names.some((name) => READ_ONLY_PRAGMAS.has(name.toLowerCase()))
  }
  if (WRITE_VERBS.has(first)) return true
  if (first === 'WITH' || first === 'EXPLAIN') {
    return words.some((word) => word.depth === 0 && WRITE_VERBS.has(word.value))
  }
  return false
}

/** Whether the text contains any statement that changes data or schema. */
export function isWriteSql(sql: string): boolean {
  return splitSqlStatements(sql).some(statementIsWrite)
}

function statementIsDestructive(statement: string): boolean {
  const top = topLevelWords(statement)
    .filter((word) => word.depth === 0)
    .map((word) => word.value)
  if (top.some((word) => word === 'DROP' || word === 'TRUNCATE')) return true
  const dml = top.find((word) => word === 'DELETE' || word === 'UPDATE')
  return dml !== undefined && !top.includes('WHERE')
}

/** Whether the text contains a statement that can lose rows or an object outright. */
export function isDestructiveSql(sql: string): boolean {
  return splitSqlStatements(sql).some(statementIsDestructive)
}

/** Whether the text contains a statement that changes the schema (which a browser has to reload). */
export function isSchemaChangeSql(sql: string): boolean {
  return splitSqlStatements(sql).some((statement) => {
    const first = topLevelWords(statement).find((word) => word.depth === 0)?.value
    return first === 'CREATE' || first === 'ALTER' || first === 'DROP'
  })
}

/** The CREATE TABLE text the table builder previews and executes. */
export function buildCreateTableSql(
  tableName: string,
  columns: readonly SqlColumnDefinition[],
): string {
  const definitions = columns
    .filter((column) => column.name.trim())
    .map((column) => {
      let line = `  ${quoteIdent(column.name.trim())} ${column.type}`
      if (column.primaryKey) line += ' PRIMARY KEY AUTOINCREMENT'
      if (column.notNull && !column.primaryKey) line += ' NOT NULL'
      if (column.defaultValue?.trim()) line += ` DEFAULT ${column.defaultValue.trim()}`
      return line
    })
  return `CREATE TABLE ${quoteIdent(tableName.trim())} (\n${definitions.join(',\n')}\n);`
}
