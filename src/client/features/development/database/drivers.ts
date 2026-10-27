import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Database as SqlJsDatabase, SqlValue } from 'sql.js'
import type { QueryResult } from '@shared/development/database/types'
import { runQuery } from './api'

export interface StudioDriver {
  readonly type: 'd1' | 'turso' | 'sqlite'
  readonly label: string
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): void
}

export type DriverSource =
  | { kind: 'remote'; connectionId: string; type: 'd1' | 'turso'; label: string }
  | { kind: 'local'; label: string; file?: File }

export function createDriver(source: DriverSource): StudioDriver {
  if (source.kind === 'local') return new SqliteDriver(source.file, source.label)
  return new RemoteDriver(source.connectionId, source.type, source.label)
}

export class RemoteDriver implements StudioDriver {
  constructor(
    private readonly connectionId: string,
    readonly type: 'd1' | 'turso',
    readonly label: string,
  ) {}

  query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    return runQuery(this.connectionId, sql, params)
  }

  close(): void {}
}

export const MAX_LOCAL_SQLITE_FILE_BYTES = 100 * 1024 * 1024

export const LOCAL_SQLITE_FILE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3'] as const

export function isLocalSqliteFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return LOCAL_SQLITE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function affectsRows(sql: string): boolean {
  const head = sql.trimStart().toUpperCase()
  if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)) return true
  return head.startsWith('WITH') && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)
}

function bindParams(params: unknown[]): SqlValue[] {
  return params.map((value) => (value === undefined ? null : (value as SqlValue)))
}

export class SqliteDriver implements StudioDriver {
  readonly type = 'sqlite' as const

  private db: SqlJsDatabase | null = null
  private initPromise: Promise<SqlJsDatabase> | null = null
  private closed = false

  constructor(
    private readonly file: File | undefined,
    readonly label: string,
  ) {
    if (file && file.size > MAX_LOCAL_SQLITE_FILE_BYTES) {
      throw new Error('The SQLite file is larger than the 100 MB limit.')
    }
  }

  private getDb(): Promise<SqlJsDatabase> {
    if (this.closed) return Promise.reject(new Error('The local database is closed.'))
    if (this.db) return Promise.resolve(this.db)
    if (!this.initPromise) {
      const init = (async () => {
        const module = await import('sql.js')
        const initSqlJs = module.default
        const SQL = await initSqlJs({ locateFile: () => wasmUrl })
        const db = this.file
          ? new SQL.Database(new Uint8Array(await this.file.arrayBuffer()))
          : new SQL.Database()
        if (this.closed) {
          db.close()
          throw new Error('The local database is closed.')
        }
        this.db = db
        return db
      })()
      this.initPromise = init.catch((error) => {
        this.initPromise = null
        throw error
      })
    }
    return this.initPromise
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const db = await this.getDb()
    const started = Date.now()
    const statement = db.prepare(sql)
    try {
      if (params.length > 0) statement.bind(bindParams(params))
      const columns = statement.getColumnNames()
      const rows: unknown[][] = []
      while (statement.step()) rows.push(statement.get())
      const rowsAffected = affectsRows(sql) ? db.getRowsModified() : 0
      return { columns, rows, rowsAffected, durationMs: Date.now() - started }
    } finally {
      statement.free()
    }
  }

  close(): void {
    this.closed = true
    const db = this.db
    this.db = null
    this.initPromise = null
    if (!db) return
    try {
      db.close()
    } catch (error) {
      console.warn('[inkstone] local SQLite database could not be closed', error)
    }
  }
}
