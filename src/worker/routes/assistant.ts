/**
 * The assistant's HTTP API.
 *
 * Everything lives under `/api/assistant` and behind the app's own session, so the assistant inherits
 * the sign-in, the CSRF posture and the per-account scoping instead of inventing a second one — the
 * reference project had to build all of that itself because it was a standalone deployment.
 *
 * Two things never leave this file: the provider API key, which is decrypted only inside the worker to
 * sign one upstream call, and the model's instructions, which are assembled server-side so a reader's
 * own client cannot edit the rules about what the assistant may touch.
 */

import { Hono, type Context } from 'hono'
import {
  ASSISTANT_MEMORY_CATEGORIES,
  ASSISTANT_MCP_TOOL_MODES,
  ASSISTANT_MCP_TRANSPORTS,
  ASSISTANT_MODEL_KINDS,
  MAX_TOKEN_CEILING,
  MAX_MCP_DESCRIPTION_CHARS,
  MAX_MCP_DISABLED_TOOLS,
  MAX_MCP_HEADERS,
  MAX_MCP_HEADER_VALUE_CHARS,
  MAX_MCP_LABEL_CHARS,
  MAX_MCP_TIMEOUT_SECONDS,
  MIN_MCP_TIMEOUT_SECONDS,
  isMcpHeaderName,
  mcpToolOrigin,
  MAX_MCP_SERVERS,
  MAX_MCP_TOOL_NAME_CHARS,
  MAX_MCP_URL_CHARS,
  endpointFieldState,
  parseModelModalities,
  type AssistantMcpTransport,
  ASSISTANT_MODEL_PURPOSES,
  ASSISTANT_PROTOCOLS,
  ASSISTANT_TOOL_SPECS,
  parseCustomParams,
  MAX_TURN_SCOPES,
  MAX_TURN_TOOLS,
  AUTOMATION_KINDS,
  MAX_AUTOMATION_MESSAGE_CHARS,
  MAX_CONVERSATION_TITLE_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CONTENT_CHARS,
  MAX_PROMPT_TITLE_CHARS,
  MAX_TASK_NOTES_CHARS,
  MAX_TASK_TITLE_CHARS,
  MEMORY_REVIEW_ACTIONS,
  MESSAGE_FEEDBACK,
  type MessageFeedback,
  ASSISTANT_SETTING_KEYS,
  normalizeAssistantSettings,
  titleFromMessage,
  type AssistantMemoryCategory,
  type AssistantProtocol,
  type AssistantTurnScope,
  type MemoryReviewAction,
  type TaskPriority,
  type TaskStatus,
  type AssistantKeyUsage,
  type AssistantModel,
  type UsageFilter,
} from '@shared/assistant'
import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { localDayBounds, parseLocalTime } from '@shared/assistant-time'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { FORM_BODY_LIMITS, JSON_BODY_LIMITS, readFormDataWithinLimit, readJson, readStreamWithinLimit } from '../lib/request'
import { McpError, mcpCallTool, mcpInitialize, mcpListTools, mcpProbe, mcpUrlProblem } from '../assistant/mcp-client'
import { isExternalToolName, listMcpCatalog, loadExternalTools } from '../assistant/mcp-tools'
import { finishMcpAuthorization, startMcpAuthorization, withMcpOAuthHeaders } from '../assistant/mcp-oauth'
import { isValidId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { AssistantStore, dayBefore, usageDay } from '../assistant/store'
import { MemoryHistoryService } from '../assistant/memory-service'
import { AutomationService } from '../assistant/automations'
import { AssistantRunner } from '../assistant/runner'
import { cancelApprovedAction, runApprovedAction } from '../assistant/tools'
import { exportAssistant, importAssistant } from '../assistant/backup'
import { ChatShareStore, conversationSharePasswordHash, type ChatShareRow } from '../assistant/share'
import { suggestActiveModel } from '../assistant/model-config'
import { listVendorModels } from '../assistant/vendor-models'
import { memoryEmbeddingStatus, reindexMemoryEmbeddings, semanticModel } from '../assistant/semantic'
import { MAX_PROVIDER_MODELS, reasoningDialectValue, reasoningValue } from '@shared/assistant'
import {
  CHAT_IMAGE_MAX_BYTES,
  ChatUploadError,
  deleteChatObject,
  readChatObject,
  saveChatUpload,
} from '../assistant/chat-files'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { formatBytes } from '@shared/byte-format'

/**
 * Reads a stream up to a ceiling, so a remote server cannot decide how much memory this request uses.
 *
 * A refused attachment is the caller's mistake in sending a URL that big, not a payload the API
 * cannot accept, so this answers `400` rather than the `413` the request-body reader uses.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  const bytes = await readStreamWithinLimit(body, maxBytes)
  if (bytes === null) throw ApiError.badRequest(`That file is larger than ${formatBytes(maxBytes)}.`)
  return bytes
}

/** A context budget is the reader's own choice from the composer's slider; null means 'use the global limit'. */
/**
 * A per-model context budget in tokens.
 *
 * The ceiling is the hardware-sized one, not the composer's chip list: capping here at the largest chip
 * (262K) silently rewrote a 1M model's own window down to a quarter of what it is, and the reader had no
 * way to see it — the field showed the number they typed until the page was reloaded.
 */
function contextBudgetValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(MAX_TOKEN_CEILING, Math.trunc(number))
}
import { resolveNoteScope } from '../assistant/note-scope'

export const assistantRoutes = new Hono<AppBindings>()

assistantRoutes.use('*', requireAuth)

/**
 * Hono types the request context as only what a middleware can see; workerd hands over the full
 * `ExecutionContext`, so the widening cast here is a type-level statement about the platform, not a
 * runtime one.
 */
function executionContext(c: Context<AppBindings>): ExecutionContext {
  return c.executionCtx as unknown as ExecutionContext
}

function store(c: Context<AppBindings>): AssistantStore {
  return new AssistantStore(c.env.DB, c.get('userId'), c.env)
}


/** A prompt field: trimmed and capped, and empty is allowed here because the pair is checked together. */
function optionalPromptText(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  return value.trim().slice(0, max)
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest('This cannot be empty.')
  return trimmed.slice(0, max)
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  return value.trim().slice(0, max)
}

function requiredId(value: unknown): string {
  if (!isValidId(value)) throw ApiError.notFound('Not found')
  return value
}

/** The end of the reader's local day, so "today" is theirs and not the server's. */
function readerDayEnd(timezone: string): number {
  return localDayBounds(timezone).end
}

// -------------------------------------------------------------- conversations

assistantRoutes.get('/conversations', async (c) => {
  const query = c.req.query('q')?.trim().slice(0, 200)
  const folder = c.req.query('folder')
  const project = c.req.query('project')
  const tag = c.req.query('tag')?.trim().slice(0, 26)
  const filter: { folderId?: string | null, projectId?: string | null, tagId?: string, starred?: boolean, pinned?: boolean } = {}
  // `folder=none` is the unfiled view; an absent parameter is the whole list.
  if (folder !== undefined) filter.folderId = folder === 'none' ? null : (isValidId(folder) ? folder : 'none')
  // `project=none` reads the conversations that answer under no brief, the same convention as the folder filter.
  if (project !== undefined) filter.projectId = project === 'none' ? null : (isValidId(project) ? project : 'none')
  if (tag) filter.tagId = tag
  if (c.req.query('starred') === '1') filter.starred = true
  if (c.req.query('pinned') === '1') filter.pinned = true
  return c.json({ conversations: await store(c).listConversations(query || undefined, filter) })
})

/** The note folder tree, with how many conversations each folder holds. */
assistantRoutes.get('/folders', async (c) => c.json(await store(c).conversationFolderSummary()))

/** The reader's tags with conversation counts, so the filter row can hide what labels nothing. */
assistantRoutes.get('/tags', async (c) => {
  const s = store(c)
  const [tags, counts] = await Promise.all([s.conversationTags(), s.conversationTagCounts()])
  return c.json({ tags: tags.map((tag) => ({ ...tag, count: counts.get(tag.id) ?? 0 })) })
})

assistantRoutes.post('/conversations', async (c) => {
  const body = await readJson<{ title?: unknown, folderId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const title = body.title === undefined ? '' : text(body.title, MAX_CONVERSATION_TITLE_CHARS)
  const s = store(c)
  let folderId: string | null = null
  if (typeof body.folderId === 'string') {
    if (!isValidId(body.folderId) || !(await s.knownFolder(body.folderId))) throw ApiError.badRequest('Unknown folder.')
    folderId = body.folderId
  }
  return c.json({ conversation: await s.createConversation(title, folderId) }, 201)
})

// ------------------------------------------------------------------ external MCP servers

/**
 * The reader's own third-party MCP servers.
 *
 * Two rules hold here. The stored token is never read back — the listing only says whether one is stored —
 * and the address is checked before anything is fetched, because this is the one place the worker is asked
 * to reach a URL a person typed.
 */
assistantRoutes.get('/mcp', async (c) => c.json({ servers: await store(c).listMcpServers() }))

/**
 * The fields a server's own form sets, validated once for the three routes that accept them.
 *
 * The header values are the one secret here, so they arrive as an object rather than as text the client
 * parsed: a name the wire cannot carry is refused by name, and the count is bounded because every header
 * travels on every request this server is asked for.
 */
function mcpServerFields(body: Record<string, unknown>): {
  description?: string
  transport?: AssistantMcpTransport
  timeoutSeconds?: number
  headers?: Record<string, string> | null
} {
  const out: ReturnType<typeof mcpServerFields> = {}
  if (body.description !== undefined) out.description = text(body.description, MAX_MCP_DESCRIPTION_CHARS)
  const transport = pickValue(body.transport, ASSISTANT_MCP_TRANSPORTS)
  if (transport !== undefined) out.transport = transport
  if (body.timeoutSeconds !== undefined) {
    const seconds = Number(body.timeoutSeconds)
    if (!Number.isFinite(seconds)) throw ApiError.badRequest('The timeout has to be a number of seconds.')
    out.timeoutSeconds = Math.min(Math.max(Math.round(seconds), MIN_MCP_TIMEOUT_SECONDS), MAX_MCP_TIMEOUT_SECONDS)
  }
  if (body.headers !== undefined) {
    if (body.headers === null) out.headers = null
    else if (typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      const entries = Object.entries(body.headers as Record<string, unknown>)
      if (entries.length > MAX_MCP_HEADERS) throw ApiError.badRequest(`At most ${MAX_MCP_HEADERS} headers can be stored.`)
      const headers: Record<string, string> = {}
      for (const [name, value] of entries) {
        if (!isMcpHeaderName(name)) throw ApiError.badRequest(`"${name}" cannot be sent as a header name.`)
        if (typeof value !== 'string') throw ApiError.badRequest(`The value of "${name}" has to be text.`)
        headers[name] = value.slice(0, MAX_MCP_HEADER_VALUE_CHARS)
      }
      out.headers = headers
    } else {
      throw ApiError.badRequest('headers has to be an object of name and value pairs.')
    }
  }
  return out
}

assistantRoutes.post('/mcp', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const label = text(body.label, MAX_MCP_LABEL_CHARS)
  const url = text(body.url, MAX_MCP_URL_CHARS).replace(/\s+/g, '')
  const problem = mcpUrlProblem(url)
  if (problem) throw ApiError.badRequest(problem)
  if ((await s.listMcpServers()).length >= MAX_MCP_SERVERS) {
    throw ApiError.conflict(`At most ${MAX_MCP_SERVERS} servers can be configured.`)
  }
  const server = await s.createMcpServer({
    label,
    url,
    ...mcpServerFields(body),
    toolMode: pickValue(body.toolMode, ASSISTANT_MCP_TOOL_MODES) ?? 'ask',
  })
  return c.json({ server }, 201)
})

