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

export function makeD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
        : values
      const exec = <T>(method: 'get' | 'all' | 'run'): T => {
        const statement = sqlite.prepare(sql)
        return statement[method](...(args() as never[])) as T
      }
      // node:sqlite happily runs a write through .all(), so the statement kind has to be
      // decided from the SQL text the way D1 does: reads return rows, writes return meta.
      const isRead = /^\s*(?:select|with|pragma|explain|values)\b/i.test(sql)
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return toD1Row(exec<object | null>('get')) ?? null },
        async all() {
          if (isRead) return { results: (exec<object[]>('all')).map(toD1Row) }
          if (/\breturning\b/i.test(sql)) {
            const rows = (exec<object[]>('all')).map(toD1Row)
            return { results: rows, meta: { changes: rows.length } }
          }
          const row = exec<{ changes: number | bigint }>('run')
          return { results: [], meta: { changes: Number(row.changes) } }
        },
        async raw() { return (exec<object[]>('all')).map(toD1Row) },
        async run() {
          return { meta: { changes: Number(exec<{ changes: number | bigint }>('run').changes) } }
        },
      }
      return prepared
    },
    async batch(statements: { all(): Promise<{ results: object[] }> }[]) {
      // D1 runs a batch in one transaction: a later failing statement must not leave the
      // earlier writes applied.
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
    },
  } as unknown as D1Database
}
