import type { DatabaseSync } from 'node:sqlite'

// D1 hands BLOB columns back as ArrayBuffer while node:sqlite returns a Uint8Array view;
// decoding a typed array element-wise instead of reinterpreting its bytes changes results.
// The realm check is by name: under jsdom `instanceof Uint8Array` can miss node's intrinsics.
function blobToViewable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const name = (value as { constructor?: { name?: string } }).constructor?.name
  if (name === 'Uint8Array' || name === 'Uint8ClampedArray') {
    const view = value as unknown as { slice(): { buffer: ArrayBufferLike } }
    return view.slice().buffer
  }
  return value
}

function toD1Row<T>(row: T): T {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = blobToViewable(value)
  return out as T
}

// The write direction of the same D1/node:sqlite split. D1 binds a bare ArrayBuffer to a BLOB
// column, but node:sqlite only reliably takes a byte view: it rejects an ArrayBuffer in the
// named-parameter object form on every platform, and rejects it positionally too once the test
// runs in the jsdom environment, in both cases with "Provided value cannot be bound to SQLite
// parameter N". A view over the same bytes satisfies D1 and both node:sqlite paths.
function toSqliteParam(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const name = (value as { constructor?: { name?: string } }).constructor?.name
  if (name === 'ArrayBuffer' || name === 'SharedArrayBuffer') {
    return new Uint8Array(value as ArrayBuffer)
  }
  return value
}

/**
 * The verb D1 would judge the statement by.
 *
 * A common-table expression is a prefix, not a statement kind: `WITH subtree AS (…) INSERT …` writes
 * and answers with `meta`, while `WITH subtree AS (…) SELECT …` reads. So the CTE body is skipped by
 * paren depth and the first verb outside it decides — which also means the word inside a literal
 * (`'delete'` written into the changes table) can never win, because the verb always comes first.
 */
function topLevelVerb(sql: string): string | null {
  let depth = 0
  for (const match of sql.matchAll(/[()]|\b(select|insert|update|delete)\b/gi)) {
    const token = match[0]
    if (token === '(') depth++
    else if (token === ')') depth--
    else if (depth === 0) return token.toLowerCase()
  }
  return null
}

export function makeD1(sqlite: DatabaseSync): D1Database {
  // D1 serializes transactions against one database; node:sqlite has a single connection, so two
  // overlapping `batch()` calls would nest BEGINs and fail with an error the platform never returns.
  let batchTail: Promise<unknown> = Promise.resolve()
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), toSqliteParam(value)]))]
        : values.map(toSqliteParam)
      const exec = <T>(method: 'get' | 'all' | 'run'): T => {
        const statement = sqlite.prepare(sql)
        return statement[method](...(args() as never[])) as T
      }
      // node:sqlite happily runs a write through .all(), so the statement kind has to be
      // decided from the SQL text the way D1 does: reads return rows, writes return meta.
      const isRead = topLevelVerb(sql) === 'select' || /^\s*(?:pragma|explain|values)\b/i.test(sql)
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return toD1Row(exec<object | null>('get')) ?? null },
        async all() {
          if (isRead) return { results: (exec<object[]>('all')).map(toD1Row) }
          if (/\breturning\b/i.test(sql)) {
            const rows = (exec<object[]>('all')).map(toD1Row)
            return { results: rows, meta: { changes: rows.length } }
          }
          const row = exec<{ changes: number | bigint; lastInsertRowid?: number | bigint }>('run')
          return { results: [], meta: { changes: Number(row.changes), last_row_id: Number(row.lastInsertRowid ?? 0) } }
        },
        async raw() { return (exec<object[]>('all')).map(toD1Row) },
        async run() {
          const row = exec<{ changes: number | bigint; lastInsertRowid?: number | bigint }>('run')
          return { meta: { changes: Number(row.changes), last_row_id: Number(row.lastInsertRowid ?? 0) } }
        },
      }
      return prepared
    },
    batch(statements: { all(): Promise<{ results: object[] }> }[]) {
      // D1 runs a batch in one transaction: a later failing statement must not leave the
      // earlier writes applied.
      const run = async () => {
        const results = []
        sqlite.exec('BEGIN')
        try {
          for (const statement of statements) results.push(await statement.all())
          sqlite.exec('COMMIT')
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
        return results
      }
      const started = batchTail.then(run, run)
      batchTail = started.then(() => undefined, () => undefined)
      return started
    },
  } as unknown as D1Database
}