assistantRoutes.patch('/mcp/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  let url: string | undefined
  if (body.url !== undefined) {
    url = text(body.url, MAX_MCP_URL_CHARS).replace(/\s+/g, '')
    const problem = mcpUrlProblem(url)
    if (problem) throw ApiError.badRequest(problem)
  }
  // The off-list is the server's own tool names, so it is only ever a list of bounded strings: the model
  // is never handed a name this route invented, and a name the server does not offer simply stops matching.
  let disabledTools: string[] | undefined
  if (body.disabledTools !== undefined) {
    if (!Array.isArray(body.disabledTools)) throw ApiError.badRequest('disabledTools must be an array')
    if (body.disabledTools.length > MAX_MCP_DISABLED_TOOLS) {
      throw ApiError.badRequest(`At most ${MAX_MCP_DISABLED_TOOLS} tools can be switched off`)
    }
    disabledTools = body.disabledTools
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => Boolean(entry) && entry.length <= MAX_MCP_TOOL_NAME_CHARS)
  }
  const updated = await s.updateMcpServer(id, {
    ...(body.label !== undefined ? { label: text(body.label, MAX_MCP_LABEL_CHARS) } : {}),
    ...(url === undefined ? {} : { url }),
    ...mcpServerFields(body),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(pickValue(body.toolMode, ASSISTANT_MCP_TOOL_MODES) !== undefined ? { toolMode: pickValue(body.toolMode, ASSISTANT_MCP_TOOL_MODES) } : {}),
    ...(disabledTools === undefined ? {} : { disabledTools }),
  })
  if (!updated) throw ApiError.notFound('Server not found')
  return c.json({ server: updated })
})

assistantRoutes.delete('/mcp/:id', async (c) => {
  const removed = await store(c).deleteMcpServer(requiredId(c.req.param('id')))
  if (!removed) throw ApiError.notFound('Server not found')
  return c.json({ ok: true })
})

/**
 * The settings screen's "test" button: connect, handshake, list.
 *
 * The token is taken from the stored row when the body does not carry a new one, so a reader can test what
 * they already saved without retyping it — and the response still never echoes it back.
 */
assistantRoutes.post('/mcp/:id/test', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const record = await s.mcpServerRecord(id)
  if (!record) throw ApiError.notFound('Server not found')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small).catch(() => ({}) as Record<string, unknown>)
  // A test can carry the values the form is holding, so a reader can check a key before saving it; the
  // response never echoes them back either way.
  const headers = 'headers' in body ? mcpServerFields(body).headers ?? {} : record.headers
  // Tested with the token the reader would have to have for the test to mean anything, so a server that
  // needs authorizing answers "needs authorizing" here rather than pretending to be broken.
  const authorized = await withMcpOAuthHeaders(s, id, record.row.url, headers)
  // Tested the way the turn will call it: a server saved as an SSE endpoint has to answer as one.
  const result = await mcpProbe(record.row.url, authorized, record.row.id, record.row.label, record.row.timeoutSeconds, record.row.transport)
  return c.json({
    ok: result.ok,
    error: result.error,
    tools: (result.tools ?? []).map((tool) => ({ name: tool.name, remoteName: tool.remoteName, description: tool.description })),
  })
})

/**
 * What the settings screen draws: every server's tools, with the ones switched off marked.
 *
 * This is the catalogue rather than the turn's toolbox — nothing here is callable — so a server that is
 * switched off is listed too: its per-tool switches live under the same card, and a reader about to switch
 * it back on has to be able to see what they had turned off inside it.
 */
assistantRoutes.get('/mcp/tools', async (c) => {
  const catalog = await listMcpCatalog(store(c))
  return c.json({ servers: catalog.servers, problems: catalog.problems })
})

/**
 * Run one stored third-party call again, with the arguments it was given.
 *
 * A reader looking at a call that came back wrong has one question the transcript cannot answer: is it
 * still wrong? They can press this and see. Three rules keep it from being a way around the approval
 * gate the turn itself respects:
 *  - only a call whose host is set to run directly is repeatable — a server in Ask mode refuses here, so
 *    a second write can only ever happen where the first one would have run unprompted anyway;
 *  - the arguments are the ones on the row, not anything a client sends, so this replays the call that
 *    happened rather than a new one wearing its name;
 *  - the answer is returned, never written back. What the model was handed stays what the model was
 *    handed, and the fresh answer is the reader's to read.
 */
assistantRoutes.post('/mcp/replay', async (c) => {
  const s = store(c)
  const body = await readJson<{ conversationId?: unknown, messageId?: unknown, toolId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const conversationId = requiredId(body.conversationId)
  const messageId = requiredId(body.messageId)
  // A call's own id is the provider's — `call-1` on the wire — and not an id this app mints, so it is
  // bounded text matched against the row rather than validated as one.
  const toolId = typeof body.toolId === 'string' ? body.toolId.trim().slice(0, 128) : ''
  if (!toolId) throw ApiError.badRequest('Which call?')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId || message.role !== 'assistant') {
    throw ApiError.notFound('Message not found')
  }
  const activity = message.tools.find((tool) => tool.id === toolId)
  if (!activity) throw ApiError.notFound('That call is not on this message.')
  if (!isExternalToolName(activity.name)) throw ApiError.badRequest('Only a call to a third party can be run again.')
  if (!activity.args) throw ApiError.badRequest('That call did not store what it was handed.')

  const servers = await s.listMcpServers()
  const origin = mcpToolOrigin(activity.name, servers)
  const server = origin ? servers.find((entry) => entry.id === origin.serverId) : undefined
  if (!server) throw ApiError.notFound('The server this call went to is no longer configured.')
  if (!server.enabled) throw ApiError.conflict('That server is switched off.')
  if (server.toolMode !== 'auto') throw ApiError.conflict('That server asks before every call, so this one is not run again from here.')
  const record = await s.mcpServerRecord(server.id)
  if (!record) throw ApiError.notFound('The server this call went to is no longer configured.')

  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(activity.args) as unknown
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw ApiError.badRequest('What that call was handed is not readable.')
  }

  try {
    const session = await mcpInitialize(server.url, await withMcpOAuthHeaders(s, server.id, server.url, record.headers), server.timeoutSeconds, server.transport)
    // The stored name is the namespaced one, and the namespacing is lossy: the server is asked what it
    // offers so the call carries the same remote name the first one did.
    const listing = await mcpListTools(session, server.id, server.label)
    const tool = listing.tools.find((entry) => entry.name === activity.name)
    if (!tool) throw ApiError.notFound('That server no longer offers this function.')
    if (server.disabledTools.includes(tool.remoteName)) throw ApiError.conflict('That function is switched off on its card.')
    return c.json({ ok: true, error: '', result: await mcpCallTool(session, tool.remoteName, args) })
  } catch (error) {
    if (error instanceof ApiError) throw error
    return c.json({ ok: false, error: error instanceof McpError ? error.message : 'The server could not be reached.', result: '' })
  }
})

/**
 * One server as its editor opens it: the row, plus the names of the headers it stores.
 *
 * Registered after `/mcp/tools`, which would otherwise be read as an id. The names are read here rather
 * than listed with every row because reading them means decrypting that row, and the values are never in
 * the answer at all: a token that comes back to the browser can be read by any extension or screenshot.
 */
assistantRoutes.get('/mcp/:id', async (c) => {
  const record = await store(c).mcpServerRecord(requiredId(c.req.param('id')))
  if (!record) throw ApiError.notFound('Server not found')
  return c.json({ server: record.row, headerNames: Object.keys(record.headers) })
})

// ------------------------------------------------ outbound MCP OAuth (client)

/**
 * Where the identity provider sends the reader back to.
 *
 * One fixed path, and the only address ever registered with a third party — a redirect that could be pointed
 * elsewhere would be a way to have somebody else's provider hand a code to somebody else's site.
 */
function mcpOAuthRedirect(c: Context<AppBindings>): string {
  return `${new URL(c.req.url).origin}/api/assistant/mcp/oauth/callback`
}

/**
 * Start a reader's login at a third party's own identity provider.
 *
 * The answer is an address the browser opens, not a redirect: this route is a `fetch` from the settings
 * screen, and a worker that answered a `fetch` with a 302 to an external site would have the reader's
 * session cookie follow it. The client puts the URL in a new tab and lets the provider do the rest.
 */
assistantRoutes.post('/mcp/:id/authorize', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const record = await s.mcpServerRecord(id)
  if (!record) throw ApiError.notFound('Server not found')
  const body = await readJson<{ clientId?: unknown }>(c, JSON_BODY_LIMITS.small).catch(() => ({}) as { clientId?: unknown })
  const url = await startMcpAuthorization({
    store: s,
    serverId: id,
    mcpUrl: record.row.url,
    clientName: `${record.row.label} · ${c.env.APP_NAME || 'Inkstone'}`,
    redirectUri: mcpOAuthRedirect(c),
    // A server with no dynamic registration can still be used by a reader who registered this app by hand
    // with its provider, so the id they type is the one that gets sent.
    suppliedClientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 512) : '',
  })
  await s.recordActivity('mcp.authorized', `${record.row.label}: authorization started at ${new URL(url).host}`)
  return c.json({ url })
})

/** The page a reader lands on when their provider sends them back. No script, no styling, one link home. */
function mcpOAuthResultPage(title: string, detail: string, home: string): string {
  const say = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex">`
    + `<title>${say(title)} · Inkstone</title></head>`
    + `<body><h1>${say(title)}</h1><p>${say(detail)}</p><p><a href="${say(home)}">Back to the assistant</a></p></body></html>`
}

