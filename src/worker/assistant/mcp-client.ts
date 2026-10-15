/**
 * The client side of Model Context Protocol, over either of the two HTTP transports.
 *
 * Streamable HTTP is three requests, in this order, per session: `initialize` (which hands back a session id
 * we must echo on every later call), `notifications/initialized`, then `tools/list` or `tools/call`. A server
 * may answer any of them either as a plain JSON body or as one `event: message` SSE frame, so both shapes
 * are read here — reading only JSON is what makes a working server look offline.
 *
 * The older SSE transport inverts that: one `GET` stays open, its first event names the address to post to,
 * and the answers come back on the stream instead of in the POST's own body. It is implemented in
 * `sseRpc`, one stream per call, and the reason is there.
 *
 * The URL is the reader's own text (or, in the SSE handshake, the server's) and this module is the only
 * place it is fetched from the worker, so the address check below is the SSRF boundary. It is a literal
 * check: a Worker cannot resolve a name before fetching it, so a public hostname pointing at a private
 * address is the one case this cannot catch, and that limit is stated rather than papered over.
 */
import {
  DEFAULT_MCP_TIMEOUT_SECONDS,
  MAX_MCP_TOOLS_PER_SERVER,
  mcpToolName,
  type AssistantMcpTool,
  type AssistantMcpTransport,
} from '@shared/assistant'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_NAME = 'Inkstone Assistant'
/**
 * What one request to a third party may take.
 *
 * The reader's own setting, because the right number depends on the server: a documentation search is slow
 * and a note index is not, and a constant here made the slow one unfixable from the screen that added it.
 */
const timeoutMsFor = (seconds: number | undefined): number => Math.round((seconds ?? DEFAULT_MCP_TIMEOUT_SECONDS) * 1000)
const MAX_RESPONSE_BYTES = 512 * 1024

export interface McpFetchResult {
  ok: boolean
  status: number
  /** A short, safe reason when `ok` is false: never the upstream body, which can carry the key. */
  error: string
}

export class McpError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'McpError'
  }
}

const PRIVATE_HOSTS = [
  /^127\./,
  /^localhost$/i,
  /^.*\.(local|internal|intranet|localdomain)$/i,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  /^metadata\.(google\.internal|internal)$/i,
  /^100\.64\./,
]

/**
 * Whether this URL may be fetched at all.
 *
 * https is required, and no address inside a network is fetched at all: this runs on the platform, so a
 * reader's own laptop is not what a loopback address would reach, and the platform's own services are
 * exactly what must stay out of reach. A local MCP server is used through a tunnel, like any third party.
 */
export function mcpUrlProblem(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return 'No address was given.'
  if (trimmed.length > 2048) return 'That address is too long.'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'That is not a valid URL.'
  }
  if (url.protocol !== 'https:') return 'The address has to be https.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (PRIVATE_HOSTS.some((pattern) => pattern.test(host))) {
    return 'That address points inside the network, which the worker will not fetch.'
  }
  return null
}

/** Which namespaced name belongs to which remote call. */
export function mcpToolIndex(tools: readonly AssistantMcpTool[]): Map<string, AssistantMcpTool> {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

interface JsonRpcEnvelope {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number, message?: string }
}

/**
 * Pull one JSON-RPC envelope out of whatever the server sent.
 *
 * Streamable HTTP servers answer with `text/event-stream` even for a single response, so the SSE frames are
 * unwrapped first. A response that carries more than one envelope is only usable if one of them answers our
 * id — a notification that slipped in must not be mistaken for the reply.
 */
export function parseMcpBody(text: string, expectId: number): JsonRpcEnvelope | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!trimmed.includes('data:')) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope
    } catch {
      return null
    }
  }
  const envelopes: JsonRpcEnvelope[] = []
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (!data) continue
    try {
      envelopes.push(JSON.parse(data) as JsonRpcEnvelope)
    } catch {
      // A keep-alive or a comment frame; nothing to answer with.
    }
  }
  return envelopes.find((entry) => entry.id === expectId) ?? envelopes.find((entry) => entry.result !== undefined || entry.error !== undefined) ?? null
}

