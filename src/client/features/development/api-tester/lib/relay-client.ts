import type {
  AuthConfig,
  HttpRequestConfig,
  ProxyResponse,
  RequestKind,
  ResponseResult,
} from '@shared/development/api-tester/types'
import { sendProxy } from '../api'
import { resolveVariable, type Variable } from './variables'

export interface ExecuteOptions {
  variables: Variable[]
  followRedirects: boolean
  timeoutMs: number
  kind: RequestKind
  signal?: AbortSignal
}

export interface ResolvedRequest {
  method: string
  url: string
  headers: Array<{ key: string; value: string }>
  body: string | null
  bodyFileId?: string
}

export class RelayClientError extends Error {
  constructor(readonly code: 'url_required' | 'url_protocol' | 'cancelled', message: string) {
    super(message)
    this.name = 'RelayClientError'
  }
}

function resolveAuth(auth: AuthConfig, variables: readonly Variable[]): AuthConfig {
  return {
    ...auth,
    token: resolveVariable(auth.token, variables),
    username: resolveVariable(auth.username, variables),
    password: resolveVariable(auth.password, variables),
    keyName: resolveVariable(auth.keyName, variables),
    keyValue: resolveVariable(auth.keyValue, variables),
    oauth2: auth.oauth2
      ? { ...auth.oauth2, accessToken: resolveVariable(auth.oauth2.accessToken, variables) }
      : undefined,
  }
}

export function buildResolvedRequest(
  config: HttpRequestConfig,
  variables: readonly Variable[],
  kind: RequestKind,
): ResolvedRequest {
  const headers: Array<{ key: string; value: string }> = []
  const seen = new Set<string>()
  const pushHeader = (key: string, value: string) => {
    const lower = key.toLowerCase()
    const index = headers.findIndex((header) => header.key.toLowerCase() === lower)
    if (index >= 0) {
      headers[index] = { key, value }
      return
    }
    seen.add(lower)
    headers.push({ key, value })
  }
  for (const header of config.headers) {
    if (header.enabled && header.key.trim()) {
      pushHeader(resolveVariable(header.key, variables), resolveVariable(header.value, variables))
    }
  }

  const params: Array<[string, string]> = []
  for (const param of config.params) {
    if (param.enabled && param.key.trim()) {
      params.push([resolveVariable(param.key, variables), resolveVariable(param.value, variables)])
    }
  }

  const auth = resolveAuth(config.auth, variables)
  if (auth.type === 'bearer' && auth.token) {
    pushHeader('Authorization', `Bearer ${auth.token}`)
  } else if (auth.type === 'basic') {
    const raw = `${auth.username}:${auth.password}`
    try {
      pushHeader('Authorization', `Basic ${btoa(raw)}`)
    } catch {
      pushHeader('Authorization', `Basic ${raw}`)
    }
  } else if (auth.type === 'apikey-header' && auth.keyName) {
    pushHeader(auth.keyName, auth.keyValue)
  } else if (auth.type === 'oauth2' && auth.oauth2?.accessToken) {
    pushHeader('Authorization', `${auth.oauth2.tokenType || 'Bearer'} ${auth.oauth2.accessToken}`)
  }

  let body: string | null = null
  let bodyFileId: string | undefined
  let method = config.method

  if (kind === 'graphql') {
    let graphqlVariables: unknown = null
    try {
      graphqlVariables = config.graphqlVariables ? JSON.parse(resolveVariable(config.graphqlVariables, variables)) : null
    } catch {
      graphqlVariables = config.graphqlVariables || null
    }
    body = JSON.stringify({ query: resolveVariable(config.graphqlQuery, variables), variables: graphqlVariables }, null, 2)
    method = 'POST'
    pushHeader('Content-Type', 'application/json')
  } else {
    switch (config.bodyType) {
      case 'json':
        body = resolveVariable(config.body, variables)
        if (body && !seen.has('content-type')) pushHeader('Content-Type', 'application/json')
        break
      case 'raw':
        body = resolveVariable(config.body, variables)
        break
      case 'form-urlencoded': {
        const parts: string[] = []
        for (const field of config.formFields) {
          if (field.enabled && field.key) {
            parts.push(`${encodeURIComponent(resolveVariable(field.key, variables))}=${encodeURIComponent(resolveVariable(field.value, variables))}`)
          }
        }
        body = parts.join('&')
        if (!seen.has('content-type')) pushHeader('Content-Type', 'application/x-www-form-urlencoded')
        break
      }
      case 'form-data': {
        const parts: string[] = []
        for (const field of config.formFields) {
          if (field.enabled && field.key) {
            parts.push(`${encodeURIComponent(resolveVariable(field.key, variables))}=${encodeURIComponent(resolveVariable(field.value, variables))}`)
          }
        }
        body = parts.join('&')
        if (!seen.has('content-type')) pushHeader('Content-Type', 'application/x-www-form-urlencoded')
        break
      }
      case 'binary':
        bodyFileId = config.bodyFileId
        if (!bodyFileId) body = resolveVariable(config.body, variables) || null
        break
      case 'none':
      default:
        body = null
    }
  }

  let url = resolveVariable(config.url, variables)
  if (params.length > 0 || auth.type === 'apikey-query') {
    const parsed = new URL(url, window.location.origin)
    for (const [key, value] of params) parsed.searchParams.set(key, value)
    if (auth.type === 'apikey-query' && auth.keyName) parsed.searchParams.set(auth.keyName, auth.keyValue)
    url = parsed.toString()
  }

  return { method: method.toUpperCase(), url, headers, body, bodyFileId }
}

function toResponse(data: ProxyResponse): ResponseResult {
  return {
    status: data.status,
    statusText: data.statusText,
    headers: data.headers,
    contentType: data.contentType,
    sizeBytes: data.sizeBytes,
    durationMs: data.durationMs,
    body: data.body ?? '',
    bodyB64: data.bodyB64,
    redirected: data.redirected,
    url: data.url,
    error: data.error,
    cookies: data.cookies,
    timing: data.timing,
  }
}

export async function executeRequest(config: HttpRequestConfig, options: ExecuteOptions): Promise<ResponseResult> {
  const resolved = buildResolvedRequest(config, options.variables, options.kind)
  if (!resolved.url) throw new RelayClientError('url_required', 'The request URL is empty')
  if (!/^https?:\/\//i.test(resolved.url)) throw new RelayClientError('url_protocol', 'The request URL must start with http:// or https://')
  try {
    const response = await sendProxy(
      {
        method: resolved.method as HttpRequestConfig['method'],
        url: resolved.url,
        headers: resolved.headers,
        body: resolved.body ?? undefined,
        bodyFileId: resolved.bodyFileId,
        redirect: options.followRedirects ? 'follow' : 'manual',
        timeoutMs: options.timeoutMs,
      },
      options.signal,
    )
    return toResponse(response)
  } catch (error) {
    if (options.signal?.aborted) throw new RelayClientError('cancelled', 'The request was cancelled')
    throw error
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function tryPrettifyJson(text: string): { ok: boolean; result: string } {
  if (!text) return { ok: false, result: text }
  try {
    return { ok: true, result: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { ok: false, result: text }
  }
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