/**
 * The half of the dance the third party drives.
 *
 * Reached by the reader's browser, from the provider, so it is a page rather than an API call — and it is
 * still behind `requireAuth`, which is what makes the state below a confirmation rather than the only
 * defence: the row that gets the token is found inside *this* session's own servers, so another reader's
 * correctly-signed reply for the same server id simply has no row to land on.
 */
assistantRoutes.get('/mcp/oauth/callback', async (c) => {
  const s = store(c)
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const providerError = c.req.query('error') ?? ''
  const home = `${new URL(c.req.url).origin}/chat`
  try {
    if (!code && !providerError) throw ApiError.badRequest('Neither a code nor a reason came back.')
    const done = await finishMcpAuthorization({
      store: s,
      state,
      code,
      providerError: providerError || undefined,
      redirectUri: mcpOAuthRedirect(c),
    })
    return c.html(mcpOAuthResultPage('Authorized', `${done.label} can now be used by the assistant. This tab can be closed.`, home))
  } catch (error) {
    const detail = error instanceof ApiError ? error.message : 'The authorization could not be completed.'
    return c.html(mcpOAuthResultPage('Not authorized', detail, home), 400)
  }
})

/** Take the token away, and leave the server's own configuration alone. */
assistantRoutes['delete']('/mcp/:id/authorize', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const record = await s.mcpServerRecord(id)
  if (!record) throw ApiError.notFound('Server not found')
  await s.clearMcpAuthorization(id)
  await s.recordActivity('mcp.revoked', `${record.row.label}: authorization revoked`)
  return c.json({ ok: true })
})

assistantRoutes.get('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const conversation = await s.getConversation(id)
  if (!conversation) throw ApiError.notFound('Conversation not found')
  const actions = await s.actionStatesForConversation(id)
  const messages = (await s.messages(id)).map((message) => ({
    ...message,
    tools: message.tools.map((tool) => (tool.approval
      ? { ...tool, approval: actions.get(tool.approval.id) ?? tool.approval }
      : tool)),
  }))
  const withTags = await s.tagsForConversations([id])
  if (conversation) conversation.tags = withTags.get(id) ?? []
  // The chips name the files; the bytes only ever travel on the model's turn, so the transcript needs
  // the rows and not the contents.
  const wanted = [...new Set(messages.flatMap((entry) => entry.attachments ?? []))]
  return c.json({
    conversation,
    messages,
    attachments: await s.chatAttachments(wanted),
    streaming: await s.isRunning(id),
  })
})

/**
 * The answers this turn said before the reader asked again.
 *
 * Both routes check the message belongs to the conversation in the path: the store binds `user_id` to
 * every query, so the only thing a foreign id could otherwise reach is another of the same reader's
 * threads — and paging one turn's answers into another turn's bubble is a data leak of a kind the reader
 * would notice as a bug in their own words.
 */
assistantRoutes.get('/conversations/:id/messages/:messageId/versions', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId || message.role !== 'assistant') {
    throw ApiError.notFound('Message not found')
  }
  return c.json({ versions: await s.listAnswerVersions(messageId) })
})

assistantRoutes.post('/conversations/:id/messages/:messageId/versions/:versionId/activate', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  const versionId = requiredId(c.req.param('versionId'))
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId || message.role !== 'assistant') {
    throw ApiError.notFound('Message not found')
  }
  // A turn that is still streaming cannot be exchanged: the row is being written under this swap.
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  const swapped = await s.swapAnswerVersion(messageId, versionId)
  if (!swapped) throw ApiError.notFound('Answer version not found')
  return c.json({ message: swapped })
})

/**
 * Rewrite what the reader asked, or take the turn back.
 *
 * Both are the reader's own row: an edit is a retype of their words, so the answer it drew — which was
 * written from the text that is now gone — is removed with it and the client asks again. A delete takes
 * the pair. Either way the conversation's rollup is dropped, because the paragraph described rows that
 * no longer stand as they were.
 *
 * A turn still being written is refused rather than raced: the runner is appending to the same table.
 */
assistantRoutes.patch('/conversations/:id/messages/:messageId', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  const body = await readJson<{ content?: unknown }>(c, JSON_BODY_LIMITS.small)
  const content = text(body.content, MAX_MESSAGE_CHARS)
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (message.role !== 'user') throw ApiError.badRequest('Only your own message can be edited.')
  if (message.source === 'import') throw ApiError.conflict('A message restored from a backup cannot be edited.')
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  const messages = await s.messages(conversationId)
  const index = messages.findIndex((entry) => entry.id === messageId)
  if (index < 0) throw ApiError.notFound('Message not found')
  await s.updateMessageContent(messageId, content)
  for (const later of messages.slice(index + 1)) await s.deleteMessage(later.id)
  await s.clearSummary(conversationId)
  return c.json({ message: await s.getMessage(messageId), removed: messages.length - index - 1 })
})

assistantRoutes.delete('/conversations/:id/messages/:messageId', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  const messages = await s.messages(conversationId)
  const index = messages.findIndex((entry) => entry.id === messageId)
  if (index < 0) throw ApiError.notFound('Message not found')
  // A turn is a pair, and half of one is a question with no answer under it: the reply that followed the
  // reader's own row goes too. Anything after that pair is a turn the reader has not touched.
  const answer = messages[index + 1]
  const removed = message.role === 'user' && answer?.role === 'assistant' ? [message, answer] : [message]
  for (const entry of removed) await s.deleteMessage(entry.id)
  await s.clearSummary(conversationId)
  return c.json({ removed: removed.map((entry) => entry.id), messages: await s.messages(conversationId) })
})

assistantRoutes.patch('/conversations/:id/messages/:messageId/feedback', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  const body = await readJson<{ feedback?: unknown }>(c, JSON_BODY_LIMITS.small)
  // `null` is a real answer here — the reader pressing the same thumb twice takes it back — and an
  // unknown word is refused rather than stored, so a client that invents a third verdict finds out.
  const asked = body.feedback
  const feedback = asked === null
    ? null
    : typeof asked === 'string' && (MESSAGE_FEEDBACK as readonly string[]).includes(asked)
      ? asked as MessageFeedback
      : undefined
  if (feedback === undefined) throw ApiError.badRequest('A verdict is "up", "down" or null.')
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (message.role !== 'assistant') throw ApiError.badRequest('Only an answer can be rated.')
  await s.setMessageFeedback(messageId, feedback)
  return c.json({ message: await s.getMessage(messageId) })
})

/**
 * Deletes a selection of turns.
 *
 * Registered before the single-message `DELETE` below would not conflict — the paths differ — but it is
 * kept beside the fork because both are bulk operations on one conversation, and both take their input
 * in the body rather than in the path.
 */
assistantRoutes.post('/conversations/:id/messages/delete', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const body = await readJson<{ ids?: unknown }>(c, JSON_BODY_LIMITS.small)
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => typeof id === 'string' && isValidId(id))
  if (!ids.length) throw ApiError.badRequest('Select at least one message.')
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  const removed = await s.deleteMessages(conversationId, ids)
  return c.json({ removed, messages: await s.messages(conversationId) })
})

/** A published link, in the shape the settings panel draws. */
export function conversationShareInfo(row: ChatShareRow, origin: string): {
  slug: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
} {
  return {
    slug: row.slug,
    url: `${origin.replace(/\/$/, '')}/c/${encodeURIComponent(row.slug)}`,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    views: row.views,
    createdAt: row.created_at,
  }
}

/**
 * The link a conversation is published behind, if any.
 *
 * Emitted with the origin in it because the reader's next act is to paste it somewhere; the settings
 * panel is the only caller, and a client that had to assemble a URL would be a second place the format
 * lives.
 */
assistantRoutes.get('/conversations/:id/share', async (c) => {
  const userId = c.get('userId')
  const conversationId = requiredId(c.req.param('id'))
  const shares = new ChatShareStore(c.env.DB, userId)
  if (!(await shares.liveConversationExists(conversationId))) throw ApiError.notFound('Conversation not found')
  const row = await shares.shareFor(conversationId)
  return c.json({ share: row ? conversationShareInfo(row, new URL(c.req.url).origin) : null })
})

/**
 * Publishes a conversation, or refreshes the link it already has.
 *
 * `rotate` is the reader's "give me a new address" — the old slug stops resolving the moment it lands,
 * which is the only way to un-share a link somebody already has a copy of. Everything else about the
 * request is optional and keeps what it had, so the panel can send one field at a time.
 */
assistantRoutes.post('/conversations/:id/share', async (c) => {
  const userId = c.get('userId')
  const conversationId = requiredId(c.req.param('id'))
  const body = await readJson<{ password?: unknown, expiresIn?: unknown, rotate?: unknown }>(c, JSON_BODY_LIMITS.small)
  const assistant = store(c)
  const shares = new ChatShareStore(c.env.DB, userId)
  if (!(await shares.liveConversationExists(conversationId))) throw ApiError.notFound('Conversation not found')
  if (
    body.expiresIn !== undefined &&
    body.expiresIn !== null &&
    (!Number.isFinite(body.expiresIn) || (body.expiresIn as number) < 0)
  ) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  const expiresAt = typeof body.expiresIn === 'number' && body.expiresIn > 0
    ? Date.now() + Math.min(body.expiresIn, 365 * 24 * 60 * 60 * 1000)
    : null
  const passcode = await conversationSharePasswordHash(body.password)
  const written = await shares.upsertShare({
    conversationId,
    passwordHash: passcode.hash,
    expiresAt,
    now: Date.now(),
    replacePassword: passcode.named,
    replaceExpiry: body.expiresIn !== undefined,
    rotate: body.rotate === true,
  })
  if (!written) throw new ApiError(409, 'conflict', 'Share state changed. Refresh and try again')
  const row = await shares.shareFor(conversationId)
  await assistant.recordActivity('conversation.shared', row!.slug)
  return c.json({ share: conversationShareInfo(row!, new URL(c.req.url).origin) })
})

assistantRoutes.delete('/conversations/:id/share', async (c) => {
  const userId = c.get('userId')
  const conversationId = requiredId(c.req.param('id'))
  await new ChatShareStore(c.env.DB, userId).deleteShare(conversationId)
  return c.json({ ok: true })
})

