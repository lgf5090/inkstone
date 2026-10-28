import { CLIENT_HEADER } from '@shared/constants'
import type {
  ApiTesterFile,
  ApiTesterSaveResponse,
  ApiTesterStateResponse,
  FileKind,
  HistoryEntry,
  OAuthTokenRequest,
  OAuthTokenResponse,
  ProxyRequest,
  ProxyResponse,
  Workspace,
  WsTicketResponse,
} from '@shared/development/api-tester/types'
import { ApiError, request, routeApiError, type RequestOptions } from '../../../lib/api'
import { getLocale } from '../../../lib/i18n'

const BASE = '/api/development/api-tester'

function data<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`${BASE}${path}`, options)
}

export function listWorkspaces(): Promise<Workspace[]> {
  return data<Workspace[]>('/workspaces')
}

export function createWorkspace(name: string, color: string): Promise<{ workspace: Workspace; workspaces: Workspace[] }> {
  return data('/workspaces', { method: 'POST', body: { name, color } })
}

export function updateWorkspace(id: string, patch: { name?: string; color?: string }): Promise<Workspace[]> {
  return data(`/workspaces/${encodeURIComponent(id)}`, { method: 'PUT', body: patch })
}

export function deleteWorkspace(id: string): Promise<Workspace[]> {
  return data(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getState(workspaceId: string): Promise<ApiTesterStateResponse> {
  return data(`/state?workspaceId=${encodeURIComponent(workspaceId)}`)
}

export function putState(workspaceId: string, rev: number, payload: unknown): Promise<ApiTesterSaveResponse> {
  return data('/state', { method: 'PUT', body: { workspaceId, rev, data: payload } })
}

export function listHistory(workspaceId: string): Promise<HistoryEntry[]> {
  return data(`/history?workspaceId=${encodeURIComponent(workspaceId)}`)
}

export function appendHistory(workspaceId: string, entry: HistoryEntry): Promise<{ ok: true }> {
  return data('/history', {
    method: 'POST',
    body: { workspaceId, entry: { id: entry.id, ts: entry.ts, data: entry } },
  })
}

export function clearHistory(workspaceId: string): Promise<{ ok: true }> {
  return data(`/history?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
}

export function sendProxy(payload: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse> {
  return data('/proxy', {
    method: 'POST',
    body: payload,
    signal,
    timeoutMs: payload.timeoutMs + 10_000,
  })
}

export function exchangeOAuthToken(payload: OAuthTokenRequest): Promise<OAuthTokenResponse> {
  return data('/oauth2/token', { method: 'POST', body: payload, timeoutMs: 20_000 })
}

export function createWsTicket(url: string, headers: Array<{ key: string; value: string }>): Promise<WsTicketResponse> {
  return data('/ws-tickets', { method: 'POST', body: { url, headers } })
}

export function listFiles(kind?: FileKind): Promise<ApiTesterFile[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return data(`/files${query}`)
}

export function uploadFile(file: File | Blob, kind: FileKind, name: string): Promise<ApiTesterFile> {
  const form = new FormData()
  form.append('file', file, name)
  form.append('kind', kind)
  form.append('name', name)
  return data('/files', { method: 'POST', formData: form, timeoutMs: 60_000 })
}

export function uploadText(text: string, kind: FileKind, name: string, contentType: string): Promise<ApiTesterFile> {
  return uploadFile(new Blob([text], { type: contentType }), kind, name)
}

export async function deleteFile(id: string): Promise<void> {
  await data(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function fileUrl(id: string): string {
  return `${BASE}/files/${encodeURIComponent(id)}`
}

export async function fetchFileText(id: string): Promise<string> {
  const response = await fetch(fileUrl(id), {
    headers: {
      [CLIENT_HEADER]: '1',
      'Accept-Language': getLocale(),
    },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = await response.json().catch((error) => {
      console.warn('[inkstone] API Tester file error body could not be read', error)
      return null
    })
    throw routeApiError(response.status, body)
  }
  return response.text()
}

export function errorStatus(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
