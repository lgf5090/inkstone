import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'

export interface TursoStatementResult {
  columns: string[]
  rows: unknown[][]
  rowsAffected?: number
}

export interface TursoQueryOptions {
  url: string
  token: string
  sql: string
  params?: unknown[]
  signal?: AbortSignal
}

export interface TursoBatchOptions {
  url: string
  token: string
  statements: Array<{ sql: string; params?: unknown[] }>
  signal?: AbortSignal
}

export function assertTursoUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('The Turso URL is not a valid URL')
  }
  if (parsed.protocol !== 'libsql:' && parsed.protocol !== 'https:') {
    throw new Error('The Turso URL must use libsql:// or https://')
  }
  if (parsed.username || parsed.password) {
    throw new Error('The Turso URL must not carry credentials')
  }
  if (!parsed.hostname) throw new Error('The Turso URL is not a valid URL')
  const relay = new URL(`https://${parsed.host}${parsed.pathname}${parsed.search}`)
  try {
    assertRelayableEndpoint(relay.toString())
  } catch (error) {
    const reason = error instanceof Error
      ? error.message.replace(/AI provider/g, 'database host')
      : 'the address is not reachable'
    throw new Error(`The Turso URL is not reachable: ${reason}`)
  }
  return parsed.toString()
}

function toStatementResult(result: {
  columns: string[]
  rows: ArrayLike<unknown>
  rowsAffected: number
}): TursoStatementResult {
  const rows: unknown[][] = []
  for (let index = 0; index < result.rows.length; index++) {
    rows.push(Array.from(result.rows[index] as ArrayLike<unknown>))
  }
  return {
    columns: [...result.columns],
    rows,
    rowsAffected: result.rowsAffected,
  }
}

function attachAbortClose(client: { close(): void }, signal?: AbortSignal): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    try {
      client.close()
    } catch (error) {
      console.warn('[inkstone] Closing the Turso client after an abort failed:', error)
    }
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

export async function executeTursoQuery(options: TursoQueryOptions): Promise<TursoStatementResult> {
  assertTursoUrl(options.url)
  const { createClient } = await import('@libsql/client/web')
  const client = createClient({ url: options.url, authToken: options.token })
  const detach = attachAbortClose(client, options.signal)
  try {
    const result = await client.execute({
      sql: options.sql,
      args: (options.params ?? []) as never,
    })
    return toStatementResult(result)
  } finally {
    detach()
    client.close()
  }
}

export async function executeTursoBatch(options: TursoBatchOptions): Promise<TursoStatementResult[]> {
  assertTursoUrl(options.url)
  const { createClient } = await import('@libsql/client/web')
  const client = createClient({ url: options.url, authToken: options.token })
  const detach = attachAbortClose(client, options.signal)
  try {
    const results = await client.batch(
      options.statements.map((statement) => ({
        sql: statement.sql,
        args: (statement.params ?? []) as never,
      })),
      'write',
    )
    return results.map((result) => toStatementResult(result))
  } finally {
    detach()
    client.close()
  }
}