assistantRoutes.post('/conversations/:id/fork', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const body = await readJson<{ messageId?: unknown, title?: unknown }>(c, JSON_BODY_LIMITS.small)
  const messageId = requiredId(body.messageId)
  // The title is the client's, because a name is interface copy and the worker carries no catalog. It is
  // clamped here the way every other stored title is, and the source's own name is the fallback.
  const source = await s.getConversation(conversationId)
  if (!source) throw ApiError.notFound('Conversation not found')
  const asked = typeof body.title === 'string' ? body.title.trim() : ''
  const title = (asked || source.title || 'Untitled').slice(0, MAX_CONVERSATION_TITLE_CHARS)
  const fork = await s.forkConversation(conversationId, messageId, title)
  if (!fork) throw ApiError.notFound('Message not found')
  await s.recordActivity('conversation.forked', fork.title)
  return c.json({ conversation: fork, messages: await s.messages(fork.id) })
})

assistantRoutes.patch('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const body = await readJson<{ title?: unknown, pinned?: unknown, starred?: unknown, folderId?: unknown, projectId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.title === 'string') await s.renameConversation(id, text(body.title, MAX_CONVERSATION_TITLE_CHARS))
  if (typeof body.pinned === 'boolean') await s.setConversationPinned(id, body.pinned)
  if (typeof body.starred === 'boolean') await s.setConversationStarred(id, body.starred)
  if (body.folderId === null) await s.setConversationFolder(id, null)
  else if (typeof body.folderId === 'string') {
    if (!isValidId(body.folderId) || !(await s.knownFolder(body.folderId))) throw ApiError.badRequest('Unknown folder.')
    await s.setConversationFolder(id, body.folderId)
  }
  // Null is a real answer — the conversation leaves the project — and an unknown id is refused rather
  // than kept, so a conversation cannot go on inheriting instructions nobody can edit.
  if (body.projectId === null) await s.setConversationProject(id, null)
  else if (typeof body.projectId === 'string') {
    if (!isValidId(body.projectId) || !(await s.getProject(body.projectId))) throw ApiError.badRequest('Unknown project.')
    await s.setConversationProject(id, body.projectId)
  }
  const conversation = await s.getConversation(id)
  if (conversation) conversation.tags = (await s.tagsForConversations([id])).get(id) ?? []
  return c.json({ conversation })
})

assistantRoutes.post('/conversations/:id/tags', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const body = await readJson<{ tagId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const tagId = requiredId(body.tagId)
  if (!(await s.knownTag(tagId))) throw ApiError.badRequest('Unknown tag.')
  await s.addConversationTag(id, tagId)
  return c.json({ ok: true })
})

assistantRoutes.delete('/conversations/:id/tags/:tagId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const tagId = requiredId(c.req.param('tagId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  await s.removeConversationTag(id, tagId)
  return c.json({ ok: true })
})

assistantRoutes.delete('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  await s.releaseRun(id)
  await s.deleteConversation(id)
  return c.json({ deleted: true })
})

assistantRoutes.delete('/conversations', async (c) => {
  const body = await readJson<{ confirm?: string }>(c, JSON_BODY_LIMITS.small)
  if (body.confirm !== 'DELETE') throw ApiError.badRequest('Type DELETE to confirm.')
  return c.json({ deleted: await store(c).deleteAllConversations() })
})

// ----------------------------------------------------------------------- chat

/**
 * The two lists that narrow a turn, read the one way they are ever written: with the message, or saved
 * ahead of time on a prompt that stands for a kind of message.
 *
 * A tool the assistant cannot call is not a request but a caller naming something the turn should not
 * reach, and an external tool is not in the built-in registry, so its namespaced shape is what says it is
 * real — the call itself is still refused later if the server turned out not to offer it.
 */
function pinnedTools(value: unknown): string[] {
  const callable = new Set(ASSISTANT_TOOL_SPECS.map((spec) => spec.name))
  return Array.isArray(value)
    ? [...new Set(value.filter((name): name is string =>
      typeof name === 'string' && (callable.has(name) || isExternalToolName(name))))].slice(0, MAX_TURN_TOOLS)
    : []
}

/** A pinned folder or tag: the id has to be one, and the label is only ever shown, never trusted. */
function pinnedScopes(value: unknown): AssistantTurnScope[] {
  return (Array.isArray(value) ? value : [])
    .map((entry): AssistantTurnScope | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const record = entry as Record<string, unknown>
      if (record.kind !== 'tag' && record.kind !== 'folder') return null
      if (typeof record.id !== 'string' || !isValidId(record.id)) return null
      return { kind: record.kind, id: record.id, name: typeof record.name === 'string' ? record.name.slice(0, 60) : '' }
    })
    .filter((entry): entry is AssistantTurnScope => entry !== null)
    .slice(0, MAX_TURN_SCOPES)
}

/**
 * One turn, streamed as server-sent events.
 *
 * The reader's own disconnect is the abort signal: when the write fails the generator stops, so a
 * closed tab does not keep spending the account's AI budget on an answer nobody is reading.
 */
assistantRoutes.post('/chat', async (c) => {
  const body = await readJson<{ conversationId?: unknown, message?: string, retry?: boolean, attachments?: unknown, tools?: unknown, scopes?: unknown, webSearch?: unknown, contextNoteId?: unknown, contextFolderId?: unknown }>(c, 64 * 1024)
  const s = store(c)
  const settings = await s.getSettings()
  const conversationId = body.conversationId === undefined || body.conversationId === null
    ? undefined
    : requiredId(body.conversationId)
  const message = typeof body.message === 'string' ? body.message : ''
  // Only ids the reader owns survive: an attachment they cannot name is not fuel for their turn.
  const attachments = Array.isArray(body.attachments)
    ? (await store(c).chatAttachments(body.attachments.filter((id): id is string => typeof id === 'string' && isValidId(id))).then((rows) => rows.map((row) => row.id)))
    : []

  // A tool the assistant cannot actually call is not a request, and a scope has to be a real id: both
  // narrow what the turn may reach, so neither may be invented by the caller.
  const tools = pinnedTools(body.tools)
  const scopes = pinnedScopes(body.scopes)

  if (conversationId) {
    if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
    if (!(await s.claimRun(conversationId))) {
      throw ApiError.conflict('A reply is already being generated in this conversation.')
    }
  } else if (!message.trim() && !attachments.length) {
    throw ApiError.badRequest('Write something first.')
  }

  const runner = new AssistantRunner({
    store: s,
    env: c.env,
    ftsEnabled: c.get('database').ftsEnabled,
    origin: new URL(c.req.url).origin,
    executionCtx: executionContext(c),
    settings,
  })

  const controller = new AbortController()
  let readerGone = false
  const requestSignal = c.req.raw.signal
  const onDisconnect = () => controller.abort()
  if (requestSignal.aborted) controller.abort()
  else requestSignal.addEventListener('abort', onDisconnect, { once: true })

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  let claimed = conversationId ?? ''

  // Writes are queued rather than awaited: a reader that has gone can leave a write unsettled, and a
  // turn that waits on one never reaches the lease check that ends it. The frames stay in order (the
  // stream's own write queue is sequential) and one turn is a few tens of kilobytes at most.
  const send = (payload: unknown) => {
    if (readerGone) return false
    writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)).catch(() => {
      // The reader is gone: stop generating rather than finish an answer no one will read.
      readerGone = true
      controller.abort()
    })
    return true
  }
  const run = async () => {
    try {
      if (settings.offlineMode) {
        // The id comes back so the claim taken below is the one released at the end of the turn.
        claimed = (await offlineTurn(s, runner, claimed || null, message, send)) ?? claimed
        return
      }
      for await (const event of runner.chat({
        conversationId,
        message,
        attachments,
        tools,
        scopes,
        // What the reader had on screen. Only ids survive, and the runner re-reads both against this
        // account before either reaches the prompt — a caller cannot name someone else's note.
        ...(typeof body.contextNoteId === 'string' && isValidId(body.contextNoteId) ? { contextNoteId: body.contextNoteId } : {}),
        ...(typeof body.contextFolderId === 'string' && isValidId(body.contextFolderId) ? { contextFolderId: body.contextFolderId } : {}),
        webSearch: body.webSearch === true,
        retry: body.retry === true,
        signal: controller.signal,
        readerGone: () => readerGone,
      })) {
        if (event.type === 'start' && event.conversationId) claimed = event.conversationId
        await send(event)
      }
    } catch (error) {
      const reason = error instanceof ApiError ? error.message : 'The assistant could not answer.'
      await send({ type: 'error', code: error instanceof ApiError ? error.code : 'internal', message: reason })
    } finally {
      requestSignal.removeEventListener('abort', onDisconnect)
      if (claimed) await s.releaseRun(claimed)
      try {
        await writer.close()
      } catch {
        /* already closed by the disconnect */
      }
    }
  }
  c.executionCtx.waitUntil(run())

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  })
})

/**
 * The offline answer, kept out of the streaming path.
 *
 * It writes the same two messages and emits the same events, so the client needs no second code path
 * and a reader can tell the difference from the reply's own words rather than from a special case.
 */
async function offlineTurn(
  s: AssistantStore,
  runner: AssistantRunner,
  conversationId: string | null,
  message: string,
  send: (payload: unknown) => boolean,
): Promise<string | null> {
  const content = message.trim().slice(0, MAX_MESSAGE_CHARS)
  if (!content) {
    await send({ type: 'error', code: 'bad_request', message: 'Write something first.' })
    return null
  }
  const conversation = conversationId
    ? await s.getConversation(conversationId)
    : await s.createConversation(titleFromMessage(content))
  if (!conversation) {
    await send({ type: 'error', code: 'not_found', message: 'Conversation not found' })
    return null
  }
  if (!conversationId) await s.claimRun(conversation.id)
  const reply = await runner.offlineTurn(conversation.id, content)
  await send({ type: 'start', conversationId: conversation.id, assistantMessageId: reply.id })
  await send({ type: 'text', delta: reply.content })
  await send({ type: 'done', finalMessage: reply })
  return conversation.id
}

/**
 * Releases the conversation's claim.
 *
 * The upstream call itself is cancelled by the reader's own disconnect; this exists so the conversation
 * unlocks immediately instead of waiting for the lease to expire, and so another device watching the
 * same conversation sees it stop.
 */
assistantRoutes.post('/chat/cancel', async (c) => {
  const s = store(c)
  const id = requiredId((await readJson<{ conversationId?: unknown }>(c, JSON_BODY_LIMITS.small)).conversationId)
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  await s.releaseRun(id)
  return c.json({ cancelled: true })
})