/** The text a tool produced, flattened. Images and resources are named, never inlined as base64. */
export function flattenMcpContent(result: unknown): string {
  const record = (result ?? {}) as { content?: unknown, isError?: boolean }
  const parts = Array.isArray(record.content) ? record.content : []
  const lines = parts.map((entry) => {
    const item = (entry ?? {}) as { type?: string, text?: string, name?: string, resource?: { uri?: string } }
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    if (item.type === 'image') return '[an image was returned; this assistant does not show tool pictures]'
    if (item.type === 'resource') return `[resource: ${item.resource?.uri ?? 'unknown'}]`
    return `[${item.type ?? 'content'}${item.name ? `: ${item.name}` : ''}]`
  })
  const body = lines.join('\n').trim()
  return record.isError ? `The tool reported an error:\n${body || '(no detail)'}` : body
}

async function readBody(response: Response): Promise<string> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new McpError('The server returned more than 512 kB.')
  return text
}

export interface McpSession {
  baseUrl: string
  headers: Record<string, string>
  /**
   * Which of the two shapes this server speaks.
   *
   * Held on the session because every call after the handshake has to be made the same way, and only the
   * session knows whether "the handshake" meant a session id to echo or a stream to open.
   */
  transport: AssistantMcpTransport
  sessionId?: string
  /** The reader's own deadline for one answer from this server. */
  timeoutMs?: number
}

export interface SseFrame {
  event: string
  data: string
}

/**
 * One `event: message` SSE frame, read off a stream one at a time.
 *
 * A frame may arrive split across chunks and two may arrive in one, so the bytes are buffered and cut at the
 * blank line that ends a frame; a line starting with `:` is a comment, which is also what every keep-alive
 * looks like, and is dropped.
 */
function sseFrame(block: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return null
  return { event, data: data.join('\n') }
}

class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private queue: SseFrame[] = []

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader()
  }

  /** The next frame, or null once the server has closed the stream. */
  async next(): Promise<SseFrame | null> {
    for (;;) {
      const queued = this.queue.shift()
      if (queued) return queued
      const { value, done } = await this.reader.read()
      if (done) return null
      this.buffer += this.decoder.decode(value, { stream: true })
      const blocks = this.buffer.split(/\r?\n\r?\n/)
      // The last piece is an unfinished frame, so it stays buffered rather than being parsed short.
      this.buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const frame = sseFrame(block)
        if (frame) this.queue.push(frame)
      }
    }
  }

  /** Let go of the connection. A stream left open holds one of the worker's few sockets for nothing. */
  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined)
  }
}

function envelopeOf(data: string): JsonRpcEnvelope | null {
  try {
    return JSON.parse(data) as JsonRpcEnvelope
  } catch {
    return null
  }
}

/**
 * The address the server tells us to post to, from the stream's first event.
 *
 * It arrives as a path as often as a full URL, so it is resolved against the stream's own address. It is
 * also the one address on this path that the *server* chose, which is why it goes through the same check as
 * the reader's own: a server must not be able to point the worker at the network it runs inside.
 */
async function endpointOf(stream: SseStream, baseUrl: string): Promise<string> {
  for (;;) {
    const frame = await stream.next()
    if (!frame) throw new McpError('The server closed its event stream before naming where to post.')
    if (frame.event !== 'endpoint' || !frame.data.trim()) continue
    let resolved: string
    try {
      resolved = new URL(frame.data.trim(), baseUrl).toString()
    } catch {
      throw new McpError('The server named an endpoint that is not an address.')
    }
    const problem = mcpUrlProblem(resolved)
    if (problem) throw new McpError(`The server named an endpoint this app will not call. ${problem}`)
    return resolved
  }
}

