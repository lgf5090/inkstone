import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Database as SqlJsDatabase } from 'sql.js'
import type { QueryResult } from '@shared/development/database/types'
import { isWriteSql } from '@shared/development/database/sql-utils'
import { runSqliteQuery } from './sqlite-query'
import type { StudioDriver, StudioQueryOptions, StudioStatement } from './drivers'

export class MemorySqliteDriver implements StudioDriver {
  readonly type = 'sqlite' as const

  private db: SqlJsDatabase | null = null
  private initPromise: Promise<SqlJsDatabase> | null = null
  private closed = false
  private dirty = false

  constructor(
    private readonly file: File | undefined,
    readonly label: string,
  ) {}

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

  async query(sql: string, params: unknown[] = [], _options?: StudioQueryOptions): Promise<QueryResult> {
    const result = runSqliteQuery(await this.getDb(), sql, params)
    if (isWriteSql(sql)) this.dirty = true
    return result
  }

  async exportFile(): Promise<Uint8Array> {
    const db = await this.getDb()
    return db.export()
  }

  async batch(statements: string[]): Promise<void> {
    return this.transaction(statements.map((sql) => ({ sql })))
  }

  async transaction(statements: StudioStatement[], options?: StudioQueryOptions): Promise<void> {
    const db = await this.getDb()
    if (options?.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      for (const statement of statements) {
        runSqliteQuery(db, statement.sql, statement.params ?? [])
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        console.warn('[inkstone] local SQLite transaction rollback failed:', rollbackError)
      }
      if (options?.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON')
      throw error
    }
    if (options?.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON')
    if (statements.some((statement) => isWriteSql(statement.sql))) this.dirty = true
  }

  isDirty(): boolean {
    return this.dirty
  }

  markSaved(): void {
    this.dirty = false
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
