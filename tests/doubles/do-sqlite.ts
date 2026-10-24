import type { DatabaseSync } from 'node:sqlite'
import type { SqlExec } from '../../src/worker/email/mailbox-schema'

export function makeSqlExec(db: DatabaseSync): SqlExec {
  return {
    exec<T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Iterable<T> {
      const text = sql.trim()
      if (!bindings.length && /;\s*\S/.test(text)) {
        db.exec(sql)
        return []
      }
      const statement = db.prepare(sql)
      if (/^\s*(?:select|with)\b/i.test(text)) {
        return statement.all(...bindings as never[]) as T[]
      }
      statement.run(...bindings as never[])
      return []
    },
  }
}