assistantRoutes.post('/actions/:id/approve', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const stored = await s.getPendingAction(id)
  if (!stored) throw ApiError.notFound('This action no longer exists.')
  if (!(await s.getConversation(stored.conversationId))) throw ApiError.notFound('This conversation no longer exists.')
  const settings = await s.getSettings()
  const outcome = await runApprovedAction(s, await approvalContext(c, s, settings), id)
  if (outcome.action) {
    const located = await s.messageForAction(id)
    if (located) await s.attachActionToMessage(located.messageId, located.toolId, outcome.action, outcome.result)
  }
  return c.json(outcome)
})

assistantRoutes.post('/actions/:id/cancel', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const action = await cancelApprovedAction(s, id)
  if (action) {
    const located = await s.messageForAction(id)
    if (located) await s.attachActionToMessage(located.messageId, located.toolId, action)
  }
  return c.json({ action })
})

/**
 * The context an approved action runs in.
 *
 * It is built here rather than reused from a turn because the turn that proposed the action has long
 * finished: the note may have been edited since, and the reader's settings may have changed. The scope
 * is re-read from settings for the same reason — an exclusion added after the proposal must hold.
 */
async function approvalContext(c: Context<AppBindings>, s: AssistantStore, settings: Awaited<ReturnType<AssistantStore['getSettings']>>) {
  const scope = await resolveNoteScope(c.env.DB, s.userId, settings.noteScope)
  const external = await loadExternalTools(s)
  return {
    externalByName: new Map(external.definitions.map((definition) => [definition.name, definition])),
    store: s,
    env: c.env,
    ftsEnabled: c.get('database').ftsEnabled,
    origin: new URL(c.req.url).origin,
    settings,
    timezone: settings.timezone,
    dayEnd: readerDayEnd(settings.timezone),
    mode: 'chat' as const,
    memoryHistory: new MemoryHistoryService(s, {}, settings.conflictReview),
    automations: new AutomationService(s, settings),
    noteScope: async () => scope,
    writeContext: {
      env: c.env,
      userId: s.userId,
      ftsEnabled: c.get('database').ftsEnabled,
      executionCtx: executionContext(c),
    },
  }
}

// ------------------------------------------------------------------ memories

assistantRoutes.get('/memories', async (c) => {
  const s = store(c)
  const query = c.req.query('q')?.trim().slice(0, 200)
  const category = c.req.query('category')
  const [memories, active, historical, review, total] = await Promise.all([
    s.listMemories({
      query: query || undefined,
      status: c.req.query('status') ?? 'all',
      category: category || undefined,
    }),
    s.countMemories('active'),
    s.countMemories('historical'),
    s.countMemories('review'),
    s.countMemories('all'),
  ])
  return c.json({ memories, total, counts: { active, historical, review } })
})

assistantRoutes.post('/memories', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<{ content?: unknown, category?: unknown }>(c, JSON_BODY_LIMITS.small)
  const result = await new MemoryHistoryService(s, {}, settings.conflictReview).create({
    content: text(body.content, MAX_MEMORY_CHARS),
    category: asCategory(body.category),
    source: 'manual',
  })
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length }, 201)
})

assistantRoutes.get('/memories/reviews', async (c) => c.json({ reviews: await store(c).listReviews() }))

assistantRoutes.post('/memories/reviews/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ action?: unknown }>(c, JSON_BODY_LIMITS.small)
  const action = body.action as MemoryReviewAction
  if (!MEMORY_REVIEW_ACTIONS.includes(action)) throw ApiError.badRequest('Unknown review action.')
  return c.json(await new MemoryHistoryService(s, {}, settings.conflictReview).resolveReview(id, action))
})

assistantRoutes.get('/memories/:id/history', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  return c.json(await new MemoryHistoryService(s, {}, settings.conflictReview).history(requiredId(c.req.param('id'))))
})

assistantRoutes.patch('/memories/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ content?: unknown, category?: unknown }>(c, JSON_BODY_LIMITS.small)
  const result = await new MemoryHistoryService(s, {}, settings.conflictReview).update(id, {
    ...(body.content !== undefined ? { content: text(body.content, MAX_MEMORY_CHARS) } : {}),
    ...(body.category !== undefined ? { category: asCategory(body.category) } : {}),
  })
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length })
})

assistantRoutes.post('/memories/:id/correct', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ content?: unknown, category?: unknown }>(c, JSON_BODY_LIMITS.small)
  const result = await new MemoryHistoryService(s, {}, settings.conflictReview).correct(
    id,
    text(body.content, MAX_MEMORY_CHARS),
    body.category === undefined ? undefined : asCategory(body.category),
  )
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length }, 201)
})

assistantRoutes.post('/memories/:id/status', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ status?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (body.status !== 'active' && body.status !== 'historical' && body.status !== 'uncertain') {
    throw ApiError.badRequest('Unknown memory status.')
  }
  return c.json({ memory: await new MemoryHistoryService(s, {}, settings.conflictReview).setStatus(id, body.status) })
})

assistantRoutes.delete('/memories/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  await new MemoryHistoryService(s, {}, settings.conflictReview).delete(requiredId(c.req.param('id')))
  return c.json({ deleted: true })
})

assistantRoutes.delete('/memories', async (c) => {
  const body = await readJson<{ confirm?: string }>(c, JSON_BODY_LIMITS.small)
  if (body.confirm !== 'DELETE') throw ApiError.badRequest('Type DELETE to confirm.')
  return c.json({ deleted: await store(c).deleteAllMemories() })
})

function asCategory(value: unknown): AssistantMemoryCategory {
  if (value === undefined || value === null) return 'other'
  if (typeof value === 'string' && (ASSISTANT_MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as AssistantMemoryCategory
  }
  throw ApiError.badRequest('Unknown memory category.')
}

// --------------------------------------------------------------------- tasks

assistantRoutes.get('/tasks', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const view = c.req.query('view')
  const status = c.req.query('status')
  const tasks = await s.listTasks({
    status: taskStatusFilter(status),
    view: view === 'today' || view === 'upcoming' || view === 'overdue' || view === 'completed' ? view : 'all',
    query: c.req.query('q')?.trim().slice(0, 200) || undefined,
    projectId: c.req.query('project_id') || undefined,
    limit: clampLimit(c.req.query('limit'), 200),
    dayEnd: readerDayEnd(settings.timezone),
  })
  return c.json({ tasks })
})

assistantRoutes.post('/tasks', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const task = await s.createTask({
    title: text(body.title, MAX_TASK_TITLE_CHARS),
    description: optionalText(body.description, MAX_TASK_NOTES_CHARS) ?? '',
    status: body.status === undefined ? undefined : asTaskStatus(body.status),
    priority: body.priority === undefined ? undefined : asPriority(body.priority),
    dueAt: parseDue(body.dueAt, settings.timezone),
    projectId: await projectRef(s, body.projectId),
  })
  await s.recordActivity('task.created', task.title)
  return c.json({ task }, 201)
})

assistantRoutes.patch('/tasks/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const task = await s.updateTask(id, {
    ...(body.title !== undefined ? { title: text(body.title, MAX_TASK_TITLE_CHARS) } : {}),
    ...(body.description !== undefined ? { description: optionalText(body.description, MAX_TASK_NOTES_CHARS) ?? '' } : {}),
    ...(body.status !== undefined ? { status: asTaskStatus(body.status) } : {}),
    ...(body.priority !== undefined ? { priority: asPriority(body.priority) } : {}),
    ...(body.dueAt !== undefined ? { dueAt: parseDue(body.dueAt, settings.timezone) } : {}),
    ...(body.projectId !== undefined ? { projectId: await projectRef(s, body.projectId) } : {}),
  })
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task })
})

assistantRoutes.delete('/tasks/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const existing = await s.getTask(id)
  if (!existing) throw ApiError.notFound('Task not found')
  await s.deleteTask(id)
  await s.recordActivity('task.deleted', existing.title)
  return c.json({ deleted: true })
})

function taskStatusFilter(value: string | undefined): TaskStatus | 'open' | 'all' {
  if (!value || value === 'all' || value === 'open') return (value ?? 'all') as TaskStatus | 'open' | 'all'
  return asTaskStatus(value)
}

function asTaskStatus(value: unknown): TaskStatus {
  if (value === 'todo' || value === 'in_progress' || value === 'done') return value
  throw ApiError.badRequest('Unknown task status.')
}

function asPriority(value: unknown): TaskPriority {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') return value
  throw ApiError.badRequest('Unknown task priority.')
}

function parseDue(value: unknown, timezone: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = parseLocalTime(value, timezone)
    if (parsed === null) throw ApiError.badRequest('That date could not be read.')
    return parsed
  }
  throw ApiError.badRequest('A due date must be text or a number.')
}

async function projectRef(s: AssistantStore, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('A project must be named by id.')
  const found = await s.resolveProject(value)
  if (!found) throw ApiError.badRequest('That project does not exist.')
  return found.id
}

function clampLimit(value: string | undefined, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(500, Math.trunc(numeric)))
}

// ------------------------------------------------------------------ projects

assistantRoutes.get('/projects', async (c) => c.json({ projects: await store(c).listProjects() }))

/** Each project with how many conversations answer under it, plus the ones under none. */
assistantRoutes.get('/projects/summary', async (c) => c.json(await store(c).conversationProjectSummary()))

assistantRoutes.post('/projects', async (c) => {
  const s = store(c)
  const body = await readJson<{
    name?: unknown, description?: unknown, instructions?: unknown, noteScope?: unknown, modelId?: unknown,
  }>(c, JSON_BODY_LIMITS.small)
  const name = text(body.name, 200)
  const existing = await s.findProjectByName(name)
  if (existing) return c.json({ project: existing })
  const project = await s.createProject({
    name,
    description: optionalText(body.description, 2000) ?? '',
    // A standing brief is read every turn in the project, so it gets the same ceiling as a message.
    instructions: optionalText(body.instructions, MAX_MESSAGE_CHARS) ?? '',
    noteScope: Array.isArray(body.noteScope)
      ? body.noteScope.filter((id): id is string => typeof id === 'string' && isValidId(id)).slice(0, 12)
      : [],
    modelId: body.modelId === null
      ? null
      : typeof body.modelId === 'string' && isValidId(body.modelId)
        ? body.modelId
        : null,
  })
  return c.json({ project }, 201)
})

assistantRoutes.patch('/projects/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ name?: unknown, description?: unknown, instructions?: unknown, noteScope?: unknown, modelId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const project = await s.updateProject(id, {
    ...(body.name !== undefined ? { name: text(body.name, 200) } : {}),
    ...(body.description !== undefined ? { description: optionalText(body.description, 2000) ?? '' } : {}),
    // A standing brief is read every turn in the project, so it gets the same ceiling as a message.
    ...(body.instructions !== undefined ? { instructions: text(body.instructions, MAX_MESSAGE_CHARS) } : {}),
    ...(Array.isArray(body.noteScope)
      ? { noteScope: body.noteScope.filter((id): id is string => typeof id === 'string' && isValidId(id)).slice(0, 12) }
      : {}),
    ...(body.modelId !== undefined
      ? { modelId: body.modelId === null ? null : isValidId(body.modelId) ? body.modelId : undefined }
      : {}),
  })
  if (!project) throw ApiError.notFound('Project not found')
  return c.json({ project })
})

