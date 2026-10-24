/**
 * The wire layer: cookie preparation, headers, timeouts, one retry, and a redirect policy narrower
 * than the platform default.
 *
 * Every failure is a result with a status and a body rather than an exception. Network and payload
 * errors still carry a reason in `error`; the client maps those to `MusicProviderError`, so nothing
 * disappears between the upstream and the caller.
 */
import { apiForm, eapi, weapi } from './crypto'

export type NeteaseCryptoMode = 'weapi' | 'eapi' | 'api'
export type NeteaseCookieInput = string | Record<string, string>

export const NETEASE_TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3
const MAX_ERROR_BODY = 500
const RETRY_DELAY_MS = 250

const MUSIC_DOMAIN = 'https://music.163.com'
const API_DOMAIN = 'https://interface.music.163.com'
const REFERER = 'https://music.163.com'

const WEAPI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
const API_UA =
  'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'

export interface NeteaseRequestOptions {
  cookie?: NeteaseCookieInput
  timeoutMs?: number
  /** Extra attempts after the first, only for network failures and 5xx answers. */
  retries?: number
  userAgent?: string
  referer?: string
}

export interface NeteaseResponse<T = Record<string, unknown>> {
  ok: boolean
  status: number
  body: T
  /** Raw `Set-Cookie` lines, so the caller can persist a login without guessing at the format. */
  cookie: string[]
  error: string
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Redirect targets are checked against the hosts Netease actually serves music from. The initial
 * request never comes from user input, but a compromised or misconfigured upstream could still try
 * to bounce this worker somewhere else; only these suffixes are followed.
 */
export function isAllowedNeteaseHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === '163.com' || host === '126.net' || host === '127.net') return true
  return (
    host.endsWith('.163.com') ||
    host.endsWith('.126.net') ||
    host.endsWith('.127.net')
  )
}

export function parseCookie(input: NeteaseCookieInput | undefined): Record<string, string> {
  if (!input) return {}
  if (typeof input !== 'string') return { ...input }
  const cookie: Record<string, string> = {}
  for (const part of input.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name) cookie[name] = value
  }
  return cookie
}

export function cookieToString(cookie: Record<string, string>): string {
  return Object.entries(cookie)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('; ')
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function randomLetters(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    alphabet[byte % alphabet.length],
  ).join('')
}

function randomDeviceId(): string {
  const alphabet = '0123456789ABCDEF'
  return Array.from(crypto.getRandomValues(new Uint8Array(52)), (byte) =>
    alphabet[byte % alphabet.length],
  ).join('')
}

/**
 * Fills the device and client cookies the upstream expects, without inventing a login: `MUSIC_U` is
 * only ever carried in from a real login, and `MUSIC_A` only when the caller supplied one.
 */
export function prepareCookie(input: NeteaseCookieInput | undefined, path: string): Record<string, string> {
  const base = parseCookie(input)
  const now = Date.now()
  const nuid = base._ntes_nuid || randomHex(16)
  const cookie: Record<string, string> = {
    ...base,
    __remember_me: base.__remember_me || 'true',
    ntes_kaola_ad: base.ntes_kaola_ad || '1',
    _ntes_nuid: nuid,
    _ntes_nnid: base._ntes_nnid || `${nuid},${now}`,
    WNMCID: base.WNMCID || `${randomLetters(6)}.${now}.01.0`,
    WEVNSM: base.WEVNSM || '1.0.0',
    osver: base.osver || 'Microsoft-Windows-10-Professional-build-19045-64bit',
    deviceId: base.deviceId || randomDeviceId(),
    os: base.os || 'pc',
    channel: base.channel || 'netease',
    appver: base.appver || '3.1.17.204416',
  }
  if (!path.includes('login')) cookie.NMTID = base.NMTID || randomHex(16)
  return cookie
}

function eapiHeader(cookie: Record<string, string>): Record<string, string> {
  const now = Date.now()
  const header: Record<string, string> = {
    osver: cookie.osver,
    deviceId: cookie.deviceId,
    os: cookie.os,
    appver: cookie.appver,
    versioncode: cookie.versioncode || '140',
    mobilename: cookie.mobilename || '',
    buildver: cookie.buildver || String(now).slice(0, 10),
    resolution: cookie.resolution || '1920x1080',
    __csrf: cookie.__csrf || '',
    channel: cookie.channel,
    requestId: `${now}_${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(4, '0')}`,
  }
  if (cookie.MUSIC_U) header.MUSIC_U = cookie.MUSIC_U
  if (cookie.MUSIC_A) header.MUSIC_A = cookie.MUSIC_A
  return header
}

