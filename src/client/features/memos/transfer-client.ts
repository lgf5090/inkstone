import { CLIENT_HEADER } from '@shared/constants'
import { MEMOS_API_PREFIX } from '@shared/memos/constants'
import { MEMO_EXPORT_MAX_TOTAL_BYTES } from '@shared/memos/export'
import type {
  MemoImportChunkResult,
  MemoImportConflictPolicy,
  MemoImportPlan,
  MemoImportReport,
  MemoImportSession,
} from '@shared/memos/types'
import { ApiError, CLIENT_ID, routeApiError } from '../../lib/api'
import { getLocale, t } from '../../lib/i18n'
import { memoRequest } from './api'

export const MEMO_IMPORT_ARCHIVE_MAX_BYTES = MEMO_EXPORT_MAX_TOTAL_BYTES

const EXPORT_FALLBACK_FILENAME = 'memos-export.zip'

export interface MemoExportDownload {
  blob: Blob
  filename: string
}

function transferHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
    ...extra,
  }
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'))
}

async function failureBody(response: Response): Promise<unknown> {
  return isJsonResponse(response) ? response.json().catch(() => null) : null
}

async function fetchTransfer(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError(0, 'offline', t('api.no_network_connection'))
  }
}

function decodeFilename(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function exportFilename(disposition: string | null): string {
  if (!disposition) return EXPORT_FALLBACK_FILENAME
  const encoded = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(disposition)?.[1]?.trim()
  if (encoded) {
    const decoded = decodeFilename(encoded.replace(/^"|"$/g, ''))
    if (decoded) return decoded
  }
  const plain = /filename\s*=\s*"([^"\r\n]+)"/i.exec(disposition)?.[1]?.trim()
  return plain || EXPORT_FALLBACK_FILENAME
}

export async function downloadExport(signal?: AbortSignal): Promise<MemoExportDownload> {
  const response = await fetchTransfer(`${MEMOS_API_PREFIX}/export`, {
    headers: transferHeaders(),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw routeApiError(response.status, await failureBody(response))
  return {
    blob: await response.blob(),
    filename: exportFilename(response.headers.get('content-disposition')),
  }
}

export function createImportSession(
  input: { filename: string; totalSize: number },
  signal?: AbortSignal,
): Promise<MemoImportSession> {
  return memoRequest<MemoImportSession>('/import/sessions', {
    method: 'POST',
    body: input,
    signal,
  })
}

export async function uploadImportChunk(
  sessionId: string,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<MemoImportChunkResult> {
  const response = await fetchTransfer(
    `${MEMOS_API_PREFIX}/import/sessions/${encodeURIComponent(sessionId)}?offset=${offset}`,
    {
      method: 'PUT',
      headers: transferHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: chunk,
      credentials: 'same-origin',
      signal,
    },
  )
  if (!response.ok) throw routeApiError(response.status, await failureBody(response))
  const body = await response.json().catch(() => null) as MemoImportChunkResult | null
  if (!body || typeof body.received !== 'number') {
    throw new ApiError(502, 'invalid_response', t('api.invalid_server_response'))
  }
  return body
}

export function planImport(sessionId: string, signal?: AbortSignal): Promise<MemoImportPlan> {
  return memoRequest<MemoImportPlan>(
    `/import/sessions/${encodeURIComponent(sessionId)}/plan`,
    { method: 'POST', signal },
  )
}

export function commitImport(
  sessionId: string,
  conflictPolicy: MemoImportConflictPolicy,
): Promise<MemoImportReport> {
  return memoRequest<MemoImportReport>(
    `/import/sessions/${encodeURIComponent(sessionId)}/commit`,
    { method: 'POST', body: { conflictPolicy } },
  )
}

export function cancelImport(sessionId: string): Promise<{ ok: true }> {
  return memoRequest<{ ok: true }>(
    `/import/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
}

export const memoTransferClient = {
  downloadExport,
  createImportSession,
  uploadImportChunk,
  planImport,
  commitImport,
  cancelImport,
}