assistantRoutes.delete('/projects/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getProject(id))) throw ApiError.notFound('Project not found')
  await s.deleteProject(id)
  return c.json({ deleted: true })
})

// --------------------------------------------------------------- automations

assistantRoutes.get('/automations', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const [automations, runs] = await Promise.all([s.listAutomations(), s.listRuns(30)])
  return c.json({ automations, runs, timezone: settings.timezone })
})

assistantRoutes.post('/automations', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  if (typeof body.kind !== 'string' || !AUTOMATION_KINDS.includes(body.kind as (typeof AUTOMATION_KINDS)[number])) {
    throw ApiError.badRequest('Unknown automation kind.')
  }
  const message = optionalText(body.message, MAX_AUTOMATION_MESSAGE_CHARS) ?? ''
  const automation = await new AutomationService(s, settings).create({
    name: typeof body.name === 'string' ? body.name : message,
    kind: body.kind as (typeof AUTOMATION_KINDS)[number],
    message,
    schedule: body.schedule,
    enabled: body.enabled !== false,
  })
  await s.recordActivity('automation.created', automation.name)
  return c.json({ automation }, 201)
})

assistantRoutes.patch('/automations/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const automation = await new AutomationService(s, settings).update(id, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.message !== undefined ? { message: String(body.message) } : {}),
    ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
  })
  return c.json({ automation })
})

assistantRoutes.delete('/automations/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  await new AutomationService(s, settings).delete(requiredId(c.req.param('id')))
  return c.json({ deleted: true })
})

// ------------------------------------------------------------- notifications

assistantRoutes.get('/notifications', async (c) => {
  const s = store(c)
  const [notifications, unread] = await Promise.all([
    s.listNotifications({ unreadOnly: c.req.query('unread') === '1', limit: 50 }),
    s.unreadCount(),
  ])
  return c.json({ notifications, unread })
})

assistantRoutes.post('/notifications/read', async (c) => {
  const s = store(c)
  const body = await readJson<{ id?: unknown }>(c, JSON_BODY_LIMITS.small).catch(() => ({}) as Record<string, unknown>)
  await s.markRead(typeof body.id === 'string' ? body.id : undefined)
  return c.json({ unread: await s.unreadCount() })
})

assistantRoutes.delete('/notifications/:id', async (c) => {
  const s = store(c)
  await s.deleteNotification(requiredId(c.req.param('id')))
  return c.json({ unread: await s.unreadCount() })
})

// ------------------------------------------------------------------ settings

assistantRoutes.get('/settings', async (c) => {
  const s = store(c)
  const [settings, models] = await Promise.all([s.getSettings(), s.listModels()])
  return c.json({ settings, models })
})

assistantRoutes.patch('/settings', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const current = await s.getSettings()
  // Only the known keys are forwarded, and `normalizeAssistantSettings` validates each of them, so a
  // field cannot be left behind here: the list is derived from the settings object itself.
  const patch: Record<string, unknown> = {}
  for (const key of ASSISTANT_SETTING_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  const next = normalizeAssistantSettings({ ...current, ...patch })
  await s.saveSettings(next)
  if (next.timezone !== current.timezone) {
    // Wall-clock schedules have to move with the reader's clock, or a 07:30 digest arrives at 07:30 UTC.
    await new AutomationService(s, next).rearmAll()
  }
  const changedModel = next.semanticModel !== current.semanticModel
  if (changedModel) {
    // A vector from another encoder is not comparable with these, so the index starts over rather than
    // spending its daily budget on scores that would rank noise.
    await s.clearMemoryEmbeddings()
  }
  if (c.env.AI && (changedModel || (next.semanticMemory && !current.semanticMemory))) {
    // Turning the feature on, or pointing it at another model, embeds what is missing behind the reply.
    // A failed backfill leaves the count pending, which is what the settings card reads and shows.
    executionContext(c).waitUntil(
      reindexMemoryEmbeddings(s, c.env, next.limits.maxEmbeddingsPerDay, semanticModel(next)).catch(() => undefined),
    )
  }
  return c.json({ settings: next })
})

// ----------------------------------------------------------- chat attachments

/** The reader's own uploads, newest first; the composer's picker walks this. */
assistantRoutes.get('/files', async (c) => c.json({ files: await store(c).listChatAttachments() }))

assistantRoutes.post('/files', async (c) => {
  const s = store(c)
  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field.')
  // The browser's own reading of the document, when it could make one. Absent is fine: the file is
  // still stored and named, and the model is told the contents were not read.
  const extractedText = form.get('text')
  try {
    const attachment = await saveChatUpload(s, c.env, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      filename: file.name,
      ...(typeof extractedText === 'string' && extractedText ? { extractedText } : {}),
    })
    return c.json({ attachment }, 201)
  } catch (error) {
    if (error instanceof ChatUploadError) throw ApiError.badRequest(error.message)
    throw error
  }
})

/**
 * Pulls a remote file in so the assistant can read it rather than being told a URL it cannot open.
 *
 * The endpoint guard is the one the AI proxy uses: https only, no credentials, no link-local target.
 * A chat message can name any URL the reader types, and this route fetches with the deployment's own
 * network position, so an unchecked URL is a request forgery with a friendly face.
 */
assistantRoutes.post('/files/url', async (c) => {
  const s = store(c)
  const body = await readJson<{ url?: unknown }>(c, JSON_BODY_LIMITS.small)
  const raw = typeof body.url === 'string' ? body.url.trim() : ''
  let target: URL
  try {
    target = assertRelayableEndpoint(raw)
  } catch {
    throw ApiError.badRequest('Only a public http(s) URL can be fetched.')
  }
  if (target.protocol !== 'https:') throw ApiError.badRequest('Only an https URL can be fetched.')
  let response: Response
  try {
    response = await fetch(target.toString(), { redirect: NO_REDIRECT, headers: { 'user-agent': 'Inkstone-Chat/1.0' } })
  } catch {
    throw ApiError.badRequest('That URL could not be reached.')
  }
  if (isRedirectResponse(response)) throw ApiError.badRequest('That URL redirects, which fetches refuse.')
  if (!response.ok) throw ApiError.badRequest(`That URL returned ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > CHAT_IMAGE_MAX_BYTES) throw ApiError.badRequest(`That file is ${formatBytes(declared)}, above the limit.`)
  const bytes = new Uint8Array(await readCapped(response.body, CHAT_IMAGE_MAX_BYTES))
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
  const named = decodeURIComponent(target.pathname.split('/').pop() ?? '').slice(0, 160)
  try {
    const attachment = await saveChatUpload(s, c.env, { bytes, mime, filename: named || 'remote-file' })
    return c.json({ attachment }, 201)
  } catch (error) {
    if (error instanceof ChatUploadError) throw ApiError.badRequest(error.message)
    throw error
  }
})

assistantRoutes.get('/files/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const [row] = await s.chatAttachments([id])
  if (!row) throw ApiError.notFound('Attachment not found')
  const bytes = await readChatObject(c.env, row.key)
  if (!bytes) throw ApiError.notFound('The stored file is no longer there.')
  // The mime on the row is whatever the browser claimed, so it cannot be a rendering promise: a file
  // uploaded as `text/html` would otherwise run against this origin the moment someone opened its
  // address. Only pictures are shown inline — the same rule the notebook's own file route applies, and
  // the reason an `<img>` for a picture or a thumbnail still works while a document downloads instead.
  const inline = c.req.query('download') !== '1' && isInlineSafe(row.mime)
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': row.mime || 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    },
  })
})

/** The composer's X button: an upload nobody sent is an upload that should stop existing. */
assistantRoutes.delete('/files/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const removed = await s.deleteChatAttachment(id)
  if (removed) await deleteChatObject(c.env, removed.key)
  return c.json({ deleted: Boolean(removed) })
})

// -------------------------------------------------------------------- prompts

/** The reader's own prompt library, the words behind the composer's `/` and ➕ entries. */
assistantRoutes.get('/prompts', async (c) => {
  const query = c.req.query('q')?.trim().slice(0, 200)
  const group = c.req.query('group')?.trim().slice(0, 60)
  const prompts = await store(c).listPrompts({
    ...(query ? { query } : {}),
    ...(group ? { group } : {}),
    limit: Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200)),
  })
  return c.json({ prompts })
})

/**
 * The model a saved prompt asks for, kept only when this account actually has it.
 *
 * A prompt names its model by id and the reader may delete that model later, so the check happens where
 * the mistake is still fixable: an answer that quietly came from a different model than the skill asked
 * for is the kind of wrong that reads as the model's own behaviour.
 */
async function pinnedModel(s: AssistantStore, value: unknown): Promise<string | null> {
  if (value === null) return null
  if (typeof value !== 'string' || !isValidId(value) || !(await s.getModel(value))) {
    throw ApiError.badRequest('Choose one of your own models, or none.')
  }
  return value
}

assistantRoutes.post('/prompts', async (c) => {
  // A prompt is prose: the small limit is for ids and flags, and 8 KB would refuse a paragraph.
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const s = store(c)
  // Either half may be empty on its own — a prompt can be a block of text with no name, or a name the
  // reader fills in later — so neither goes through `text`, which refuses an empty value outright.
  const title = optionalPromptText(body.title, MAX_PROMPT_TITLE_CHARS)
  const content = optionalPromptText(body.content, MAX_PROMPT_CONTENT_CHARS)
  if (!title && !content) throw ApiError.badRequest('A prompt needs a title or the words themselves.')
  const prompt = await s.insertPrompt({
    title: title || content.slice(0, 40),
    content,
    group: body.group === undefined ? '' : optionalPromptText(body.group, 60),
    // The three bindings are a turn preset: the same two lists the composer pins with `/` and `#`, read
    // through the same filter, because a saved prompt must not reach past the turn it stands for.
    tools: pinnedTools(body.tools),
    scopes: pinnedScopes(body.scopes),
    modelId: body.modelId === undefined ? null : await pinnedModel(s, body.modelId),
  })
  return c.json({ prompt }, 201)
})

