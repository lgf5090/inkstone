import type { QueryResult } from '@shared/development/database/types'
import { runQuery, runBatch, MAX_BATCH_STATEMENTS } from './api'

export interface StudioQueryOptions {
  recordHistory?: boolean
}

export interface StudioDriver {
  readonly type: 'd1' | 'turso' | 'sqlite'
  readonly label: string
  query(sql: string, params?: unknown[], options?: StudioQueryOptions): Promise<QueryResult>
  batch?(statements: string[]): Promise<void>
  exportFile?(): Promise<Uint8Array>
  close(): void
}

export type DriverSource =
  | { kind: 'remote'; connectionId: string; type: 'd1' | 'turso'; label: string }
  | { kind: 'local'; label: string; file?: File }

export function createDriver(source: DriverSource): StudioDriver {
  if (source.kind === 'local') {
    return typeof Worker === 'function'
      ? new SqliteWorkerDriver(source.file, source.label)
      : new LazyMemorySqliteDriver(source.file, source.label)
  }
  return new RemoteDriver(source.connectionId, source.type, source.label)
}

export class RemoteDriver implements StudioDriver {
  constructor(
    private readonly connectionId: string,
    readonly type: 'd1' | 'turso',
    readonly label: string,
  ) {}

  query(sql: string, params: unknown[] = [], options?: StudioQueryOptions): Promise<QueryResult> {
    return runQuery(this.connectionId, sql, params, options?.recordHistory === true)
  }

  async batch(statements: string[]): Promise<void> {
    for (let index = 0; index < statements.length; index += MAX_BATCH_STATEMENTS) {
      await runBatch(
        this.connectionId,
        statements.slice(index, index + MAX_BATCH_STATEMENTS).map((sql) => ({ sql })),
      )
    }
  }

  close(): void {}
}

export const MAX_LOCAL_SQLITE_FILE_BYTES = 100 * 1024 * 1024

export const LOCAL_SQLITE_FILE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3'] as const

export function isLocalSqliteFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return LOCAL_SQLITE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

interface WorkerReply {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class SqliteWorkerDriver implements StudioDriver {
  readonly type = 'sqlite' as const

  private worker: Worker | null = null
  private pending = new Map<number, PendingRequest>()
  private seq = 0
  private opened: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly file: File | undefined,
    readonly label: string,
  ) {
    if (file && file.size > MAX_LOCAL_SQLITE_FILE_BYTES) {
      throw new Error('The SQLite file is larger than the 100 MB limit.')
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.result)
      else pending.reject(new Error(reply.error ?? 'The local database request failed.'))
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The local database worker failed.')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
    this.worker = worker
    return worker
  }

  private request<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The local database is closed.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.ensureWorker().postMessage({ ...message, id }, transfer)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private ensureOpen(): Promise<void> {
    if (!this.opened) {
      this.opened = (async () => {
        const buffer = this.file ? await this.file.arrayBuffer() : null
        await this.request({ type: 'open', bytes: buffer }, buffer ? [buffer] : [])
      })()
      this.opened.catch((error) => {
        console.warn('[inkstone] local SQLite worker could not open', error)
      })
    }
    return this.opened
  }

  async query(sql: string, params: unknown[] = [], _options?: StudioQueryOptions): Promise<QueryResult> {
    await this.ensureOpen()
    return this.request<QueryResult>({ type: 'query', sql, params })
  }

  async batch(statements: string[]): Promise<void> {
    for (const sql of statements) await this.query(sql)
  }

  async exportFile(): Promise<Uint8Array> {
    await this.ensureOpen()
    const bytes = await this.request<Uint8Array>({ type: 'export' })
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer)
  }

  close(): void {
    this.closed = true
    const worker = this.worker
    this.worker = null
    if (worker) {
      try {
        worker.postMessage({ id: 0, type: 'close' })
      } catch (error) {
        console.warn('[inkstone] local SQLite worker could not be told to close', error)
      }
      worker.terminate()
    }
    const error = new Error('The local database is closed.')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

class LazyMemorySqliteDriver implements StudioDriver {
  readonly type = 'sqlite' as const
  private impl: Promise<import('./sqlite-memory').MemorySqliteDriver> | null = null

  constructor(
    private readonly file: File | undefined,
    readonly label: string,
  ) {
    if (file && file.size > MAX_LOCAL_SQLITE_FILE_BYTES) {
      throw new Error('The SQLite file is larger than the 100 MB limit.')
    }
  }

  private load(): Promise<import('./sqlite-memory').MemorySqliteDriver> {
    this.impl ??= import('./sqlite-memory').then((module) => new module.MemorySqliteDriver(this.file, this.label))
    return this.impl
  }

  async query(sql: string, params: unknown[] = [], options?: StudioQueryOptions): Promise<QueryResult> {
    return (await this.load()).query(sql, params, options)
  }

  async batch(statements: string[]): Promise<void> {
    return (await this.load()).batch(statements)
  }

  async exportFile(): Promise<Uint8Array> {
    return (await this.load()).exportFile()
  }

  close(): void {
    void this.impl?.then((driver) => driver.close()).catch((error) => {
      console.warn('[inkstone] local SQLite fallback could not be closed', error)
    })
  }
}
