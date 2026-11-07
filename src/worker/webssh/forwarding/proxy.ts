import type { SSHSession } from '../ssh/session'
import {
  WEBSSH_FORWARD_MAX_PATH_LENGTH,
  WEBSSH_FORWARD_MAX_RESPONSE_BYTES,
  WEBSSH_FORWARD_TIMEOUT_MS,
} from '../constants'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'cache-control',
  'pragma',
  'if-none-match',
  'if-modified-since',
  'range',
])

export class ForwardProxyError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 502) {
    super(message)
    this.name = 'ForwardProxyError'
  }
}

export function isLoopbackTargetHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function normalizeForwardHost(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase()
  if (host.length === 0 || host.length > 255 || /[\0\r\n]/.test(host)) return null
  return host
}

export function normalizeForwardPort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

export function normalizeForwardPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > WEBSSH_FORWARD_MAX_PATH_LENGTH) return null
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) return null
  return value
}

export function isForwardMethod(value: string): boolean {
  return FORWARD_METHODS.has(value.toUpperCase())
}

function requestHead(method: string, path: string, targetHost: string, port: number, headers: Headers, bodyLength: number): string {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${targetHost}:${port}`,
    'Connection: close',
    'Accept-Encoding: identity',
  ]
  for (const [name, value] of headers) {
    if (!REQUEST_HEADERS.has(name.toLowerCase())) continue
    lines.push(`${name}: ${value}`)
  }
  if (bodyLength > 0 || method === 'POST' || method === 'PUT' || method === 'PATCH') {
    lines.push(`Content-Length: ${bodyLength}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function decodeChunked(bytes: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.length) {
    const lineEnd = bytes.indexOf(0x0a, offset)
    if (lineEnd < 0) return null
    const sizeText = new TextDecoder().decode(bytes.subarray(offset, lineEnd)).trim().split(';')[0]
    offset = lineEnd + 1
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return null
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isSafeInteger(size) || size < 0) return null
    if (size === 0) return concat(parts)
    if (offset + size > bytes.length) return null
    parts.push(bytes.subarray(offset, offset + size))
    offset += size
    if (bytes[offset] === 0x0d) offset += 1
    if (bytes[offset] === 0x0a) offset += 1
  }
  return null
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  if (chunks.length === 1) return chunks[0]
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

interface ParsedResponse {
  status: number
  statusText: string
  headers: Headers
  body: Uint8Array
}

function parseResponse(bytes: Uint8Array): ParsedResponse | null {
  const text = new TextDecoder().decode(bytes)
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd < 0) return null
  const lines = text.slice(0, headerEnd).split('\r\n')
  const statusLine = /^HTTP\/(?:1\.0|1\.1) (\d{3})(?: ([^\r\n]*))?/.exec(lines[0] ?? '')
  if (!statusLine) return null
  const status = Number(statusLine[1])
  if (!Number.isInteger(status) || status < 100 || status > 599) return null
  const headers = new Headers()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!name || /[\0\r\n]/.test(name)) continue
    headers.append(name, value)
  }
  let body = bytes.subarray(headerEnd + 4)
  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) {
    body = decodeChunked(body) ?? body
  }
  return { status, statusText: statusLine[2] ?? '', headers, body }
}

export async function forwardHttpRequest(
  session: SSHSession,
  targetHost: string,
  targetPort: number,
  input: { method: string; path: string; headers: Headers; body: Uint8Array },
): Promise<Response> {
  const method = input.method.toUpperCase()
  if (!isForwardMethod(method)) {
    throw new ForwardProxyError('forward_method_blocked', 'That HTTP method is not allowed through a forward', 405)
  }
  const path = normalizeForwardPath(input.path)
  if (!path) throw new ForwardProxyError('invalid_path', 'The forwarded path is invalid', 400)

  const head = requestHead(method, path, targetHost, targetPort, input.headers, method === 'HEAD' ? 0 : input.body.length)
  const payload = new Uint8Array(new TextEncoder().encode(head).length + input.body.length)
  payload.set(new TextEncoder().encode(head), 0)
  payload.set(input.body, head.length)

  const chunks: Uint8Array[] = []
  let received = 0
  let overflow = false
  let settled = false
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const finish = () => {
    if (settled) return
    settled = true
    resolveDone()
  }

  const channel = await session.openForward(targetHost, targetPort, {
    onData: (data) => {
      if (overflow) return
      received += data.length
      if (received > WEBSSH_FORWARD_MAX_RESPONSE_BYTES) {
        overflow = true
        finish()
        return
      }
      chunks.push(data)
    },
    onEof: finish,
    onClose: finish,
  }).catch((error: unknown) => {
    throw new ForwardProxyError('forward_open_failed', error instanceof Error ? error.message : 'The forward channel could not be opened')
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    finish()
  }, WEBSSH_FORWARD_TIMEOUT_MS)
  try {
    await channel.write(payload)
    await done
  } finally {
    clearTimeout(timer)
    await channel.close().catch(() => undefined)
  }

  if (overflow) throw new ForwardProxyError('forward_response_too_large', 'The forwarded response exceeds the size limit')
  if (timedOut) throw new ForwardProxyError('forward_timeout', 'The forwarded request timed out', 504)
  const parsed = parseResponse(concat(chunks))
  if (!parsed) throw new ForwardProxyError('forward_bad_response', 'The forward target did not answer with HTTP')

  const headers = new Headers(parsed.headers)
  headers.delete('set-cookie')
  headers.delete('connection')
  headers.delete('transfer-encoding')
  headers.delete('content-length')
  headers.set('content-length', String(parsed.body.length))
  headers.set('cache-control', 'no-store')

  return new Response(method === 'HEAD' || parsed.status === 204 || parsed.status === 304 ? null : parsed.body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
  })
}
