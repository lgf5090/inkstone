/**
 * The client side of Model Context Protocol over Streamable HTTP.
 *
 * Three requests, in this order, per session: `initialize` (which hands back a session id we must echo on
 * every later call), `notifications/initialized`, then `tools/list` or `tools/call`. A server may answer any
 * of them either as a plain JSON body or as one `event: message` SSE frame, so both shapes are read here —
 * reading only JSON is what makes a working server look offline.
 *
 * The URL is the reader's own text and this module is the only place it is fetched from the worker, so the
 * address check below is the SSRF boundary. It is a literal check: a Worker cannot resolve a name before
 * fetching it, so a public hostname pointing at a private address is the one case this cannot catch, and
 * that limit is stated rather than papered over.
 */
import { MAX_MCP_TOOL_NAME_CHARS, MAX_MCP_TOOLS_PER_SERVER, type AssistantMcpTool } from '@shared/assistant'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_NAME = 'Inkstone Assistant'
/** A listing must come back fast: the composer opens it while the reader is still looking at the input. */
const LIST_TIMEOUT_MS = 8_000
/** A tool call can legitimately take longer — a fetch of third-party docs, a build. */
const CALL_TIMEOUT_MS = 30_000
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

/** Names the model is offered must survive three upstreams' identifier rules, so they are rebuilt here. */
export function mcpToolName(serverId: string, remoteName: string): string {
  const owner = serverId.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()
  const clean = remoteName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_MCP_TOOL_NAME_CHARS - 8)
  return `mcp_${owner}_${clean}`.slice(0, MAX_MCP_TOOL_NAME_CHARS)
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
  sessionId?: string
}

let nextId = 1

async function rpc(session: McpSession, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const id = nextId++
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
export async function mcpInitialize(baseUrl: string, headers: Record<string, string>): Promise<McpSession> {
  const session: McpSession = { baseUrl, headers }
  await rpc(session, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1' },
  }, LIST_TIMEOUT_MS)
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
  const result = await rpc(session, 'tools/list', {}, LIST_TIMEOUT_MS) as { tools?: unknown } | null
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
  const result = await rpc(session, 'tools/call', { name: remoteName, arguments: args }, CALL_TIMEOUT_MS)
  const body = flattenMcpContent(result)
  // A tool that returns nothing still has to be answerable, or the model repeats the call forever.
  return body || 'The tool returned no content.'
}

/** One round trip for the settings screen's "test" button. */
export async function mcpProbe(baseUrl: string, headers: Record<string, string>, serverId: string, label: string): Promise<McpFetchResult & { tools?: AssistantMcpTool[] }> {
  const problem = mcpUrlProblem(baseUrl)
  if (problem) return { ok: false, status: 0, error: problem }
  try {
    const session = await mcpInitialize(baseUrl, headers)
    const listing = await mcpListTools(session, serverId, label)
    return { ok: true, status: 200, error: '', tools: listing.tools }
  } catch (error) {
    const message = error instanceof McpError ? error.message : 'The server could not be reached.'
    return { ok: false, status: error instanceof McpError ? error.status : 0, error: message }
  }
}