assistantRoutes.patch('/prompts/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const updated = await s.updatePrompt(id, {
    // Read the same forgiving way the create does: clearing the group, or the words, is an edit a reader
    // is entitled to make, and `text` would answer it with "This cannot be empty."
    ...(body.title !== undefined ? { title: optionalPromptText(body.title, MAX_PROMPT_TITLE_CHARS) } : {}),
    ...(body.content !== undefined ? { content: optionalPromptText(body.content, MAX_PROMPT_CONTENT_CHARS) } : {}),
    ...(body.group !== undefined ? { group: optionalPromptText(body.group, 60) } : {}),
    ...(body.tools !== undefined ? { tools: pinnedTools(body.tools) } : {}),
    ...(body.scopes !== undefined ? { scopes: pinnedScopes(body.scopes) } : {}),
    ...(body.modelId !== undefined ? { modelId: await pinnedModel(s, body.modelId) } : {}),
  })
  if (!updated) throw ApiError.notFound('Prompt not found')
  return c.json({ prompt: updated })
})

assistantRoutes.delete('/prompts/:id', async (c) => {
  const removed = await store(c).deletePrompt(requiredId(c.req.param('id')))
  return c.json({ deleted: removed })
})

// ------------------------------------------------------------------- semantic

/**
 * The vector index over the reader's memories. The switch itself is an ordinary settings field;
 * these three routes are the parts that need a server round trip: what is indexed, rebuilding it,
 * and throwing it away.
 */
assistantRoutes.get('/semantic', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  return c.json({
    enabled: settings.semanticMemory,
    ...(await memoryEmbeddingStatus(s, c.env, settings.limits.maxEmbeddingsPerDay, semanticModel(settings))),
  })
})

assistantRoutes.post('/semantic/reindex', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const result = await reindexMemoryEmbeddings(s, c.env, settings.limits.maxEmbeddingsPerDay, semanticModel(settings))
  await s.recordActivity('memory.reindexed', `${result.embedded} memory embedding(s) written`)
  return c.json(result)
})

assistantRoutes.delete('/semantic', async (c) => {
  const s = store(c)
  return c.json({ deleted: await s.clearMemoryEmbeddings() })
})

// ----------------------------------------------------------------- providers

assistantRoutes.get('/providers', async (c) => c.json({ providers: await store(c).listProviders() }))

assistantRoutes.post('/providers', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const protocol = asProtocol(body.protocol)
  const baseUrl = vetBaseUrl(body.baseUrl)
  const label = text(body.label, 60)
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey.length > 4096) throw ApiError.badRequest('That API key is too long to store.')
  const provider = await s.createProvider({
    label, protocol, baseUrl, apiKey, endpoints: vetEndpoints(body.endpoints),
    reasoningDialect: reasoningDialectValue(body.reasoningDialect),
  })
  const models = Array.isArray(body.models) ? body.models : []
  for (const entry of models.slice(0, MAX_PROVIDER_MODELS)) {
    const model = typeof entry === 'string' ? entry : (entry as { model?: unknown })?.model
    if (typeof model !== 'string' || !model.trim()) continue
    await s.createModel({ providerId: provider.id, model: model.trim().slice(0, 120) })
  }
  const settings = await s.getSettings()
  const suggested = await suggestActiveModel(s, settings)
  if (suggested && !settings.activeModelId) await s.saveSettings({ ...settings, activeModelId: suggested })
  return c.json({ provider }, 201)
})

assistantRoutes.patch('/providers/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const provider = await s.updateProvider(id, {
    ...(body.label !== undefined ? { label: text(body.label, 60) } : {}),
    ...(body.protocol !== undefined ? { protocol: asProtocol(body.protocol) } : {}),
    ...(body.baseUrl !== undefined ? { baseUrl: vetBaseUrl(body.baseUrl) } : {}),
    ...(body.apiKey === null ? { apiKey: null } : typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
    ...(body.endpoints !== undefined ? { endpoints: vetEndpoints(body.endpoints) } : {}),
    ...(body.reasoningDialect !== undefined ? { reasoningDialect: reasoningDialectValue(body.reasoningDialect) } : {}),
  })
  if (!provider) throw ApiError.notFound('Provider not found')
  return c.json({ provider })
})

/**
 * The extra keys a provider rotates through, beside the one on the provider's own row.
 *
 * The plaintext never comes back out: a key is written once and only its last four characters are ever
 * readable again, which is the same bargain the provider's own key already makes.
 */
assistantRoutes.get('/providers/:id/keys', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getProvider(id))) throw ApiError.notFound('Provider not found')
  return c.json({ keys: await s.listProviderKeys(id) })
})

assistantRoutes.post('/providers/:id/keys', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getProvider(id))) throw ApiError.notFound('Provider not found')
  const body = await readJson<{ label?: unknown, apiKey?: unknown }>(c, JSON_BODY_LIMITS.small)
  const apiKey = text(body.apiKey, 4096)
  return c.json({ key: await s.createProviderKey(id, { label: optionalText(body.label, 60) ?? '', apiKey }) }, 201)
})

assistantRoutes.patch('/providers/:id/keys/:keyId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const keyId = requiredId(c.req.param('keyId'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const updated = await s.updateProviderKey(keyId, {
    ...(body.label !== undefined ? { label: optionalText(body.label, 60) ?? '' } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
    ...(body.apiKey === null ? { apiKey: null } : typeof body.apiKey === 'string' ? { apiKey: text(body.apiKey, 4096) } : {}),
  })
  // The provider in the path is checked too, so a key id from another provider reads as not found.
  if (!updated || updated.providerId !== id) throw ApiError.notFound('Key not found')
  return c.json({ key: updated })
})

assistantRoutes.delete('/providers/:id/keys/:keyId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const keyId = requiredId(c.req.param('keyId'))
  if (!(await s.listProviderKeys(id)).some((key) => key.id === keyId)) throw ApiError.notFound('Key not found')
  await s.deleteProviderKey(keyId)
  return c.json({ deleted: true })
})

/**
 * What the reader's key can actually call, straight from the vendor.
 *
 * The picker offers these ids rather than a bundled list, so a model that is not on this account never
 * looks like a bug. A failure is reported in the body rather than as a status the client has to
 * special-case: the screen still has to open, with the manual entry as the way forward.
 */
assistantRoutes.get('/providers/:id/vendor-models', async (c) => {
  const access = await store(c).vendorAccess(requiredId(c.req.param('id')))
  if (!access) throw ApiError.notFound('Provider not found')
  return c.json(await listVendorModels(access.protocol, access.baseUrl, access.apiKey))
})

/**
 * The same listing for a provider the form has not saved yet.
 *
 * The reader is holding the address and the key in the add form, and the only way to learn what that key
 * can call used to be saving the provider first and asking afterwards — which left a half-configured row
 * behind whenever the answer was "those ids do not exist". Nothing is stored here: the two values arrive
 * in the body, are used for one outbound request, and are not written anywhere.
 *
 * The address is vetted here and again inside `listVendorModels`, which is the layer that decides whether
 * a key may leave the isolate at all — the same double check the stored-provider route gets from
 * `vendorAccess`, since neither the form nor the database is a trust boundary.
 */
assistantRoutes.post('/providers/model-list', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const protocol = asProtocol(body.protocol)
  const baseUrl = vetBaseUrl(body.baseUrl)
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey.length > 4096) throw ApiError.badRequest('That API key is too long to send.')
  return c.json(await listVendorModels(protocol, baseUrl, apiKey))
})

assistantRoutes.delete('/providers/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getProvider(id))) throw ApiError.notFound('Provider not found')
  await s.deleteProvider(id)
  const settings = await s.getSettings()
  // The active model may have belonged to the provider that just went away.
  await s.saveSettings({ ...settings, activeModelId: await suggestActiveModel(s, { ...settings, activeModelId: null }) })
  return c.json({ deleted: true })
})

function asProtocol(value: unknown): AssistantProtocol {
  if (typeof value === 'string' && (ASSISTANT_PROTOCOLS as readonly string[]).includes(value)) return value as AssistantProtocol
  throw ApiError.badRequest('Unknown provider protocol.')
}

/**
 * The reader types the address, so it is vetted the same way the existing AI relay vets one: a private
 * or link-local target would let the worker be pointed at whatever the deployment itself can reach.
 */
/**
 * The extra addresses a provider answers on, each vetted exactly like the primary one.
 *
 * A gateway that speaks three wires still may not be pointed inside the network, so an entry that fails
 * the guard fails the save rather than being dropped in silence.
 */
function vetEndpoints(value: unknown): Partial<Record<AssistantProtocol, string>> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Partial<Record<AssistantProtocol, string>> = {}
  for (const [protocol, url] of Object.entries(value as Record<string, unknown>)) {
    if (!(ASSISTANT_PROTOCOLS as readonly string[]).includes(protocol)) continue
    if (typeof url !== 'string') continue
    // These fields are optional, and two ordinary things land in them: the preset's bare `https://` and
    // whatever the browser autocompleted. Neither is an address, and neither may refuse the save the
    // reader is actually asking for.
    if (endpointFieldState(url) === 'empty') continue
    try {
      out[protocol as AssistantProtocol] = vetBaseUrl(url)
    } catch (error) {
      // Name the box that failed: a bare 400 for a field the reader never meant to fill reads as
      // "adding a provider is broken".
      const reason = error instanceof Error ? error.message : 'not a usable address'
      throw ApiError.badRequest(`The ${protocol} endpoint address is not usable: ${reason}`)
    }
  }
  return out
}

function vetBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A provider address is required.')
  const trimmed = value.trim()
  try {
    assertRelayableEndpoint(trimmed)
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'That provider address is not allowed.')
  }
  return trimmed.slice(0, 300)
}

// -------------------------------------------------------------------- models

assistantRoutes.get('/models', async (c) => c.json({ models: await store(c).listModels() }))

assistantRoutes.post('/models', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const providerId = requiredId(body.providerId)
  if (!(await s.getProvider(providerId))) throw ApiError.badRequest('That provider does not exist.')
  const model = text(body.model, 120).replace(/\s+/g, '')
  const created = await s.createModel({
    providerId,
    model,
    label: optionalText(body.label, 60) ?? model,
    temperature: typeof body.temperature === 'number' ? Math.min(1.5, Math.max(0, body.temperature)) : null,
    // The same range the patch above accepts: a model's own ceiling is not the account's, and the editor
    // offers presets well past 8192, so clamping here quietly stored something other than what was picked.
    maxOutputTokens: clampTokens(body.maxOutputTokens, 64, MAX_TOKEN_CEILING),
    reasoning: reasoningValue(body.reasoning),
    contextTokens: contextBudgetValue(body.contextTokens),
    vision: body.vision === undefined ? true : Boolean(body.vision),
    protocol: pickValue(body.protocol, ASSISTANT_PROTOCOLS) ?? null,
  })
  return c.json({ model: created }, 201)
})