/** One `POST` of the SSE transport, whose answer arrives on the stream rather than in its body. */
async function ssePost(session: McpSession, url: string, body: unknown, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...session.headers },
    body: JSON.stringify(body),
  })
  if (response.status === 401 || response.status === 403) throw new McpError('The server refused the credentials.', response.status)
  if (!response.ok) throw new McpError(`The server answered ${response.status}.`, response.status)
  return await response.text()
}

/** The answer to one request id, off the stream: envelopes meant for something else are skipped. */
async function replyOn(stream: SseStream, id: number): Promise<JsonRpcEnvelope> {
  for (;;) {
    const frame = await stream.next()
    if (!frame) throw new McpError('The server closed its event stream before it answered.')
    if (frame.event !== 'message') continue
    const envelope = envelopeOf(frame.data)
    if (!envelope) continue
    if (envelope.id !== id) continue
    return envelope
  }
}

/**
 * One SSE round trip: open the stream, do the handshake on it, make the call, let go of the stream.
 *
 * A stream per call rather than one held for the session, because the transport gives every stream its own
 * session and a worker has nowhere to keep a connection open between a listing and a call that happens
 * minutes later — the alternative is a socket nobody closes. The cost is the handshake repeated per call,
 * which is what the transport asks for anyway: a stream the server was never initialized on is not a
 * session. The handshake is not sent for `initialize` itself.
 */
async function sseRpc(session: McpSession, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? session.timeoutMs ?? DEFAULT_MCP_TIMEOUT_SECONDS * 1000)
  let stream: SseStream | null = null
  try {
    // A `GET` with no body: this request is the session, and the server answers it by opening a stream.
    const response = await fetch(session.baseUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'text/event-stream', ...session.headers },
    })
    if (response.status === 401 || response.status === 403) throw new McpError('The server refused the credentials.', response.status)
    if (!response.ok || !response.body) throw new McpError(`The server answered ${response.status} instead of an event stream.`, response.status)
    stream = new SseStream(response.body)
    const postUrl = await endpointOf(stream, session.baseUrl)
    if (method !== 'initialize') {
      const initId = nextId++
      const initBody = await ssePost(session, postUrl, {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: '1' } },
      }, controller.signal)
      const postedInit = envelopeOf(initBody)
      const initReply = postedInit && postedInit.id === initId ? postedInit : await replyOn(stream, initId)
      if (initReply.error) throw new McpError(`The server said: ${String(initReply.error.message ?? 'unknown error').slice(0, 200)}`)
      // The notification has no reply. A 202 is the expected answer and anything else is ignored, because
      // the server has already accepted us by now.
      await ssePost(session, postUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, controller.signal).catch(() => undefined)
    }
    const id = nextId++
    const body = await ssePost(session, postUrl, { jsonrpc: '2.0', id, method, params }, controller.signal)
    // A server may answer in the POST's own body; the ones that do not leave it empty and put the reply on
    // the stream. Reading both is what keeps a working server from looking offline.
    const posted = envelopeOf(body)
    const envelope = posted && posted.id === id ? posted : await replyOn(stream, id)
    if (envelope.error) throw new McpError(`The server said: ${String(envelope.error.message ?? 'unknown error').slice(0, 200)}`)
    return envelope.result
  } catch (error) {
    if (error instanceof McpError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new McpError('The server took too long to answer.')
    throw new McpError('The address could not be reached.')
  } finally {
    clearTimeout(timer)
    await stream?.close()
  }
}

let nextId = 1

