import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { runSqliteQuery } from './sqlite-query'

type Request =
  | { id: number; type: 'open'; bytes: ArrayBuffer | null }
  | { id: number; type: 'query'; sql: string; params: unknown[] }
  | { id: number; type: 'export' }
  | { id: number; type: 'close' }

type Reply = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage: (message: Reply, transfer?: Transferable[]) => void
  close: () => void
}

let db: SqlJsDatabase | null = null
let sqlPromise: Promise<SqlJsStatic> | null = null

function reply(message: Reply, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer)
}

async function open(bytes: ArrayBuffer | null): Promise<void> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl }).catch((error) => {
      sqlPromise = null
      throw error
    })
  }
  const SQL = await sqlPromise
  db?.close()
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database()
}

async function handle(request: Request): Promise<void> {
  try {
    if (request.type === 'open') {
      await open(request.bytes)
      reply({ id: request.id, ok: true })
      return
    }
    if (request.type === 'query') {
      if (!db) throw new Error('The local database is not open.')
      reply({ id: request.id, ok: true, result: runSqliteQuery(db, request.sql, request.params) })
      return
    }
    if (request.type === 'export') {
      if (!db) throw new Error('The local database is not open.')
      const bytes = db.export()
      reply({ id: request.id, ok: true, result: bytes }, [bytes.buffer])
      return
    }
    db?.close()
    db = null
    reply({ id: request.id, ok: true })
    scope.close()
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

scope.onmessage = (event) => {
  void handle(event.data)
}
