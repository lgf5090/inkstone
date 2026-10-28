const TRIGGER_KEYWORDS = new Set(['CREATE', 'TRIGGER', 'BEGIN', 'END'])

interface TriggerState {
  inTrigger: boolean
  beginDepth: number
}

function updateTriggerState(
  upper: string,
  prevWord: string,
  state: TriggerState,
): { state: TriggerState; prevWord: string } {
  if (upper === 'CREATE') return { state, prevWord: 'CREATE' }
  if (upper === 'TRIGGER' && prevWord === 'CREATE') {
    return { state: { inTrigger: true, beginDepth: state.beginDepth }, prevWord: '' }
  }
  if (upper === 'BEGIN' && state.inTrigger) {
    return { state: { inTrigger: true, beginDepth: state.beginDepth + 1 }, prevWord: '' }
  }
  if (upper === 'END' && state.beginDepth > 0) {
    return { state: { inTrigger: state.inTrigger, beginDepth: state.beginDepth - 1 }, prevWord: '' }
  }
  return { state, prevWord: '' }
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString: "'" | '"' | '`' | null = null
  let inLineComment = false
  let inBlockComment = false
  let parenDepth = 0
  let trigger: TriggerState = { inTrigger: false, beginDepth: 0 }
  let prevWord = ''
  let word = ''

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (inString) {
      current += ch
      if (ch === inString) {
        if (next === inString) {
          current += next
          i++
        } else {
          inString = null
        }
      }
      continue
    }
    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += '/'
        i++
        inBlockComment = false
      }
      continue
    }
    if (ch === '-' && next === '-') {
      inLineComment = true
      current += ch
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      current += ch
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch
      current += ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      current += ch
      continue
    }
    if (ch === ')') {
      parenDepth--
      current += ch
      continue
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      word += ch
      current += ch
      continue
    }
    if (word) {
      const upper = word.toUpperCase()
      word = ''
      if (parenDepth === 0 && TRIGGER_KEYWORDS.has(upper)) {
        const nextState = updateTriggerState(upper, prevWord, trigger)
        trigger = nextState.state
        prevWord = nextState.prevWord
      } else {
        prevWord = ''
      }
    }
    if (ch === ';' && parenDepth === 0 && !(trigger.inTrigger && trigger.beginDepth > 0)) {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      trigger = { inTrigger: false, beginDepth: 0 }
      prevWord = ''
      continue
    }
    current += ch
  }

  if (word) {
    const upper = word.toUpperCase()
    if (parenDepth === 0 && TRIGGER_KEYWORDS.has(upper)) {
      const nextState = updateTriggerState(upper, prevWord, trigger)
      trigger = nextState.state
      prevWord = nextState.prevWord
    }
  }
  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)
  return statements
}

export function findStatementRangeAt(sql: string, pos: number): { from: number; to: number } | null {
  let inString: "'" | '"' | '`' | null = null
  let inLineComment = false
  let inBlockComment = false
  let parenDepth = 0
  let trigger: TriggerState = { inTrigger: false, beginDepth: 0 }
  let word = ''
  let prevWord = ''
  let stmtStart: number | null = null
  const segments: Array<{ from: number; to: number }> = []

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (inString) {
      if (ch === inString) {
        if (next === inString) i++
        else inString = null
      }
      continue
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        i++
        inBlockComment = false
      }
      continue
    }
    if (ch === '-' && next === '-') {
      if (stmtStart === null) stmtStart = i
      inLineComment = true
      continue
    }
    if (ch === '/' && next === '*') {
      if (stmtStart === null) stmtStart = i
      inBlockComment = true
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (stmtStart === null) stmtStart = i
      inString = ch
      continue
    }
    if (ch === '(') {
      parenDepth++
      continue
    }
    if (ch === ')') {
      parenDepth--
      continue
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      if (stmtStart === null) stmtStart = i
      word += ch
      continue
    }
    if (word) {
      const upper = word.toUpperCase()
      word = ''
      if (parenDepth === 0 && TRIGGER_KEYWORDS.has(upper)) {
        const nextState = updateTriggerState(upper, prevWord, trigger)
        trigger = nextState.state
        prevWord = nextState.prevWord
      } else {
        prevWord = ''
      }
    }
    if (ch === ';' && parenDepth === 0 && !(trigger.inTrigger && trigger.beginDepth > 0)) {
      if (stmtStart !== null) segments.push({ from: stmtStart, to: i + 1 })
      stmtStart = null
      trigger = { inTrigger: false, beginDepth: 0 }
      prevWord = ''
      continue
    }
    if (stmtStart === null && !/\s/.test(ch)) stmtStart = i
  }

  if (word) {
    const upper = word.toUpperCase()
    if (parenDepth === 0 && TRIGGER_KEYWORDS.has(upper)) {
      const nextState = updateTriggerState(upper, prevWord, trigger)
      trigger = nextState.state
      prevWord = nextState.prevWord
    }
  }
  if (stmtStart !== null && sql.slice(stmtStart).trim()) {
    segments.push({ from: stmtStart, to: sql.length })
  }
  for (const segment of segments) {
    if (pos >= segment.from && pos < segment.to) return segment
  }
  for (const segment of segments) {
    if (pos < segment.from) return segment
  }
  return null
}

function leadingStatement(sql: string): string {
  let text = sql.trimStart()
  for (;;) {
    if (text.startsWith('--')) {
      const end = text.indexOf('\n')
      text = end < 0 ? '' : text.slice(end + 1).trimStart()
      continue
    }
    if (text.startsWith('/*')) {
      const end = text.indexOf('*/', 2)
      text = end < 0 ? '' : text.slice(end + 2).trimStart()
      continue
    }
    if (text.startsWith('(')) {
      text = text.slice(1).trimStart()
      continue
    }
    return text
  }
}

export function isWriteSql(sql: string): boolean {
  const head = leadingStatement(sql).toUpperCase()
  return (
    head.startsWith('INSERT')
    || head.startsWith('UPDATE')
    || head.startsWith('DELETE')
    || head.startsWith('DROP')
    || head.startsWith('ALTER')
    || head.startsWith('CREATE')
    || head.startsWith('REPLACE')
    || head.startsWith('VACUUM')
    || head.startsWith('REINDEX')
    || head.startsWith('ANALYZE')
    || head.startsWith('PRAGMA')
  )
}

export function isSchemaChangeSql(sql: string): boolean {
  const head = leadingStatement(sql).toUpperCase()
  return head.startsWith('CREATE') || head.startsWith('ALTER') || head.startsWith('DROP')
}

export function isDestructiveSql(sql: string): boolean {
  const text = leadingStatement(sql).toUpperCase()
  if (/^(?:TRUNCATE\b|DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER|SCHEMA|DATABASE)\b)/.test(text)) return true
  if (/^DELETE\s+FROM\b/.test(text)) return !/\bWHERE\b/.test(text)
  if (/^UPDATE\s+(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|\S+)\s+SET\b/.test(text)) return !/\bWHERE\b/.test(text)
  return false
}