async function rpc(session: McpSession, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  if (session.transport === 'sse') return await sseRpc(session, method, params, timeoutMs)
  const id = nextId++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? session.timeoutMs ?? DEFAULT_MCP_TIMEOUT_SECONDS * 1000)
  try {
    const response = await fetch(session.baseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...session.headers,
        ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    if (response.status === 404 && session.sessionId) throw new McpError('The session expired; try again.', 404)
    if (response.status === 401 || response.status === 403) throw new McpError('The server refused the credentials.', response.status)
    if (!response.ok) throw new McpError(`The server answered ${response.status}.`, response.status)
    const sessionHeader = response.headers.get('mcp-session-id')
    if (sessionHeader) session.sessionId = sessionHeader
    if (response.status === 202) return null
    const envelope = parseMcpBody(await readBody(response), id)
    if (!envelope) throw new McpError('The server did not answer the request.')
    if (envelope.error) throw new McpError(`The server said: ${String(envelope.error.message ?? 'unknown error').slice(0, 200)}`)
    return envelope.result
  } catch (error) {
    if (error instanceof McpError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new McpError('The server took too long to answer.')
    throw new McpError('The address could not be reached.')
  } finally {
    clearTimeout(timer)
  }
}

/** Open a session: the handshake every later call depends on. */
export async function mcpInitialize(
  baseUrl: string,
  headers: Record<string, string>,
  timeoutSeconds = DEFAULT_MCP_TIMEOUT_SECONDS,
  transport: AssistantMcpTransport = 'streamableHttp',
): Promise<McpSession> {
  const session: McpSession = { baseUrl, headers, transport, timeoutMs: timeoutMsFor(timeoutSeconds) }
  // An SSE server is handshaken inside every call's own stream, so there is nothing to do here: the first
  // listing is what proves the address, and it fails with the server's own reason if it cannot be reached.
  if (transport === 'sse') return session
  await rpc(session, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1' },
  })
  // The notification has no id and no reply; a 202 is the expected answer and anything else is ignored,
  // because every server that matters has already accepted us by now.
  try {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers, ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined)
  } catch {
    // A server that rejects the notification still answers tool calls.
  }
  return session
}

export interface McpToolListing {
  tools: AssistantMcpTool[]
  /** The raw JSON Schema per namespaced name, which is what the model is told about arguments. */
  schemas: Record<string, Record<string, unknown>>
  truncated: boolean
}

export async function mcpListTools(session: McpSession, serverId: string, serverLabel: string): Promise<McpToolListing> {
  const result = await rpc(session, 'tools/list', {}) as { tools?: unknown } | null
  const raw = Array.isArray(result?.tools) ? result.tools : []
  const tools: AssistantMcpTool[] = []
  const schemas: Record<string, Record<string, unknown>> = {}
  for (const entry of raw.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
    const tool = (entry ?? {}) as { name?: unknown, description?: unknown, inputSchema?: unknown }
    const remoteName = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (!remoteName) continue
    const name = mcpToolName(serverId, remoteName)
    tools.push({
      name,
      remoteName,
      serverId,
      serverLabel,
      description: (typeof tool.description === 'string' ? tool.description : '').slice(0, 400),
    })
    schemas[name] = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema as Record<string, unknown>
      : { type: 'object', properties: {} }
  }
  return { tools, schemas, truncated: raw.length > MAX_MCP_TOOLS_PER_SERVER }
}

export async function mcpCallTool(session: McpSession, remoteName: string, args: Record<string, unknown>): Promise<string> {
  const result = await rpc(session, 'tools/call', { name: remoteName, arguments: args })
  const body = flattenMcpContent(result)
  // A tool that returns nothing still has to be answerable, or the model repeats the call forever.
  return body || 'The tool returned no content.'
}

/** One round trip for the settings screen's "test" button. */
export async function mcpProbe(
  baseUrl: string,
  headers: Record<string, string>,
  serverId: string,
  label: string,
  timeoutSeconds = DEFAULT_MCP_TIMEOUT_SECONDS,
  transport: AssistantMcpTransport = 'streamableHttp',
): Promise<McpFetchResult & { tools?: AssistantMcpTool[] }> {
  const problem = mcpUrlProblem(baseUrl)
  if (problem) return { ok: false, status: 0, error: problem }
  try {
    const session = await mcpInitialize(baseUrl, headers, timeoutSeconds, transport)
    const listing = await mcpListTools(session, serverId, label)
    return { ok: true, status: 200, error: '', tools: listing.tools }
  } catch (error) {
    const message = error instanceof McpError ? error.message : 'The server could not be reached.'
    return { ok: false, status: error instanceof McpError ? error.status : 0, error: message }
  }
}
