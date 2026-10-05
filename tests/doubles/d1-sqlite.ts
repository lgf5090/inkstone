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
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return exec<object | null>('get') ?? null },
        async all() {
          try {
            return { results: exec<object[]>('all') }
          } catch {
            exec('run')
            return { results: [] }
          }
        },
        async raw() { return exec<object[]>('all') },
        async run() {
          return { meta: { changes: Number(exec<{ changes: number | bigint }>('run').changes) } }
        },
      }
      return prepared
    },
    async batch(statements: { all(): Promise<{ results: object[] }> }[]) {
      const results = []
      for (const statement of statements) results.push(await statement.all())
      return results
    },
  } as unknown as D1Database
}
