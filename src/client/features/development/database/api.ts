import { CLIENT_HEADER } from '@shared/constants'
import type {
  D1DatabaseInfo,
  DatabaseConnectionInput,
  DatabaseConnectionPatch,
  DatabaseConnectionView,
  DatabaseSettings,
  ExportFormat,
  QueryHistoryEntry,
  QueryResult,
  QueryStatement,
  SavedQuery,
} from '@shared/development/database/types'
import { ApiError, request, routeApiError, type RequestOptions } from '../../../lib/api'
import { getLocale, t } from '../../../lib/i18n'
import type {
  AgentChatMessage,
  AgentStreamEvent,
  AiChatInput,
  AiStatus,
  AiStreamEvent,
  ExportCreateResult,
} from './types'

const BASE = '/api/development/database'

export class DatabaseStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseStreamError'
  }
}

async function requestData<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const payload = await request<{ ok?: boolean; data?: T } | T>(`${BASE}${path}`, options)
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'ok' in payload) {
    const envelope = payload as { ok?: boolean; data?: T }
    if (envelope.ok === false) {
      throw new ApiError(502, 'invalid_response', 'The server rejected the request without an error.')
    }
    return envelope.data as T
  }
  return payload as T
}

export function listConnections(): Promise<DatabaseConnectionView[]> {
  return requestData<DatabaseConnectionView[]>('/connections')
}

export function createConnection(input: DatabaseConnectionInput): Promise<DatabaseConnectionView> {
  return requestData<DatabaseConnectionView>('/connections', {
    method: 'POST',
    body: input,
  })
}

export function updateConnection(
  id: string,
  patch: DatabaseConnectionPatch,
): Promise<DatabaseConnectionView> {
  return requestData<DatabaseConnectionView>(`/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  })
}

export async function deleteConnection(id: string): Promise<void> {
  await requestData<unknown>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function saveConnectionOrder(ids: string[]): Promise<void> {
  await requestData<unknown>('/connections/order', {
    method: 'PUT',
    body: { ids },
  })
}

export function updateConnectionFlags(
  id: string,
  flags: { isFavorite?: boolean; isPinned?: boolean },
): Promise<DatabaseConnectionView> {
  return requestData<DatabaseConnectionView>(`/connections/${encodeURIComponent(id)}/flags`, {
    method: 'PATCH',
    body: flags,
  })
}

export async function listD1Databases(input: {
  accountId?: string
  apiToken?: string
  connectionId?: string
}): Promise<D1DatabaseInfo[]> {
  const data = await requestData<{ databases?: D1DatabaseInfo[] }>('/d1/databases', {
    method: 'POST',
    body: input,
  })
  return data.databases ?? []
}

export function runQuery(
  connectionId: string,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  return requestData<QueryResult>('/query', {
    method: 'POST',
    body: { connectionId, sql, params },
  })
}

export async function runBatch(
  connectionId: string,
  statements: QueryStatement[],
): Promise<QueryResult[]> {
  const data = await requestData<{ results?: QueryResult[] }>('/query/batch', {
    method: 'POST',
    body: { connectionId, statements },
  })
  return data.results ?? []
}

export function listSavedQueries(connectionId: string): Promise<SavedQuery[]> {
  return requestData<SavedQuery[]>(
    `/saved-queries?connectionId=${encodeURIComponent(connectionId)}`,
  )
}

export function createSavedQuery(input: {
  connectionId: string
  name: string
  sql: string
  namespace?: string
}): Promise<SavedQuery> {
  return requestData<SavedQuery>('/saved-queries', {
    method: 'POST',
    body: input,
  })
}

export function updateSavedQuery(
  id: string,
  patch: { name?: string; sql?: string; namespace?: string },
): Promise<SavedQuery> {
  return requestData<SavedQuery>(`/saved-queries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  })
}

export async function deleteSavedQuery(id: string): Promise<void> {
  await requestData<unknown>(`/saved-queries/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listHistory(connectionId: string): Promise<QueryHistoryEntry[]> {
  return requestData<QueryHistoryEntry[]>(
    `/history?connectionId=${encodeURIComponent(connectionId)}`,
  )
}

export async function clearHistory(connectionId: string): Promise<void> {
  await requestData<unknown>(`/history?connectionId=${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
  })
}

export function getSettings(): Promise<DatabaseSettings> {
  return requestData<DatabaseSettings>('/settings')
}

export function updateSettings(historyLimit: number): Promise<DatabaseSettings> {
  return requestData<DatabaseSettings>('/settings', {
    method: 'PUT',
    body: { historyLimit },
  })
}

export function createExport(input: {
  format: ExportFormat
  filename: string
  content: string
}): Promise<ExportCreateResult> {
  return requestData<ExportCreateResult>('/exports', {
    method: 'POST',
    body: input,
  })
}

export async function deleteExport(id: string): Promise<void> {
  await requestData<unknown>(`/exports/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function exportDownloadUrl(id: string): string {
  return `${BASE}/exports/${encodeURIComponent(id)}`
}

export async function fetchExportBlob(id: string): Promise<Blob> {
  const response = await fetch(exportDownloadUrl(id), {
    headers: {
      [CLIENT_HEADER]: '1',
      'Accept-Language': getLocale(),
    },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = await response.json().catch((error) => {
      console.warn('[inkstone] database export error body could not be read', error)
      return null
    })
    throw routeApiError(response.status, body)
  }
  return response.blob()
}

export function getAiStatus(): Promise<AiStatus> {
  return requestData<AiStatus>('/ai/status')
}

export function streamAiChat(
  input: AiChatInput,
  onEvent: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamRequest<AiStreamEvent>('/ai/chat', input, onEvent, signal)
}

export function streamAgentChat(
  messages: AgentChatMessage[],
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamRequest<AgentStreamEvent>('/agent/chat', { messages }, onEvent, signal)
}

export async function streamRequest<T extends { type: string }>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        [CLIENT_HEADER]: '1',
        'Accept-Language': getLocale(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error
    throw new ApiError(0, 'offline', t('api.no_network_connection'))
  }

  if (!response.ok) {
    const failure = await response.json().catch((error) => {
      console.warn('[inkstone] database stream error body could not be read', error)
      return null
    })
    throw routeApiError(response.status, failure)
  }
  if (!response.body) {
    throw new DatabaseStreamError('internal', 'The server returned no stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = (frame: string): void => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new DatabaseStreamError('invalid_stream', 'The server sent a stream frame that could not be parsed.')
    }
    const typed = event as { type?: string; code?: string; message?: string }
    if (typed?.type === 'error') {
      throw new DatabaseStreamError(typed.code ?? 'unknown', typed.message ?? 'The stream failed.')
    }
    onEvent(event as T)
  }

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        emit(frame)
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
    if (buffer.trim()) emit(buffer)
  } finally {
    void reader.cancel().catch((error) => {
      console.warn('[inkstone] database stream could not be cancelled', error)
    })
  }
}