function encodeBody(mode: NeteaseCryptoMode, path: string, body: Record<string, unknown>) {
  if (mode === 'weapi') return { ...weapi({ ...body, e_r: false }) } as Record<string, string>
  if (mode === 'eapi') return eapi(path, { ...body, e_r: false }) as unknown as Record<string, string>
  return apiForm({ ...body, e_r: false })
}

function endpointFor(mode: NeteaseCryptoMode, path: string): string {
  if (mode === 'weapi') return `${MUSIC_DOMAIN}/weapi/${path.replace(/^\/api\//, '')}`
  if (mode === 'eapi') return `${API_DOMAIN}/eapi/${path.replace(/^\/api\//, '')}`
  return `${API_DOMAIN}${path}`
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function failure(status: number, error: string, body?: unknown): NeteaseResponse {
  return {
    ok: false,
    status,
    body: body && typeof body === 'object' ? (body as Record<string, unknown>) : { code: status, message: error },
    cookie: [],
    error,
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readResponse(response: Response): Promise<NeteaseResponse> {
  const cookie = response.headers.getSetCookie()
  const text = await response.text()
  const parsed = parseJson(text)
  if (!response.ok) {
    const body = parsed ?? { code: response.status, message: text.slice(0, MAX_ERROR_BODY) }
    return { ok: false, status: response.status, body, cookie, error: `Netease responded ${response.status}` }
  }
  if (!parsed) {
    return failure(502, 'Netease returned a non-JSON body', {
      code: 502,
      message: text.slice(0, MAX_ERROR_BODY),
    })
  }
  return { ok: true, status: response.status, body: parsed, cookie, error: '' }
}

function describeFetchError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error))
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const detail = cause?.code || cause?.message
  return new Error(detail ? `${error.message}: ${detail}` : error.message)
}

async function send(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response | Error> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs)
      if (response.status >= 500 && attempt < retries) {
        await response.body?.cancel()
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        continue
      }
      return response
    } catch (error) {
      lastError = describeFetchError(error)
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  return lastError ?? new Error('Netease request failed')
}

export async function requestNetease(
  path: string,
  mode: NeteaseCryptoMode,
  body: Record<string, unknown>,
  options: NeteaseRequestOptions = {},
): Promise<NeteaseResponse> {
  const timeoutMs = options.timeoutMs ?? NETEASE_TIMEOUT_MS
  const retries = options.retries ?? 1
  const cookie = prepareCookie(options.cookie, path)
  const headers: Record<string, string> = {
    Referer: options.referer || REFERER,
    Accept: '*/*',
  }

  let payload: Record<string, string>
  if (mode === 'eapi' || mode === 'api') {
    const header = eapiHeader(cookie)
    headers.Cookie = cookieToString(header)
    headers['User-Agent'] = options.userAgent || API_UA
    payload = encodeBody(mode, path, mode === 'eapi' ? { ...body, header } : body)
  } else {
    headers.Cookie = cookieToString(cookie)
    headers['User-Agent'] = options.userAgent || WEAPI_UA
    payload = encodeBody(mode, path, { ...body, csrf_token: cookie.__csrf || '' })
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded'

  let url = endpointFor(mode, path)
  let method = 'POST'
  let encoded: string | undefined = new URLSearchParams(payload).toString()

  for (let redirects = 0; ; redirects += 1) {
    const response = await send(
      url,
      {
        method,
        headers,
        body: method === 'POST' ? encoded : undefined,
        redirect: 'manual',
      },
      timeoutMs,
      retries,
    )
    if (response instanceof Error) {
      return failure(502, response.message)
    }

    if (!isRedirect(response.status)) return readResponse(response)

    const location = response.headers.get('location')
    if (!location) {
      return failure(502, `Netease redirected without a location (${response.status})`)
    }
    if (redirects >= MAX_REDIRECTS) {
      return failure(502, 'Netease redirected too many times')
    }
    let target: URL
    try {
      target = new URL(location, url)
    } catch {
      return failure(502, 'Netease redirected to an invalid address')
    }
    if (!isAllowedNeteaseHost(target.hostname)) {
      return failure(502, `Netease redirected to a host this client will not follow: ${target.hostname}`)
    }
    await response.body?.cancel()
    url = target.toString()
    if (response.status === 303 || response.status === 301 || response.status === 302) {
      method = 'GET'
      encoded = undefined
    }
  }
}