/** A token count the reader typed: clamped into range, and null means "leave it unset". */
function clampTokens(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Math.trunc(Number(value))
  if (!Number.isFinite(numeric)) return null
  return Math.min(max, Math.max(min, numeric))
}

function pickValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

/** A per-million-token price, or null for a model the reader has not priced. */
function price(value: unknown): number | null {
  if (value === null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.min(numeric, 1_000_000) : null
}

assistantRoutes.patch('/models/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const updated = await s.updateModel(id, {
    ...(body.label !== undefined ? { label: text(body.label, 60) } : {}),
    ...(body.model !== undefined ? { model: text(body.model, 120).replace(/\s+/g, '') } : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature === null ? null : Math.min(1.5, Math.max(0, Number(body.temperature))) }
      : {}),
    ...(body.maxOutputTokens !== undefined
      ? { maxOutputTokens: body.maxOutputTokens === null ? null : clampTokens(body.maxOutputTokens, 64, MAX_TOKEN_CEILING) }
      : {}),
    // An unrecognised value is dropped rather than defaulted: falling back here would quietly reset
    // what the reader had already chosen.
    ...(pickValue(body.purpose, ASSISTANT_MODEL_PURPOSES) !== undefined ? { purpose: pickValue(body.purpose, ASSISTANT_MODEL_PURPOSES) } : {}),
    ...(pickValue(body.kind, ASSISTANT_MODEL_KINDS) !== undefined ? { kind: pickValue(body.kind, ASSISTANT_MODEL_KINDS) } : {}),
    // Null is a value here: it is the reader putting the model back on the provider's own protocol.
    ...(body.protocol !== undefined ? { protocol: pickValue(body.protocol, ASSISTANT_PROTOCOLS) ?? null } : {}),
    ...(body.supportsTools !== undefined ? { supportsTools: Boolean(body.supportsTools) } : {}),
    ...(body.maxInputTokens !== undefined ? { maxInputTokens: clampTokens(body.maxInputTokens, 1, MAX_TOKEN_CEILING) } : {}),
    // An unknown modality is dropped, not defaulted: a list of one typo must not silently reset the
    // whole set the reader had already picked.
    ...(Array.isArray(body.modalities) ? { modalities: parseModelModalities(body.modalities) } : {}),
    ...(body.topP !== undefined
      ? { topP: body.topP === null ? null : Math.min(1, Math.max(0, Number(body.topP))) }
      : {}),
    ...(body.customParams !== undefined ? { customParams: parseCustomParams(body.customParams) } : {}),
    ...(body.reasoning !== undefined ? { reasoning: reasoningValue(body.reasoning) } : {}),
    ...(body.contextTokens !== undefined ? { contextTokens: contextBudgetValue(body.contextTokens) } : {}),
    ...(body.vision !== undefined ? { vision: Boolean(body.vision) } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    // A price is a number the reader read off a bill or a pricing page, so it is taken as given and only
    // kept out of the negatives. Null clears it, which is how a model stops being counted into a total.
    ...(body.inputPrice !== undefined ? { inputPrice: price(body.inputPrice) } : {}),
    ...(body.outputPrice !== undefined ? { outputPrice: price(body.outputPrice) } : {}),
    ...(body.priceCurrency !== undefined ? { priceCurrency: text(body.priceCurrency, 8).toUpperCase() } : {}),
  })
  if (!updated) throw ApiError.notFound('Model not found')
  return c.json({ model: updated })
})

assistantRoutes.delete('/models/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getModel(id))) throw ApiError.notFound('Model not found')
  await s.deleteModel(id)
  const settings = await s.getSettings()
  if (settings.activeModelId === id) {
    await s.saveSettings({ ...settings, activeModelId: await suggestActiveModel(s, { ...settings, activeModelId: null }) })
  }
  return c.json({ deleted: true })
})

// --------------------------------------------------------------------- usage

assistantRoutes.get('/usage', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const day = new Date().toISOString().slice(0, 10)
  const weekStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const [today, week] = await Promise.all([s.todayUsage(), s.usageRange(weekStart, day)])
  return c.json({ day, today, last7Days: week, limits: settings.limits })
})

/**
 * What the assistant has spent, per day and per model.
 *
 * `range` is a window rather than a pair of dates because the screen offers three windows and nothing
 * else: a reader picking "last 30 days" is asking about a window, and a caller free to send arbitrary
 * dates could only ask the same question with more ways to get it wrong.
 *
 * Cost is summed per currency and never across them. A model the reader has not priced is reported as
 * unpriced rather than as free: "no price" and "costs nothing" are different claims, and a total that
 * silently treats one as the other is worse than no total.
 */
assistantRoutes.get('/stats', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const asked = c.req.query('range')
  const range = asked === '30' ? 30 : asked === 'all' ? 0 : 7
  const day = usageDay()
  const from = range === 0 ? (await s.firstUsageDay()) ?? day : dayBefore(day, range - 1)
  // A filter narrows the window to one model, one provider key, or both. `key` is `providerId` or
  // `providerId:keyId`; the key half is empty until a provider carries more than one key.
  const filter: UsageFilter = {}
  const modelParam = c.req.query('model')?.trim()
  if (modelParam) filter.model = modelParam.slice(0, 120)
  const keyParam = c.req.query('key')?.trim()
  if (keyParam) {
    const [providerId, keyId] = keyParam.split(':')
    if (providerId) filter.providerId = providerId.slice(0, 60)
    if (keyId !== undefined) filter.keyId = keyId.slice(0, 60)
  }
  // Only the dimension table can answer a filtered question: the plain day table has no model or key.
  const narrowed = Boolean(filter.model || filter.providerId)
  const [total, days, modelRows, keyRows, conversations, models] = await Promise.all([
    narrowed ? s.usageRangeIn(from, day, filter) : s.usageRange(from, day),
    narrowed ? s.usageDaysIn(from, day, filter) : s.usageDays(from, day),
    narrowed ? s.modelUsageRangeIn(from, day, filter) : s.modelUsageRange(from, day),
    s.keyUsageRange(from, day),
    s.usageByConversation(from, day),
    s.listModels(),
  ])
  const spend = new Map<string, number>()
  let unpriced = 0
  const byModel = modelRows.map((row) => {
    const model = models.find((entry) => entry.label === row.modelLabel || entry.model === row.modelLabel)
    const base = {
      label: row.modelLabel,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      toolCalls: row.toolCalls,
      errors: row.errors,
    }
    if (!model || (model.inputPrice === null && model.outputPrice === null)) {
      unpriced++
      return { ...base, currency: '', cost: null }
    }
    const currency = model.priceCurrency || 'USD'
    const cost = ((model.inputPrice ?? 0) * row.inputTokens + (model.outputPrice ?? 0) * row.outputTokens) / 1_000_000
    spend.set(currency, (spend.get(currency) ?? 0) + cost)
    return { ...base, currency, cost }
  })
  return c.json({
    range: range === 0 ? 'all' : String(range),
    from,
    to: day,
    total,
    days,
    models: byModel,
    keys: foldKeyUsage(keyRows, models),
    // Built from the key rows, which the filter never narrows, so picking one filter cannot empty the
    // other picker.
    modelOptions: [...new Set(keyRows.map((row) => row.modelLabel).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    conversations,
    spend: [...spend].map(([currency, amount]) => ({ currency, amount })),
    unpricedModels: unpriced,
    generatedAt: Date.now(),
    limits: settings.limits,
  })
})

/**
 * Folds the per-(key, model) rows into one row per key, pricing each model's tokens as it goes.
 *
 * A key that paid for two models is one row here, because the reader rotates keys and not models — the
 * model split is what the `models` list already answers. Cost is kept per currency and never summed
 * across them, the same rule the model rows follow.
 */
function foldKeyUsage(
  rows: Awaited<ReturnType<ReturnType<typeof store>['keyUsageRange']>>,
  models: AssistantModel[],
): AssistantKeyUsage[] {
  const byKey = new Map<string, AssistantKeyUsage>()
  const spend = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const id = `${row.providerId}\u0000${row.keyId}`
    const entry = byKey.get(id) ?? {
      providerId: row.providerId,
      providerLabel: row.providerLabel,
      keyId: row.keyId,
      keyLabel: row.keyLabel,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      errors: 0,
      costs: [],
      unpriced: false,
    }
    entry.requests += row.requests
    entry.inputTokens += row.inputTokens
    entry.outputTokens += row.outputTokens
    entry.toolCalls += row.toolCalls
    entry.errors += row.errors
    byKey.set(id, entry)
    const model = models.find((candidate) => candidate.label === row.modelLabel || candidate.model === row.modelLabel)
    if (!model || (model.inputPrice === null && model.outputPrice === null)) {
      // Only a row that names a model can be unpriced. A bare request charge carries no model and
      // prices nothing, so it must not mark the whole key as unpriced.
      if (row.modelLabel) entry.unpriced = true
      continue
    }
    const currency = model.priceCurrency || 'USD'
    const cost = ((model.inputPrice ?? 0) * row.inputTokens + (model.outputPrice ?? 0) * row.outputTokens) / 1_000_000
    const perCurrency = spend.get(id) ?? new Map<string, number>()
    perCurrency.set(currency, (perCurrency.get(currency) ?? 0) + cost)
    spend.set(id, perCurrency)
  }
  for (const [id, perCurrency] of spend) {
    const entry = byKey.get(id)
    if (entry) entry.costs = [...perCurrency].map(([currency, amount]) => ({ currency, amount }))
  }
  return [...byKey.values()].sort((left, right) => (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens))
}

assistantRoutes.get('/activity', async (c) => c.json({ activity: await store(c).listActivity(100) }))

// -------------------------------------------------------------- export/import

assistantRoutes.get('/export', async (c) => {
  const s = store(c)
  const payload = await exportAssistant(s)
  await s.recordActivity('data.exported', 'assistant backup downloaded')
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="inkstone-assistant-backup.json"',
    },
  })
})

assistantRoutes.post('/import', async (c) => {
  const s = store(c)
  // A backup is a file the reader picked, so it is read under the same byte ceiling as the other
  // whole-store imports rather than handed to `req.json()` uncapped.
  const raw = await readJson<Record<string, unknown>>(c, 4 * 1024 * 1024)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw ApiError.badRequest('The backup is not a JSON object.')
  const summary = await importAssistant(s, raw as Record<string, unknown>)
  await s.recordActivity('data.imported', `backup imported (${summary.conversations} conversation(s))`)
  return c.json({ imported: summary })
})
