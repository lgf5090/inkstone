import type { DatabaseSync } from 'node:sqlite'

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
        async first() { return exec<object | null>('get') ?? null },
        async all() {
          if (isRead) return { results: exec<object[]>('all') }
          if (/\breturning\b/i.test(sql)) {
            const rows = exec<object[]>('all')
            return { results: rows, meta: { changes: rows.length } }
          }
          const row = exec<{ changes: number | bigint }>('run')
          return { results: [], meta: { changes: Number(row.changes) } }
        },
        async raw() { return exec<object[]>('all') },
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
