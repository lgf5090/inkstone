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
  MAX_MCP_TOOL_OVERRIDES,
  mcpToolModeFor,
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
  type AssistantMcpToolMode,
  type AssistantMcpTransport,
  ASSISTANT_MODEL_PURPOSES,
  ASSISTANT_PROTOCOLS,
  ASSISTANT_TOOL_SPECS,
  parseCustomParams,
  MAX_PROJECT_NOTES,
  MAX_TURN_SCOPES,
  MAX_TURN_TOOLS,
  AUTOMATION_KINDS,
  MAX_AUTOMATION_MESSAGE_CHARS,
  MAX_AUTOMATION_TARGET_ID_CHARS,
  MAX_CONVERSATION_TITLE_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_BACKUP_BYTES,
  CONVERSATION_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  MAX_ARTIFACT_CONTENT_CHARS,
  MAX_ARTIFACT_TITLE_CHARS,
  MAX_ARTIFACTS_PER_CONVERSATION,
  MAX_MEMORY_CHARS,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_ICON_CHARS,
  MAX_SKILL_TITLE_CHARS,
  MAX_SKILL_BUNDLE_SKILLS,
  skillBundleOf,
  type SkillImportSkip,
  MAX_TASK_NOTES_CHARS,
  MAX_TASK_TITLE_CHARS,
  MEMORY_REVIEW_ACTIONS,
  MESSAGE_FEEDBACK,
  MAX_FEEDBACK_REASON_CHARS,
  SAVED_MESSAGE_PAGE_SIZE,
  type MessageFeedback,
  ASSISTANT_SETTING_KEYS,
  normalizeAssistantSettings,
  titleFromMessage,
  type AssistantMemoryCategory,
  type AssistantMessage,
  type AssistantProtocol,
  type AssistantSettings,
  type AssistantTurnScope,
  type MemoryReviewAction,
  type TaskPriority,
  type TaskStatus,
  type AssistantKeyUsage,
  type AssistantModel,
  type AssistantConversation,
  type AssistantAnswerVersion,
  type AssistantUsageDay,
  type AssistantUsageSlice,
  type UsageFilter,
} from '@shared/assistant'
import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { localDayBounds, parseLocalTime } from '@shared/assistant-time'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { FORM_BODY_LIMITS, JSON_BODY_LIMITS, readFormDataWithinLimit, readJson, readStreamWithinLimit } from '../lib/request'
import { fetchProviderBalance } from '../assistant/balance'
import { McpError, mcpCallTool, mcpInitialize, mcpListTools, mcpProbe, mcpUrlProblem } from '../assistant/mcp-client'
import { isExternalToolName, listMcpCatalog, loadExternalTools } from '../assistant/mcp-tools'
import { deleteMcpOAuthClient, finishMcpAuthorization, startMcpAuthorization, withMcpOAuthHeaders } from '../assistant/mcp-oauth'
import { isValidId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { ArtifactVersionConflictError, AssistantStore, dayBefore, type ConversationCursor } from '../assistant/store'
import { MemoryHistoryService } from '../assistant/memory-service'
import { AutomationService } from '../assistant/automations'
import { AssistantRunner } from '../assistant/runner'
import {
  MODELBEST_INIT_FALLBACK_MS,
  MODELBEST_MAX_FRAME_CHARS,
  isModelBestEndpoint,
  mintRealtimeSession,
  modelBestSessionInit,
  modelBestSocketUrl,
  RealtimeSessionError,
  type RealtimeRelayDescriptor,
} from '../assistant/realtime'
import { cancelApprovedAction, runApprovedAction } from '../assistant/tools'
import { exportAssistant, importAssistant } from '../assistant/backup'
import { describeSubscription, pushConfigStatus, pushEndpointProblem, pushKeyProblem, vapidProblem, type PushSubscriptionView } from '../assistant/push'
import { importSessionFile, MAX_SESSION_FILE_BYTES, SESSION_IMPORT_BODY_BYTES } from '../assistant/session-import'
import { ChatShareStore, conversationSharePasswordHash, messageScope, MAX_SHARED_PICK, type ChatShareRow } from '../assistant/share'
import { suggestActiveModel } from '../assistant/model-config'
import { listVendorModels } from '../assistant/vendor-models'
import { memoryEmbeddingStatus, reindexMemoryEmbeddings, semanticModel } from '../assistant/semantic'
import { MAX_PROVIDER_MODELS, reasoningDialectValue, reasoningValue, searchEndpointValue } from '@shared/assistant'
import { MAX_SEARCH_KEY_CHARS, isWebSearchEngineId, webSearchEngineFor } from '@shared/web-search-engines'
import { balanceSpecFor } from '@shared/provider-balance'
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


/** A skill field: trimmed and capped, and empty is allowed here because the pair is checked together. */
function optionalSkillText(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  return value.trim().slice(0, max)
}

/**
 * A field the reader may empty on purpose.
 *
 * Absent, `null` and `''` all mean the same thing here — "put it back to nothing" — because the editor
 * forms send the whole draft, including the boxes they never filled. Read one of those with `text` and the
 * answer is "This cannot be empty.", which refuses the request and every other field travelling with it.
 */
function optionalTextAllowEmpty(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  return value.trim().slice(0, max)
}

function text(value: unknown, max: number, empty = 'This cannot be empty.'): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A text value is required.')
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest(empty)
  return trimmed.slice(0, max)
}

/**
 * The currency a model's price is written in, or `''` for a model that has not been priced.
 *
 * `''` is the column's default and the answer for every model until somebody reads a number off a pricing
 * page, so it is a value rather than a missing one; the store hands it back the same way and the editor
 * sends it in its draft. Nothing is substituted here — a currency invented for an unpriced model would put
 * a figure on the usage screen that nobody typed, under a sign nobody chose.
 */
function currencyValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw ApiError.badRequest('A currency code has to be text.')
  return value.trim().slice(0, 8).toUpperCase()
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

/**
 * A page boundary, encoded so the browser treats it as opaque.
 *
 * The client hands the string back verbatim. It is not a capability — every query below is scoped to the
 * reader — but it is the list's own position, and letting a caller compose one would only invite a
 * malformed tuple that the SQL would have to defend against.
 */
function encodeListCursor(value: { pinned: boolean, updatedAt: number, id: string }): string {
  return btoa(`${value.pinned ? 1 : 0}:${value.updatedAt}:${value.id}`)
}

function decodeListCursor(raw: string): ConversationCursor | null {
  try {
    const [pinned, updatedAt, id] = atob(raw).split(':')
    if ((pinned !== '0' && pinned !== '1') || !/^\d{1,16}$/.test(updatedAt ?? '') || !isValidId(id ?? '')) return null
    return { pinned: Number(pinned), updatedAt: Number(updatedAt), id: id! }
  } catch {
    return null
  }
}

/** The same for a thread: the oldest message already on screen, and the page before it. */
function encodeMessageCursor(message: { createdAt: number, id: string }): string {
  return btoa(`${message.createdAt}:${message.id}`)
}

function decodeMessageCursor(raw: string): { createdAt: number, id: string } | null {
  try {
    const [createdAt, id] = atob(raw).split(':')
    if (!/^\d{1,16}$/.test(createdAt ?? '') || !isValidId(id ?? '')) return null
    return { createdAt: Number(createdAt), id: id! }
  } catch {
    return null
  }
}

/** A page size the caller asked for, kept between one row and the ceiling the query can afford. */
function pageSize(raw: string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number(raw ?? '')
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(Math.floor(parsed), ceiling)
}

/** The same pair for the shelf of kept answers: the last row a page showed, and what comes after it. */
function encodeSavedCursor(row: { savedAt: number, id: string }): string {
  return btoa(`${row.savedAt}:${row.id}`)
}

function decodeSavedCursor(raw: string): { savedAt: number, id: string } | null {
  try {
    const [savedAt, id] = atob(raw).split(':')
    if (!/^\d{1,16}$/.test(savedAt ?? '') || !isValidId(id ?? '')) return null
    return { savedAt: Number(savedAt), id: id! }
  } catch {
    return null
  }
}

// -------------------------------------------------------------- conversations

/**
 * The conversations that wrote one note.
 *
 * The notebook's backlink panel asks this beside the note's own `[[links]]`, because a note the assistant
 * wrote has none: what points at it is a conversation, and a conversation is not a note. The note id is
 * validated by shape and the store's own `user_id` filter bounds what a foreign id could reach, so this
 * route cannot be used to read another account's threads.
 */
assistantRoutes.get('/note-writes', async (c) => {
  const noteId = requiredId(c.req.query('noteId'))
  return c.json({ conversations: await store(c).noteWriteOrigins(noteId) })
})

/**
 * Record that the reader's own save wrote a note.
 *
 * The model's `create_note` tool files this row itself, but a note made from a reply is written by the
 * browser and never passes through the worker. The row is the note's "from a conversation" backlink,
 * so the client reports it after the note exists; an absent report leaves the note intact and only its
 * backlink missing. Both ids are checked, and the conversation has to be this account's: the panel joins
 * the row back to a thread, and a thread id from somewhere else would be a link with nothing at the end.
 */
assistantRoutes.post('/note-writes', async (c) => {
  const body = await readJson<{ noteId?: unknown, conversationId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const noteId = requiredId(body.noteId)
  const conversationId = requiredId(body.conversationId)
  const s = store(c)
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Not found')
  await s.recordNoteWrite(noteId, conversationId)
  return c.json({ ok: true })
})

assistantRoutes.get('/conversations', async (c) => {
  const query = c.req.query('q')?.trim().slice(0, 200)
  const folder = c.req.query('folder')
  const project = c.req.query('project')
  const tag = c.req.query('tag')?.trim().slice(0, 26)
  const note = c.req.query('noteId')
  const filter: { folderId?: string | null, projectId?: string | null, noteId?: string, tagId?: string, starred?: boolean, pinned?: boolean, archived?: boolean } = {}
  // `folder=none` is the unfiled view; an absent parameter is the whole list.
  if (folder !== undefined) filter.folderId = folder === 'none' ? null : (isValidId(folder) ? folder : 'none')
  // `project=none` reads the conversations that answer under no brief, the same convention as the folder filter.
  if (project !== undefined) filter.projectId = project === 'none' ? null : (isValidId(project) ? project : 'none')
  // A named note narrows to the threads started from it. An id of the wrong shape can only match nothing —
  // never the whole list, which would answer the reader's question with everything they asked to filter out.
  if (note !== undefined) filter.noteId = isValidId(note) ? note : ''
  if (tag) filter.tagId = tag
  if (c.req.query('starred') === '1') filter.starred = true
  if (c.req.query('pinned') === '1') filter.pinned = true
  // Only `1` and `0` narrow this: an absent parameter is every conversation, archived ones included, which
  // is what a caller with no opinion about filing should get.
  if (c.req.query('archived') === '1') filter.archived = true
  else if (c.req.query('archived') === '0') filter.archived = false
  const cursorParam = c.req.query('cursor')
  const cursor = cursorParam ? decodeListCursor(cursorParam) : null
  if (cursorParam && !cursor) throw ApiError.badRequest('Unknown cursor.')
  const limit = pageSize(c.req.query('limit'), CONVERSATION_PAGE_SIZE, 100)
  // One row past the page says whether there is another without a second count over the same filter.
  const page = await store(c).listConversations(query || undefined, { ...filter, limit: limit + 1, cursor })
  const hasMore = page.length > limit
  const conversations = hasMore ? page.slice(0, limit) : page
  const last = conversations[conversations.length - 1]
  return c.json({ conversations, nextCursor: hasMore && last ? encodeListCursor(last) : null })
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
  // An untitled thread is a real state the reader returns to, not a missing value: '' is what the row
  // stores for it, so an explicitly empty title must not 400 the whole create.
  const title = optionalTextAllowEmpty(body.title, MAX_CONVERSATION_TITLE_CHARS)
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
  if (body.description !== undefined) out.description = optionalTextAllowEmpty(body.description, MAX_MCP_DESCRIPTION_CHARS)
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
  // The exceptions are keyed by the server's own tool names, so the map is only ever bounded strings
  // against the three words: the model is never handed a name this route invented, and a name the server
  // does not offer simply stops matching anything.
  let toolModes: Record<string, AssistantMcpToolMode> | undefined
  if (body.toolModes !== undefined) {
    const raw = body.toolModes
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw ApiError.badRequest('toolModes must be an object')
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length > MAX_MCP_TOOL_OVERRIDES) {
      throw ApiError.badRequest(`At most ${MAX_MCP_TOOL_OVERRIDES} tools can be answered for`)
    }
    toolModes = {}
    for (const [name, mode] of entries) {
      const trimmed = name.trim()
      const chosen = pickValue(mode, ASSISTANT_MCP_TOOL_MODES)
      if (!trimmed || trimmed.length > MAX_MCP_TOOL_NAME_CHARS || chosen === undefined) continue
      toolModes[trimmed] = chosen
    }
  }
  const updated = await s.updateMcpServer(id, {
    ...(body.label !== undefined ? { label: text(body.label, MAX_MCP_LABEL_CHARS) } : {}),
    ...(url === undefined ? {} : { url }),
    ...mcpServerFields(body),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(pickValue(body.toolMode, ASSISTANT_MCP_TOOL_MODES) !== undefined ? { toolMode: pickValue(body.toolMode, ASSISTANT_MCP_TOOL_MODES) } : {}),
    ...(toolModes === undefined ? {} : { toolModes }),
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
    if (mcpToolModeFor(server, tool.remoteName) === 'off') throw ApiError.conflict('That function is switched off on its card.')
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

/**
 * Log the reader out: take the token away and leave the registration alone.
 *
 * Not the same press as the one below. A reader clearing a token means "stop using my account for now";
 * the client this app registered at the issuer is still theirs, and re-authorizing reuses it.
 */
assistantRoutes['delete']('/mcp/:id/authorize', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const record = await s.mcpServerRecord(id)
  if (!record) throw ApiError.notFound('Server not found')
  await s.revokeMcpTokens(id)
  await s.recordActivity('mcp.revoked', `${record.row.label}: authorization revoked`)
  return c.json({ ok: true })
})

/**
 * Withdraw the client registration itself, at the issuer and here.
 *
 * A different act from the one above, and deliberately a different route: this tells the third party to
 * forget that this app ever registered, using the address and token its registration endpoint handed back.
 * A client the reader registered by hand cannot be withdrawn remotely — nothing was ever given that could
 * — so the answer says plainly whether the issuer was told, rather than reporting a success it did not have.
 */
assistantRoutes['delete']('/mcp/:id/client', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const record = await s.mcpServerRecord(id)
  if (!record) throw ApiError.notFound('Server not found')
  const found = await s.mcpAuthorization(id)
  const registration = found?.secrets.registration ?? null
  const revokedAtIssuer = registration ? await deleteMcpOAuthClient((input, init) => fetch(input, init), registration) : false
  await s.forgetMcpClient(id)
  await s.recordActivity('mcp.client_revoked', `${record.row.label}: client registration withdrawn`)
  return c.json({ ok: true, revokedAtIssuer })
})

assistantRoutes.get('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const conversation = await s.getConversation(id)
  if (!conversation) throw ApiError.notFound('Conversation not found')
  const actions = await s.actionStatesForConversation(id)
  // A thread is read from its end: the newest page is what opening it costs, and the turns above it
  // arrive when the reader scrolls up and asks. `before` is the oldest row already on screen.
  const limit = pageSize(c.req.query('limit'), MESSAGE_PAGE_SIZE, 500)
  const beforeParam = c.req.query('before')
  const before = beforeParam ? decodeMessageCursor(beforeParam) : null
  if (beforeParam && !before) throw ApiError.badRequest('Unknown cursor.')
  // A search hit opens the thread at the hit rather than at the newest page, so the reader lands on the
  // words they were looking for instead of scrolling back through everything written since. The id is
  // the hit's own message, and it has to be this thread's: a foreign id would otherwise ask a page to
  // end somewhere it has no row.
  const uptoParam = c.req.query('upto')
  let upto: { createdAt: number, id: string } | null = null
  if (uptoParam) {
    if (!isValidId(uptoParam)) throw ApiError.badRequest('Unknown cursor.')
    const hit = await s.getMessage(uptoParam)
    if (!hit || hit.conversationId !== id) throw ApiError.notFound('Message not found')
    upto = { createdAt: hit.createdAt, id: hit.id }
  }
  const page = await s.messages(id, limit + 1, { before, upto })
  const hasMore = page.length > limit
  const messages = (hasMore ? page.slice(1) : page).map((message) => ({
    ...message,
    tools: message.tools.map((tool) => (tool.approval
      ? { ...tool, approval: actions.get(tool.approval.id) ?? tool.approval }
      : tool)),
  }))
  // A window that ends at a search hit may have newer turns below it; the reader can go on reading from
  // there, and the button that takes them back to the live end says so.
  const newest = upto ? await s.lastMessage(id) : null
  const hasNewer = Boolean(upto && newest && messages.at(-1)?.id !== newest.id)
  const withTags = await s.tagsForConversations([id])
  if (conversation) conversation.tags = withTags.get(id) ?? []
  // The chips name the files; the bytes only ever travel on the model's turn, so the transcript needs
  // the rows and not the contents.
  const wanted = [...new Set(messages.flatMap((entry) => entry.attachments ?? []))]
  // The claim on this conversation answers two questions, and the second one is the reason this is a read
  // of the row rather than `isRunning`. A Worker isolate killed by its CPU limit never reaches `finish`, so
  // it files no assistant row — and the lease it was holding goes on claiming the conversation for the rest
  // of its window. Asked only "is a turn live?", a reader came back to nothing, the watch timed out and
  // said so in a toast, and the words the model had already written were gone. Both halves travel together
  // now: `streaming` for the turn somebody is still holding, `partialText` for the answer the dead one left
  // on the claim, and `partialTruncated` so the screen can say it is showing only the beginning of it.
  //
  // Reporting the claim is the whole of what this read does with it. Filing the fragment as a turn is
  // `claimRun`'s job — a read that wrote the row would also delete the claim whose text it has just handed
  // the screen, so the reader would have to re-open the thread to keep the words they were shown.
  //
  // Scoped by the account like everything else on this table, and reached only after the conversation's own
  // ownership check above: no reader gets another's half answer, however they name the thread.
  const lease = await s.readRunLease(id)
  // A claim that is neither live nor holding anything is the stale marker this read used to clear, and it
  // still is: only a fragment is a reason to leave a row standing, and `releaseRun` is guarded by the token
  // this read saw, so a turn that claimed the conversation in between keeps its claim.
  if (lease.claimed && !lease.running && !lease.text && lease.token !== null) await s.releaseRun(id, lease.token)
  return c.json({
    conversation,
    messages,
    attachments: await s.chatAttachments(wanted),
    streaming: lease.running,
    partialText: lease.text,
    partialTruncated: lease.truncated,
    hasMore,
    nextBefore: hasMore && messages[0] ? encodeMessageCursor(messages[0]) : null,
    hasNewer,
  })
})

/**
 * One conversation as a file.
 *
 * The Markdown export is a document to read; this one is the record — every stored field, plus the
 * answers the thread could page back to — so a conversation can leave the app without losing the parts
 * the transcript does not print. It is not the backup format: this is one thread, and it is not meant
 * to be imported.
 */
assistantRoutes.get('/conversations/:id/export', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const conversation = await s.getConversation(id)
  if (!conversation) throw ApiError.notFound('Conversation not found')
  // Every turn, not the newest page: an export is a document the reader keeps, and one that quietly
  // starts 500 messages in looks exactly like a complete one.
  const messages = await s.allMessages(id)
  // Only the turns that actually displaced something: one query per answer that has pages, not per turn.
  const versions: AssistantAnswerVersion[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.versionCount) continue
    versions.push(...await s.listAnswerVersions(message.id))
  }
  return c.json({
    format: 'inkstone-conversation',
    version: 1,
    exportedAt: Date.now(),
    conversation,
    messages,
    versions,
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
  const body = await readJson<{ content?: unknown, keepBranch?: unknown, branchTitle?: unknown }>(c, JSON_BODY_LIMITS.small)
  const content = text(body.content, MAX_MESSAGE_CHARS)
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (message.role !== 'user') throw ApiError.badRequest('Only your own message can be edited.')
  if (message.source === 'import') throw ApiError.conflict('A message restored from a backup cannot be edited.')
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  // What the edit takes with it is read from the turn's own place in the thread. Scanning the newest page
  // for it 404'd on any question older than that page, so a long conversation could not be edited at all.
  const later = await s.messagesAfter(conversationId, messageId)
  // An edit removes every turn after it, and those turns were drawn from words that are about to change.
  // A reader who wants them back gets the whole thread copied into a branch first: the copy is made
  // before a row is deleted, so the recovery path is a real one rather than a version nobody can reach.
  let branch: AssistantConversation | null = null
  if (body.keepBranch === true && later.length) {
    const asked = typeof body.branchTitle === 'string' ? body.branchTitle.trim() : ''
    const source = await s.getConversation(conversationId)
    const title = (asked || source?.title || 'Untitled').slice(0, MAX_CONVERSATION_TITLE_CHARS)
    branch = await s.forkConversation(conversationId, later[later.length - 1]!.id, title)
  }
  await s.updateMessageContent(messageId, content)
  for (const entry of later) await s.deleteMessage(entry.id)
  await s.clearSummary(conversationId)
  return c.json({ message: await s.getMessage(messageId), removed: later.length, branch })
})

assistantRoutes.delete('/conversations/:id/messages/:messageId', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (await s.isRunning(conversationId)) throw ApiError.conflict('Stop the running reply first.')
  // A turn is a pair, and half of one is a question with no answer under it: the reply that followed the
  // reader's own row goes too. Anything after that pair is a turn the reader has not touched. The pair is
  // read by position under the named row, so a turn above the newest page of a long thread is deletable.
  const [answer] = await s.messagesAfter(conversationId, messageId, 1)
  const removed = message.role === 'user' && answer?.role === 'assistant' ? [message, answer] : [message]
  for (const entry of removed) await s.deleteMessage(entry.id)
  await s.clearSummary(conversationId)
  // The page the screen redraws from, which is deliberately still a page.
  return c.json({ removed: removed.map((entry) => entry.id), messages: await s.messages(conversationId) })
})

assistantRoutes.patch('/conversations/:id/messages/:messageId/feedback', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  const body = await readJson<{ feedback?: unknown, reason?: unknown }>(c, JSON_BODY_LIMITS.small)
  // `null` is a real answer here — the reader pressing the same thumb twice takes it back — and an
  // unknown word is refused rather than stored, so a client that invents a third verdict finds out.
  const asked = body.feedback
  const feedback = asked === null
    ? null
    : typeof asked === 'string' && (MESSAGE_FEEDBACK as readonly string[]).includes(asked)
      ? asked as MessageFeedback
      : undefined
  if (feedback === undefined) throw ApiError.badRequest('A verdict is "up", "down" or null.')
  // A downvote may say what was wrong; an upvote may not, and clearing the verdict clears the reason with it.
  let reason: string | undefined
  if (body.reason !== undefined && body.reason !== null) {
    if (feedback !== 'down') throw ApiError.badRequest('Only a downvote can carry a reason.')
    if (typeof body.reason !== 'string') throw ApiError.badRequest('A reason must be text.')
    // Control characters are stripped so the value cannot smuggle a terminal escape or a line break into a
    // log or a screen; the whole thing is then bounded to the one field's length.
    const cleaned = body.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_FEEDBACK_REASON_CHARS)
    if (cleaned) reason = cleaned
  }
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  if (message.role !== 'assistant') throw ApiError.badRequest('Only an answer can be rated.')
  await s.setMessageFeedback(messageId, feedback, reason)
  return c.json({ message: await s.getMessage(messageId) })
})

/**
 * Keep one answer, or take it back off the shelf.
 *
 * A press toggles and nothing else: there is no body to read, so there is no state a client can claim and
 * have refused. The answer is the row re-read after the write, which is the only version of the truth this
 * route can give — a response computed from what the request asked for would say "kept" about a turn that
 * was deleted while the statement was in flight, and the shelf would then hold a mark nobody stored.
 *
 * The pairing check is the one every other turn route makes, and it is not decoration: it is what stops a
 * request naming one conversation and another's message, which the account filter alone would let through
 * because both rows belong to the reader.
 */
assistantRoutes.post('/conversations/:id/messages/:messageId/saved', async (c) => {
  const s = store(c)
  const conversationId = requiredId(c.req.param('id'))
  const messageId = requiredId(c.req.param('messageId'))
  if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  const message = await s.getMessage(messageId)
  if (!message || message.conversationId !== conversationId) throw ApiError.notFound('Message not found')
  const flipped = await s.toggleMessageSaved(messageId)
  if (!flipped) throw ApiError.notFound('Message not found')
  return c.json({ conversationId, messageId, saved: flipped.saved, savedAt: flipped.savedAt })
})

/**
 * The answers the reader has kept, newest kept first, each with the thread it belongs to.
 *
 * The thread comes back with the row because the shelf's one job is getting the reader back to an answer:
 * a list of message ids they cannot open is a list of nothing. Page bounds are opaque cursors over the
 * order the list uses, so a keep made while the reader is scrolling cannot repeat a row or drop one.
 */
assistantRoutes.get('/saved-messages', async (c) => {
  const cursorParam = c.req.query('cursor')
  const cursor = cursorParam ? decodeSavedCursor(cursorParam) : null
  // A cursor that does not decode is a caller composing one, not a reader at the end of a shelf: refused
  // rather than answered with the first page, which would quietly show the same rows twice.
  if (cursorParam && !cursor) throw ApiError.badRequest('Unknown cursor.')
  const limit = pageSize(c.req.query('limit'), SAVED_MESSAGE_PAGE_SIZE, 100)
  const s = store(c)
  // One row past the page, trimmed back: the same trick the conversation list uses to say whether there is
  // more without a second count over the filter.
  const page = await s.listSavedMessages({ limit: limit + 1, before: cursor })
  const hasMore = page.length > limit
  const items = hasMore ? page.slice(0, limit) : page
  const last = items[items.length - 1]
  return c.json({ items, nextCursor: hasMore && last ? encodeSavedCursor(last) : null })
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
 * The turns a share request names. Absent, or nothing, is the whole thread — which is what every link
 * made before a reader could pick meant, and what a link for the whole of it still means.
 *
 * Only the shape is checked here. Whether those turns are really in the conversation is a separate
 * question, and one only creating a link has to answer: a read or a revoke names the link that exists,
 * and a reader who has since deleted the messages it pointed at must still be able to find and take down
 * what they published.
 */
function askedMessageIds(asked: unknown): string[] {
  if (asked === undefined || asked === null) return []
  if (!Array.isArray(asked)) throw ApiError.badRequest('messageIds must be an array of message ids')
  const named = [...new Set<unknown>(asked)]
  if (named.length > MAX_SHARED_PICK) throw ApiError.badRequest(`Pick at most ${MAX_SHARED_PICK} messages`)
  const ids: string[] = []
  for (const id of named) {
    if (!isValidId(id)) throw ApiError.badRequest('messageIds must be message ids')
    ids.push(id)
  }
  return ids
}

/** The scope a read or a revoke names, taken from the query string the panel sends. */
function scopeFromQuery(value: string | undefined): unknown {
  if (value === undefined) return undefined
  return value ? value.split(',') : []
}

/**
 * The link a conversation is published behind, if any.
 *
 * Emitted with the origin in it because the reader's next act is to paste it somewhere; the settings
 * panel is the only caller, and a client that had to assemble a URL would be a second place the format
 * lives. The scope comes in the query so the panel can ask about the link it is showing rather than the
 * thread's own, which are two different links once the reader has narrowed one.
 */
assistantRoutes.get('/conversations/:id/share', async (c) => {
  const userId = c.get('userId')
  const conversationId = requiredId(c.req.param('id'))
  const shares = new ChatShareStore(c.env.DB, userId)
  if (!(await shares.liveConversationExists(conversationId))) throw ApiError.notFound('Conversation not found')
  const row = await shares.shareFor(conversationId, messageScope(askedMessageIds(scopeFromQuery(c.req.query('messageIds')))))
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
  const body = await readJson<{ password?: unknown, expiresIn?: unknown, rotate?: unknown, messageIds?: unknown }>(c, JSON_BODY_LIMITS.small)
  const assistant = store(c)
  const shares = new ChatShareStore(c.env.DB, userId)
  if (!(await shares.liveConversationExists(conversationId))) throw ApiError.notFound('Conversation not found')
  const picked = askedMessageIds(body.messageIds)
  // Checked here and only here: this is the one request where the ids came from the reader's screen, so a
  // turn that is not in this conversation is a mistake worth refusing rather than a link worth writing.
  if (picked.length && (await shares.messagesInConversation(conversationId, picked)).length !== picked.length) {
    throw ApiError.badRequest('Those messages are not in this conversation')
  }
  const scope = messageScope(picked)
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
    scope,
    passwordHash: passcode.hash,
    expiresAt,
    now: Date.now(),
    replacePassword: passcode.named,
    replaceExpiry: body.expiresIn !== undefined,
    rotate: body.rotate === true,
  })
  if (!written) throw new ApiError(409, 'conflict', 'Share state changed. Refresh and try again')
  const row = await shares.shareFor(conversationId, scope)
  await assistant.recordActivity('conversation.shared', row!.slug)
  return c.json({ share: conversationShareInfo(row!, new URL(c.req.url).origin) })
})

assistantRoutes.delete('/conversations/:id/share', async (c) => {
  const userId = c.get('userId')
  const conversationId = requiredId(c.req.param('id'))
  const shares = new ChatShareStore(c.env.DB, userId)
  await shares.deleteShare(conversationId, messageScope(askedMessageIds(scopeFromQuery(c.req.query('messageIds')))))
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
  const body = await readJson<{ title?: unknown, pinned?: unknown, starred?: unknown, archived?: unknown, folderId?: unknown, projectId?: unknown, noteId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.title === 'string') await s.renameConversation(id, text(body.title, MAX_CONVERSATION_TITLE_CHARS))
  if (typeof body.pinned === 'boolean') await s.setConversationPinned(id, body.pinned)
  if (typeof body.starred === 'boolean') await s.setConversationStarred(id, body.starred)
  if (typeof body.archived === 'boolean') await s.setConversationArchived(id, body.archived)
  if (body.folderId === null) await s.setConversationFolder(id, null)
  else if (typeof body.folderId === 'string') {
    if (!isValidId(body.folderId) || !(await s.knownFolder(body.folderId))) throw ApiError.badRequest('Unknown folder.')
    await s.setConversationFolder(id, body.folderId)
  }
  // Where the thread came from. Only a note this account owns can be named, and the store keeps the
  // first answer, so a later turn cannot re-label a conversation under the reader.
  // Null is the reader taking the label off — the one write that is allowed to overwrite the first answer,
  // because overwriting is what was asked. An id of the wrong shape is refused rather than dropped: a body
  // that names a note and names nothing must not answer "done" while having changed nothing, which is how a
  // mislabelled thread would stay mislabelled forever.
  if (body.noteId === null) await s.clearConversationNote(id)
  else if (typeof body.noteId === 'string') {
    if (!isValidId(body.noteId) || !(await s.knownNote(body.noteId))) throw ApiError.badRequest('Unknown note.')
    await s.setConversationNote(id, body.noteId)
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

/**
 * The drafts a conversation keeps beside it.
 *
 * They hang off the conversation rather than off a message because the panel is a workspace for the
 * thread, not a property of one turn: a draft started from an answer is edited while the reader keeps
 * talking, and a draft is not a copy of the message it came from — the message stays what it was.
 *
 * The conversation is in every path so the store's own `user_id` filter and the conversation check
 * together bound what a foreign id could reach, the same pairing the answer-version routes use.
 */
assistantRoutes.get('/conversations/:id/branches', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const branches = await s.conversationBranches(id)
  if (!branches) throw ApiError.notFound('Conversation not found')
  return c.json(branches)
})

assistantRoutes.get('/conversations/:id/artifacts', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  return c.json({ artifacts: await s.listArtifacts(id) })
})

assistantRoutes.post('/conversations/:id/artifacts', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const body = await readJson<{ title?: unknown, content?: unknown }>(c, JSON_BODY_LIMITS.artifact)
  // The body is not trimmed: a draft is the document itself, and a code block's own leading whitespace is
  // part of what the reader is editing. Empty after whitespace is still refused, because a draft with
  // nothing in it is not a document the panel can show.
  const raw = body.content
  // An empty draft is a real document the reader is about to type into; it is not a missing value. The
  // panel's "new draft" button depends on this, so only a non-string is refused.
  if (typeof raw !== 'string') throw ApiError.badRequest('A draft needs a body.')
  if (await s.countArtifacts(id) >= MAX_ARTIFACTS_PER_CONVERSATION) {
    throw ApiError.conflict(`A conversation can hold ${MAX_ARTIFACTS_PER_CONVERSATION} drafts.`)
  }
  const title = optionalText(body.title, MAX_ARTIFACT_TITLE_CHARS) ?? ''
  const artifact = await s.createArtifact({ conversationId: id, title, content: raw.slice(0, MAX_ARTIFACT_CONTENT_CHARS), source: 'user' })
  return c.json({ artifact }, 201)
})

assistantRoutes.patch('/conversations/:id/artifacts/:artifactId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const artifactId = requiredId(c.req.param('artifactId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const existing = await s.getArtifact(artifactId)
  if (!existing || existing.conversationId !== id) throw ApiError.notFound('Draft not found')
  const body = await readJson<{
    title?: unknown
    content?: unknown
    noteId?: unknown
    baseVersion?: unknown
    source?: unknown
    messageId?: unknown
  }>(c, JSON_BODY_LIMITS.artifact)
  const patch: { title?: string, content?: string, noteId?: string | null } = {}
  // Empty is a real answer on both fields here: a reader clearing a draft's name has left it untitled, and
  // one clearing its body has emptied it on purpose. Neither is a mistake to be refused.
  if (typeof body.title === 'string') patch.title = body.title.slice(0, MAX_ARTIFACT_TITLE_CHARS)
  if (typeof body.content === 'string') patch.content = body.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS)
  // `null` unlinks the draft, which is a state the panel offers; a missing key leaves the link alone.
  if (body.noteId === null) patch.noteId = null
  else if (typeof body.noteId === 'string') patch.noteId = requiredId(body.noteId)
  // `baseVersion` is optional for older clients; the panel always sends it so a write that read v3 cannot
  // overwrite a v4 that arrived while the reader was typing. `source` says whether the words were typed
  // by the reader or applied from an assistant answer; it changes how the version row is stored, not who
  // is allowed to write.
  let baseVersion: number | undefined
  if (body.baseVersion !== undefined) {
    if (typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 1) {
      throw ApiError.badRequest('baseVersion must be a positive integer.')
    }
    baseVersion = body.baseVersion
  }
  let source: 'user' | 'assistant' | undefined
  if (body.source !== undefined) {
    if (body.source !== 'user' && body.source !== 'assistant') throw ApiError.badRequest('Unknown draft source.')
    source = body.source
  }
  const messageId = typeof body.messageId === 'string' ? requiredId(body.messageId) : null
  const artifact = await s.updateArtifact(artifactId, patch, { baseVersion, source, messageId }).catch((error: unknown) => {
    if (error instanceof ArtifactVersionConflictError) throw ApiError.conflict('The draft changed while it was being edited.')
    throw error
  })
  if (!artifact) throw ApiError.notFound('Draft not found')
  return c.json({ artifact })
})

assistantRoutes.get('/conversations/:id/artifacts/:artifactId/versions', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const artifactId = requiredId(c.req.param('artifactId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const artifact = await s.getArtifact(artifactId)
  if (!artifact || artifact.conversationId !== id) throw ApiError.notFound('Draft not found')
  return c.json({ versions: await s.listArtifactVersions(artifactId) })
})

assistantRoutes.get('/conversations/:id/artifacts/:artifactId/versions/:versionId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const artifactId = requiredId(c.req.param('artifactId'))
  const versionId = requiredId(c.req.param('versionId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const artifact = await s.getArtifact(artifactId)
  if (!artifact || artifact.conversationId !== id) throw ApiError.notFound('Draft not found')
  const version = await s.getArtifactVersion(artifactId, versionId)
  if (!version) throw ApiError.notFound('Draft version not found')
  return c.json({ version })
})

assistantRoutes.post('/conversations/:id/artifacts/:artifactId/versions/:versionId/restore', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const artifactId = requiredId(c.req.param('artifactId'))
  const versionId = requiredId(c.req.param('versionId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const artifact = await s.getArtifact(artifactId)
  if (!artifact || artifact.conversationId !== id) throw ApiError.notFound('Draft not found')
  const restored = await s.restoreArtifactVersion(artifactId, versionId)
  if (!restored) throw ApiError.notFound('Draft version not found')
  return c.json({ artifact: restored })
})

assistantRoutes.delete('/conversations/:id/artifacts/:artifactId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const artifactId = requiredId(c.req.param('artifactId'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const existing = await s.getArtifact(artifactId)
  if (!existing || existing.conversationId !== id) throw ApiError.notFound('Draft not found')
  await s.deleteArtifact(artifactId)
  return c.json({ ok: true })
})

assistantRoutes.delete('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  // The files are read out before the turns that name them are deleted: afterwards there is nothing
  // left to say which objects belonged to this thread, and the bytes would be storage nobody can reach.
  const attachmentIds = await s.conversationAttachmentIds(id)
  const files = await s.chatAttachmentRows(attachmentIds)
  await s.releaseRun(id)
  await s.deleteConversation(id)
  await s.deleteChatAttachments(attachmentIds)
  for (const file of files) {
    try {
      await deleteChatObject(c.env, file.key)
    } catch {
      // Best-effort: the row is already gone, so a failed object delete leaves bytes that no surface can
      // reach rather than a thread that half-disappeared. The hourly sweep is the second chance.
    }
  }
  return c.json({ deleted: true })
})

assistantRoutes.delete('/conversations', async (c) => {
  const body = await readJson<{ confirm?: string }>(c, JSON_BODY_LIMITS.small)
  if (body.confirm !== 'DELETE') throw ApiError.badRequest('Type DELETE to confirm.')
  const s = store(c)
  const files = await s.allChatAttachments()
  const deleted = await s.deleteAllConversations()
  await s.deleteChatAttachments(files.map((file) => file.id))
  for (const file of files) {
    try {
      await deleteChatObject(c.env, file.key)
    } catch {
      // Best-effort, for the same reason as the single-conversation delete above.
    }
  }
  return c.json({ deleted })
})

// ----------------------------------------------------------------------- chat

/**
 * The two lists that narrow a turn, read the one way they are ever written: with the message, or saved
 * ahead of time on a skill that stands for a kind of message.
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

/**
 * A pinned tag, folder or note: the id has to be one, and the label is only ever shown, never trusted.
 *
 * A note is included because the composer's own chips are notes as well as folders — the reader pointing
 * at one page. The runner re-reads every note id against this account before it reaches a tool, so a
 * shape-checked id here is not a promise that the note exists.
 */
function pinnedScopes(value: unknown): AssistantTurnScope[] {
  return (Array.isArray(value) ? value : [])
    .map((entry): AssistantTurnScope | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const record = entry as Record<string, unknown>
      if (record.kind !== 'tag' && record.kind !== 'folder' && record.kind !== 'note') return null
      if (typeof record.id !== 'string' || !isValidId(record.id)) return null
      return { kind: record.kind, id: record.id, name: typeof record.name === 'string' ? record.name.slice(0, 60) : '' }
    })
    .filter((entry): entry is AssistantTurnScope => entry !== null)
    .slice(0, MAX_TURN_SCOPES)
}

const TURN_MODEL_REFUSAL = 'The model named for this turn is not an enabled chat model of this account.'

/**
 * The model this turn asked to be answered by, or null when the caller named none.
 *
 * The id is checked against ownership and against what an id is allowed to mean here — one of *this*
 * account's models, enabled, and of the `chat` purpose — and anything else refuses the request outright
 * instead of answering on the account's own pick. That refusal is the whole point of the parameter: a
 * turn that quietly used a different model than the one it was asked for looks exactly like one answered
 * correctly, and a comparison built on that silence reads as a comparison that happened.
 *
 * `getModel` is scoped to the caller's own user id, so a foreign row is simply not found and gets the
 * same answer as an id that never existed: nothing here says whether it belongs to somebody else.
 */
async function turnModelId(s: AssistantStore, value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isValidId(value)) throw ApiError.badRequest(TURN_MODEL_REFUSAL)
  const model = await s.getModel(value)
  if (!model || !model.enabled || model.purpose !== 'chat') throw ApiError.badRequest(TURN_MODEL_REFUSAL)
  return model.id
}

/** How long a turn may go without saying anything before the stream has to say something for it. */
const KEEPALIVE_AFTER_MS = 15_000

/**
 * A turn this request can already see will not start, or null when nothing stops it.
 *
 * Every condition is a read of state settled before the first byte goes out: the day's budget as it
 * stands, and the shape of the transcript a retry or a continuation points at. The runner keeps its own
 * checks — it is still the trust boundary, and a race between the two just falls back to the `error`
 * frame. Answering them here is what lets a status code carry the failure, instead of only the one
 * client that knows how to read this stream.
 *
 * A turn with no model is deliberately left out. That one is not a request going nowhere: by the time the
 * runner finds no model it has filed the reader's question, and it files an answer row carrying the
 * reason — the thread is where this app tells a reader anything went wrong. Refusing before the stream
 * would take that record away to move one sentence into a status code.
 */
async function unstartableTurn(
  s: AssistantStore,
  settings: AssistantSettings,
  turn: {
    conversationId?: string
    retry: boolean
    continueTurn: boolean
    retryMessageId?: string
  },
): Promise<ApiError | null> {
  // The offline answer names no provider and spends no request budget, so the ceiling does not apply.
  if (!settings.offlineMode) {
    const day = await s.currentUsageDay()
    // Read, not charged: the runner's own reservation is what spends the day, and it still runs.
    if (((await s.usageDays(day, day))[0]?.requests ?? 0) >= settings.limits.maxRequestsPerDay) {
      return ApiError.conflict(`The daily limit of ${settings.limits.maxRequestsPerDay} assistant requests is reached. It is adjustable in Assistant settings.`)
    }
  }
  if (!turn.conversationId) {
    if (turn.retry) return ApiError.badRequest('There is nothing to retry without a conversation.')
    if (turn.continueTurn) return ApiError.badRequest('There is nothing to continue without a conversation.')
    return null
  }
  if (turn.retry) {
    // The answer being replaced: by id when the reader named one, otherwise the newest row in the thread.
    const named = turn.retryMessageId ? await s.getMessage(turn.retryMessageId) : null
    if (turn.retryMessageId) {
      if (!named || named.conversationId !== turn.conversationId) return ApiError.notFound('Message not found')
      if (named.role !== 'assistant') return ApiError.badRequest('Only an answer can be asked again.')
    }
    // A question that never got an answer is what "retry the last turn" means; anything else retries the
    // newest answer.
    const target = named ?? await s.lastMessage(turn.conversationId)
    if (!target) return ApiError.conflict('Nothing to retry.')
    // Its question sits directly above the answer, so it is read by position: a two-row window ending at
    // the turn itself reaches a question hundreds of rows up, which no page of the thread would show.
    let previous: AssistantMessage | undefined
    if (target.role === 'user') {
      previous = target
    } else {
      const window = await s.messages(turn.conversationId, 2, { upto: { createdAt: target.createdAt, id: target.id } })
      previous = window.length === 2 ? window[0] : undefined
    }
    if (!previous || previous.role !== 'user') return ApiError.conflict('Nothing to retry.')
    if (previous.source === 'import') {
      return ApiError.conflict('A message restored from a backup cannot be retried. Send a new one instead.')
    }
  }
  if (turn.continueTurn) {
    const last = await s.lastMessage(turn.conversationId)
    if (!last || last.role !== 'assistant') return ApiError.conflict('There is no answer to continue.')
    if (!last.content.trim()) return ApiError.conflict('That answer has nothing to continue from; ask it again instead.')
    if (last.source === 'import') return ApiError.conflict('A message restored from a backup cannot be continued.')
  }
  return null
}

/**
 * One turn, streamed as server-sent events.
 *
 * The reader's own disconnect is the abort signal: when the write fails the generator stops, so a
 * closed tab does not keep spending the account's AI budget on an answer nobody is reading.
 */
assistantRoutes.post('/chat', async (c) => {
  const body = await readJson<{ conversationId?: unknown, message?: string, retry?: boolean, messageId?: unknown, continue?: unknown, attachments?: unknown, tools?: unknown, scopes?: unknown, webSearch?: unknown, contextNoteId?: unknown, contextFolderId?: unknown, activeArtifactId?: unknown, noteId?: unknown, ephemeral?: unknown, modelId?: unknown, noTools?: unknown }>(c, 64 * 1024)
  const s = store(c)
  const settings = await s.getSettings()
  const conversationId = body.conversationId === undefined || body.conversationId === null
    ? undefined
    : requiredId(body.conversationId)
  const message = typeof body.message === 'string' ? body.message : ''
  // A model named for this turn is a resource the caller has to own and be allowed to ask for, so it is
  // checked against this account's rows before anything runs — and a name that fails is refused here,
  // because answering it with the account's own pick would sell a different model as the one asked for.
  const modelId = await turnModelId(s, body.modelId)
  // Only ids the reader owns survive: an attachment they cannot name is not fuel for their turn.
  const attachments = Array.isArray(body.attachments)
    ? (await store(c).chatAttachments(body.attachments.filter((id): id is string => typeof id === 'string' && isValidId(id))).then((rows) => rows.map((row) => row.id)))
    : []

  // A tool the assistant cannot actually call is not a request, and a scope has to be a real id: both
  // narrow what the turn may reach, so neither may be invented by the caller.
  const tools = pinnedTools(body.tools)
  const scopes = pinnedScopes(body.scopes)

  // Which kind of turn this is, decided once: the preconditions below and the runner's own input have to
  // read it the same way, or a refusal answered here and a refusal answered as a frame would diverge.
  const retryTurn = body.retry === true
  const continueTurn = body.continue === true && !retryTurn
  const retryMessageId = retryTurn && typeof body.messageId === 'string' && isValidId(body.messageId) ? body.messageId : undefined
  const webSearch = body.webSearch === true
  // A turn may also ask to be answered with no tools at all. Nothing here decides whether that is a good
  // idea for this model — the runner enforces it, because a client-side promise is not a trust boundary.
  const noTools = body.noTools === true
  const turn = {
    conversationId,
    retry: retryTurn,
    continueTurn,
    retryMessageId,
  }

  if (conversationId) {
    if (!(await s.getConversation(conversationId))) throw ApiError.notFound('Conversation not found')
  } else if (!message.trim() && !attachments.length) {
    throw ApiError.badRequest('Write something first.')
  }
  // Refused before the claim: a turn that never opens a stream has no `finally` to release the thread it
  // claimed, and every other tab would wait out the lease for an answer that was never going to come.
  const blocker = await unstartableTurn(s, settings, turn)
  if (blocker) throw blocker

  // The claim's token travels to the release below, so a turn that outlives its lease cannot delete the
  // claim another tab has taken since. A turn that creates its own conversation learns its token from
  // the `start` event, because only the runner claimed that one.
  let claimedToken: number | null = null
  if (conversationId) {
    claimedToken = await s.claimRun(conversationId)
    if (claimedToken === null) {
      throw ApiError.conflict('A reply is already being generated in this conversation.')
    }
  }

  const runner = new AssistantRunner({
    store: s,
    env: c.env,
    ftsEnabled: c.get('database').ftsEnabled,
    origin: new URL(c.req.url).origin,
    executionCtx: executionContext(c),
    settings,
    // The route holds the claim on an existing conversation; the runner renews under that token.
    runToken: claimedToken,
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
  let lastFrameAt = Date.now()
  // A long tool call, or a model slow to its first token, gives an intermediary nothing to look at, and
  // one that sees a silent connection for long enough calls it dead and cuts it — the reader then loses
  // an answer that was still being produced. A comment frame is what SSE has for this: it carries no
  // payload, and `features/chat/stream.ts` only ever parses a frame that has a `data:` line.
  const keepalive = setInterval(() => {
    if (readerGone || Date.now() - lastFrameAt < KEEPALIVE_AFTER_MS) return
    lastFrameAt = Date.now()
    writer.write(encoder.encode(': keepalive\n\n')).catch(() => {
      // As with a real frame: the write failing is how a gone reader shows up here.
      readerGone = true
      controller.abort()
    })
  }, KEEPALIVE_AFTER_MS)
  const send = (payload: unknown) => {
    if (readerGone) return false
    // A stream with anything to say does not need to say it is alive as well.
    lastFrameAt = Date.now()
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
        // The offline answer makes its own conversation and claims it, so the claim it took comes back
        // with the id: released at the end of the turn under that token, it cannot delete a claim a second
        // tab has since taken on the thread it just made.
        const offline = await offlineTurn(s, runner, claimed || null, message, send, scopes)
        if (offline) {
          claimed = offline.conversationId
          if (offline.runToken !== null) claimedToken = offline.runToken
        }
        return
      }
      for await (const event of runner.chat({
        conversationId,
        message,
        attachments,
        tools,
        scopes,
        // What the reader had on screen. Only ids survive, and the runner re-reads both against this
        // account before either reaches the skill — a caller cannot name someone else's note.
        ...(typeof body.contextNoteId === 'string' && isValidId(body.contextNoteId) ? { contextNoteId: body.contextNoteId } : {}),
        ...(typeof body.contextFolderId === 'string' && isValidId(body.contextFolderId) ? { contextFolderId: body.contextFolderId } : {}),
        // The draft in the canvas. The runner re-reads it and checks it belongs to this conversation;
        // a malformed id never reaches the runner at all.
        ...(body.activeArtifactId === undefined || body.activeArtifactId === null
          ? {}
          : { activeArtifactId: requiredId(body.activeArtifactId) }),
        // The note the thread began beside, recorded on the conversation rather than on the turn.
        ...(typeof body.noteId === 'string' && isValidId(body.noteId) && await s.knownNote(body.noteId) ? { originNoteId: body.noteId } : {}),
        webSearch,
        // The turn's own model, when it named one: already checked against this account's enabled chat
        // models above, so a name that got here is a name the caller owns.
        ...(modelId ? { modelId } : {}),
        // Answer without tools. A comparison asks the same question twice, and a model that reaches for a
        // write tool on its own authority would perform it a second time.
        noTools,
        // Only read when the turn makes its own conversation; the runner says why a later turn cannot
        // change the kind of thread it is already in.
        ephemeral: body.ephemeral === true,
        retry: retryTurn,
        // Only a retry reads this: which answer to ask again, when it is not the newest one.
        ...(retryMessageId ? { retryFromMessageId: retryMessageId } : {}),
        // Resume the last answer instead of asking anything new. Never with a retry: one replaces the
        // turn, the other extends it.
        ...(continueTurn ? { continueTurn: true } : {}),
        signal: controller.signal,
        readerGone: () => readerGone,
      })) {
        if (event.type === 'start' && event.conversationId) {
          claimed = event.conversationId
          if (event.runToken !== undefined) claimedToken = event.runToken
        }
        await send(event)
      }
    } catch (error) {
      const reason = error instanceof ApiError ? error.message : 'The assistant could not answer.'
      await send({ type: 'error', code: error instanceof ApiError ? error.code : 'internal', message: reason })
    } finally {
      // Cleared before anything else closes: an interval outliving the turn would keep writing to a
      // stream nobody is reading, and hold the isolate open on a request that is already over.
      clearInterval(keepalive)
      requestSignal.removeEventListener('abort', onDisconnect)
      if (claimed) await s.releaseRun(claimed, claimedToken ?? undefined)
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
 *
 * The claim is answered with its token: a conversation this turn made is claimed here, and the caller
 * releases it at the end of the turn. An existing conversation was claimed by the route, whose token it
 * already holds, so `runToken` comes back null and nothing new is reported.
 */
async function offlineTurn(
  s: AssistantStore,
  runner: AssistantRunner,
  conversationId: string | null,
  message: string,
  send: (payload: unknown) => boolean,
  /** The pins the turn was asked under: an offline turn is still a turn, and the transcript says so. */
  scopes: AssistantTurnScope[] = [],
): Promise<{ conversationId: string, runToken: number | null } | null> {
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
  let runToken: number | null = null
  if (!conversationId) {
    runToken = await s.claimRun(conversation.id)
    if (runToken === null) {
      // A second offline turn that learned this brand-new id first owns the thread; the same refusal the
      // streamed path gives, for the same reason.
      await send({ type: 'error', code: 'conflict', message: 'A reply is already being generated in this conversation.' })
      return null
    }
  }
  const reply = await runner.offlineTurn(conversation.id, content, scopes)
  // The token goes out with the start event exactly as the streamed path sends it: the reader who stops
  // this turn is stopping the claim named here, and no other.
  await send({ type: 'start', conversationId: conversation.id, assistantMessageId: reply.id, ...(runToken === null ? {} : { runToken }) })
  await send({ type: 'text', delta: reply.content })
  await send({ type: 'done', finalMessage: reply })
  return { conversationId: conversation.id, runToken }
}

/**
 * Releases the conversation's claim.
 *
 * The upstream call itself is cancelled by the reader's own disconnect; this exists so the conversation
 * unlocks immediately instead of waiting for the lease to expire, and so another device watching the
 * same conversation sees it stop.
 *
 * A stop names the turn it is stopping with the token that turn claimed, and then releases only that
 * claim. Without one this is the blunt unlock it has always been — which is what a remote turn, whose
 * token never reached this tab, and a conversation being deleted actually need, and what must not be what
 * a Stop button does to the turn that started a second after it.
 */
assistantRoutes.post('/chat/cancel', async (c) => {
  const s = store(c)
  const body = await readJson<{ conversationId?: unknown, runToken?: unknown }>(c, JSON_BODY_LIMITS.small)
  const id = requiredId(body.conversationId)
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  await s.releaseRun(id, optionalRunToken(body.runToken))
  return c.json({ cancelled: true })
})

/**
 * The lease a caller names as the one it is letting go of, or nothing.
 *
 * A token is the `started_at` of a claim, so a value that is not one is not a claim being named: refused
 * rather than treated as absent, because a mistyped token would silently turn a targeted stop back into
 * the unlock that releases whatever turn the conversation is running.
 */
function optionalRunToken(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw ApiError.badRequest('The run token has to be the number the turn reported.')
  return numeric
}

assistantRoutes.post('/actions/:id/approve', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const stored = await s.getPendingAction(id)
  if (!stored) throw ApiError.notFound('This action no longer exists.')
  const conversation = await s.getConversation(stored.conversationId)
  if (!conversation) throw ApiError.notFound('This conversation no longer exists.')
  const settings = await s.getSettings()
  // A tool that makes a file (an image) leaves it in this array, because the turn it belongs to was
  // written before the reader pressed Approve and there is no `addMessage` left to carry the id.
  const generated: string[] = []
  // The thread's project, re-read rather than remembered: an approved memory write must land in the
  // same scope the proposal was made in, and a thread moved between projects since then has moved.
  const outcome = await runApprovedAction(s, await approvalContext(c, s, settings, generated, conversation.projectId ?? null), id)
  if (outcome.action) {
    const located = await s.messageForAction(id)
    if (located) {
      await s.attachActionToMessage(located.messageId, located.toolId, outcome.action, outcome.result)
      if (generated.length) await s.appendMessageAttachments(located.messageId, generated)
    }
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
async function approvalContext(
  c: Context<AppBindings>,
  s: AssistantStore,
  settings: Awaited<ReturnType<AssistantStore['getSettings']>>,
  generatedAttachments: string[] | undefined,
  projectId: string | null,
) {
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
    memoryScope: { projectId },
    automations: new AutomationService(s, settings),
    noteScope: async () => scope,
    ...(generatedAttachments ? { generatedAttachments } : {}),
    writeContext: {
      env: c.env,
      userId: s.userId,
      ftsEnabled: c.get('database').ftsEnabled,
      executionCtx: executionContext(c),
    },
  }
}

// ------------------------------------------------------------------ memories

/**
 * How many facts one page is asked for.
 *
 * The memory page reads the account's whole library, because that is the list the reader walks. A note
 * asks a narrower question — what was written out of this page — and the panel that asks it is a pointer
 * list beside the editor, not a second memory page. Bounded server-side rather than trimmed in the
 * browser, so a page with a hundred facts filed under it does not make the notebook fetch a hundred.
 */
const MEMORIES_PER_NOTE = 50

assistantRoutes.get('/memories', async (c) => {
  const s = store(c)
  const query = c.req.query('q')?.trim().slice(0, 200)
  const category = c.req.query('category')
  // A note asks what the assistant remembers about it, and the answer is the facts written out of it. The
  // conversations list applies the same rule to the same shape of mistake: an id that is not an id narrows
  // to nothing rather than to everything, because a backlink panel that printed the reader's whole library
  // would be answering a question nobody asked. Absent means the whole list, which is what the memory page
  // reads, and the page's own filters are the other three parameters.
  const note = c.req.query('noteId')
  const noteId = note === undefined ? undefined : (isValidId(note) ? note : '')
  const [memories, active, historical, review, total] = await Promise.all([
    s.listMemories({
      query: query || undefined,
      status: c.req.query('status') ?? 'all',
      category: category || undefined,
      ...(noteId === undefined ? {} : { noteId, limit: MEMORIES_PER_NOTE }),
    }),
    s.countMemories('active', noteId),
    s.countMemories('historical', noteId),
    s.countMemories('review', noteId),
    s.countMemories('all', noteId),
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
    ...(body.content !== undefined ? { content: text(body.content, MAX_MEMORY_CHARS, 'A memory has to say something.') } : {}),
    ...(body.category !== undefined ? { category: asCategory(body.category) } : {}),
  })
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length })
})

assistantRoutes.post('/memories/:id/note', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ noteId?: unknown }>(c, JSON_BODY_LIMITS.small)
  // The note is created by the client, which owns choosing the folder and the title; this records the
  // link. The field is required and `null` is a value of its own — it is what a reader gets after
  // deleting the note — so a missing field is a bad request rather than a quiet unlink.
  if (body.noteId !== null && !isValidId(body.noteId)) throw ApiError.badRequest('Unknown note id.')
  const memory = await s.setMemoryNote(id, body.noteId === null ? null : body.noteId)
  if (!memory) throw ApiError.notFound('Memory not found')
  return c.json({ memory })
})

assistantRoutes.post('/memories/:id/correct', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ content?: unknown, category?: unknown }>(c, JSON_BODY_LIMITS.small)
  const result = await new MemoryHistoryService(s, {}, settings.conflictReview).correct(
    id,
    text(body.content, MAX_MEMORY_CHARS, 'A memory has to say something.'),
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
    ...(body.title !== undefined ? { title: text(body.title, MAX_TASK_TITLE_CHARS, 'A task title is required.') } : {}),
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

/**
 * The pages a project names as its knowledge base, checked against this account.
 *
 * Refused rather than filtered, which is what `noteScope` does to a folder id: a project that silently
 * kept three of the ten pages picked would answer as if it had the other seven, and the reader has no way
 * to see the difference. An id that is not this account's live note is the same fact twice over — either
 * a stranger's row, which must never be filed here, or a page already deleted, which the reader should be
 * told about rather than have tidied away.
 */
async function projectNoteIds(s: AssistantStore, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (ids.length >= MAX_PROJECT_NOTES) throw ApiError.badRequest(`A project can name at most ${MAX_PROJECT_NOTES} notes.`)
    if (!isValidId(entry)) throw ApiError.badRequest('A project names its notes by note id.')
    if (!(await s.knownNote(entry))) throw ApiError.badRequest('That project names a note you do not have.')
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

assistantRoutes.post('/projects', async (c) => {
  const s = store(c)
  const body = await readJson<{
    name?: unknown, description?: unknown, instructions?: unknown, noteScope?: unknown, noteIds?: unknown, modelId?: unknown,
  }>(c, JSON_BODY_LIMITS.small)
  const name = text(body.name, 200)
  const noteIds = await projectNoteIds(s, body.noteIds)
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
    noteIds,
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
  const body = await readJson<{ name?: unknown, description?: unknown, instructions?: unknown, noteScope?: unknown, noteIds?: unknown, modelId?: unknown }>(c, JSON_BODY_LIMITS.small)
  // Checked before anything is written, so a list naming one page the account does not have leaves the row
  // exactly as it was rather than half-saved.
  const noteIds = body.noteIds !== undefined ? await projectNoteIds(s, body.noteIds) : undefined
  const project = await s.updateProject(id, {
    ...(body.name !== undefined ? { name: text(body.name, 200) } : {}),
    ...(body.description !== undefined ? { description: optionalText(body.description, 2000) ?? '' } : {}),
    // A standing brief is read every turn in the project, so it gets the same ceiling as a message.
    ...(body.instructions !== undefined ? { instructions: optionalTextAllowEmpty(body.instructions, MAX_MESSAGE_CHARS) } : {}),
    ...(Array.isArray(body.noteScope)
      ? { noteScope: body.noteScope.filter((id): id is string => typeof id === 'string' && isValidId(id)).slice(0, 12) }
      : {}),
    ...(noteIds !== undefined ? { noteIds } : {}),
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
    // Checked by the service, which owns the rules about which kinds may carry them and whose stores can
    // say whether the reader has the folder or the page. Shape only is tested here, so a body carrying
    // `"folderId": 42` is refused as the malformed request it is rather than reaching a query.
    targetFolderId: optionalTargetId(body.folderId, 'folderId'),
    targetNoteId: optionalTargetId(body.noteId, 'noteId'),
  })
  await s.recordActivity('automation.created', automation.name)
  return c.json({ automation }, 201)
})

/**
 * An optional folder or page target, taken as the opaque id it is.
 *
 * Not gated on `isValidId`, because the ownership lookup the service runs is the check that matters and
 * it is a scoped, parameterised read: an id of any shape that is not one of this account's rows answers
 * the same way, and a schedule whose target cannot be found is refused rather than dropped. The length
 * bound is here so a body cannot carry a paragraph in an id field.
 */
function optionalTargetId(value: unknown, field: 'folderId' | 'noteId'): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a folder or note id.`)
  const id = value.trim()
  if (!id) return null
  if (id.length > MAX_AUTOMATION_TARGET_ID_CHARS) throw ApiError.badRequest(`${field} is too long to be an id.`)
  return id
}

assistantRoutes.patch('/automations/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  // The whitelist below is the whole of what a schedule may be edited into: a body naming a `noteId` or a
  // `folderId` is not a field this route reads, so a routine keeps the page it was made against and the
  // reader sees the target they still have rather than a half-moved one. See `AutomationService.update`.
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

// ---------------------------------------------------------------------- push

/**
 * The devices a reader has asked this account to notify.
 *
 * Two rules and they are both about credentials. Nothing here reads another account's rows: every call goes
 * through `store(c)`, whose statements carry the signed-in `user_id`, and the delete is looked up by
 * (account, row id) so an id lifted off another account's list removes nothing. And no response ever carries
 * the triple back: `describeSubscription` renders each endpoint as the push service's origin plus a short
 * digest, because any real piece of the path is a piece of the token — and on a short-path service the whole
 * token is the first piece. The row's own id is what a reader hands back to undo a subscription: a handle for
 * their own row, not a credential, which is why the list is readable and revocable from one screen without
 * ever showing the endpoint or a prefix of it.
 */

/** The account's devices in the one redacted view every push route answers with. */
async function describeDevices(s: AssistantStore): Promise<PushSubscriptionView[]> {
  return await Promise.all((await s.listPushSubscriptions()).map(describeSubscription))
}

/** The trimmed endpoint a validated body carries, or the problem with it. */
function pushEndpoint(value: unknown): string {
  const problem = pushEndpointProblem(value)
  if (problem) throw ApiError.badRequest(problem)
  return (value as string).trim()
}

assistantRoutes.get('/push/config', async (c) => c.json(pushConfigStatus(c.env)))

/**
 * The account's devices, read without writing anything first.
 *
 * Deliberately unpaginated, and that is a claim about this table rather than a shortcut: a row is one browser
 * subscription, so the list is bounded by how many devices one reader actually owns — a laptop, a phone,
 * maybe a tablet. Every paginated list in this file walks a table that grows without bound (messages,
 * conversations, files, usage days). A page boundary here would only let the settings screen open with two
 * thirds of the reader's devices on it and no way to tell that the rest exists.
 *
 * The answer is the same redacted view a write already returns — `describeSubscription`, one row per device,
 * endpoint digest and row id and the failure ledger — and it is scoped the same way: `store(c)` carries the
 * signed-in `user_id` into the statement, so this route cannot name another account's row.
 */
assistantRoutes.get('/push/subscriptions', async (c) => {
  const s = store(c)
  return c.json({ subscriptions: await describeDevices(s) })
})

assistantRoutes.post('/push/subscriptions', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const endpoint = pushEndpoint(body.endpoint)
  const keys = body.keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw ApiError.badRequest('keys must be the { p256dh, auth } pair the browser produced.')
  }
  const pair = keys as Record<string, unknown>
  const keyProblem = pushKeyProblem(pair.p256dh, 'p256dh') ?? pushKeyProblem(pair.auth, 'auth')
  if (keyProblem) throw ApiError.badRequest(keyProblem)
  const configuration = vapidProblem(c.env)
  if (configuration) {
    // A deployment with no keys can store this row and deliver nothing with it, which is a subscription that
    // quietly never works. Say so with the same sentence `/push/config` gives the interface.
    throw new ApiError(500, 'server_misconfigured', configuration)
  }
  const s = store(c)
  const saved = await s.upsertPushSubscription({ endpoint, p256dh: (pair.p256dh as string).trim(), auth: (pair.auth as string).trim() })
  // `deviceId` names the row this browser's endpoint resolves to, so the screen can mark its own device
  // without ever being given back the address it just sent. It is the row's id and not a credential: an id
  // of this account does nothing on its own beyond naming one row of this account's own list.
  return c.json({ deviceId: saved.id, subscriptions: await describeDevices(s) }, 201)
})

assistantRoutes.delete('/push/subscriptions/:id', async (c) => {
  // Removal is allowed even with no VAPID keys configured: dropping a credential is never the operation that
  // needs the deployment to be able to send.
  //
  // The row's own id is the handle, and `requiredId` is the shape check this file already uses for every id
  // in a path: a string that is not an id is refused as "not found" rather than as a field error, because
  // explaining the difference would be telling the caller which ids the table holds. The delete binds the
  // signed-in account into the statement, so an id copied out of another account's answer removes nothing
  // and is answered as the failure it is rather than as a success.
  const s = store(c)
  if (!await s.deletePushSubscriptionById(requiredId(c.req.param('id')))) {
    throw ApiError.notFound('No device subscribed for this account carries that id.')
  }
  return c.json({ removed: true, subscriptions: await describeDevices(s) })
})

// ------------------------------------------------------------------ settings

/**
 * Whether the engine in these settings can be asked, told back to the client beside the settings themselves.
 *
 * The composer's search chip has to name the dead end it hit, and one of them is "the engine you picked is
 * waiting for a key" — which no settings blob can say, because the key is deliberately not a setting. So the
 * server answers the one question the client must not guess at, and this rides out as a projection: never
 * stored, never read from a request, and never a credential.
 */
async function webSearchKeyStored(s: AssistantStore, settings: AssistantSettings): Promise<boolean> {
  const engine = webSearchEngineFor(settings.webSearchEngine)
  if (!engine.requiresKey) return false
  return (await s.searchKeyEngines()).includes(engine.id)
}

assistantRoutes.get('/settings', async (c) => {
  const s = store(c)
  const [settings, models] = await Promise.all([s.getSettings(), s.listModels()])
  return c.json({
    settings: { ...settings, webSearchKeyStored: await webSearchKeyStored(s, settings) },
    models,
  })
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
  // The web-search address is fetched by the worker, on a model's say-so, so it is the same class of input
  // as a provider address and is refused here rather than stored and discovered later as a tool that only
  // ever fails. `searchEndpointValue` is the rule; a value it cannot keep is a value worth telling the
  // reader about, and blank means the search tool is simply not offered.
  if (patch.webSearchEndpoint !== undefined) {
    const wanted = typeof patch.webSearchEndpoint === 'string' ? patch.webSearchEndpoint.trim() : ''
    if (wanted && searchEndpointValue(wanted, '') !== wanted) {
      throw ApiError.badRequest('The web search endpoint must be a public http(s) address with no credentials in it.')
    }
  }
  // The engine is a name from a table this build owns, not an address the worker is asked to reach, so the
  // check is a whitelist rather than the relay guard above: an id that is not in it would leave the settings
  // holding a channel nothing can build a request for. The secret that engine may need is never here — it has
  // its own encrypted row under `/search-keys`, and a settings blob that could hold one would ride a backup.
  if (patch.webSearchEngine !== undefined && !isWebSearchEngineId(patch.webSearchEngine)) {
    throw ApiError.badRequest('The web search engine must be one the assistant knows how to query.')
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
  return c.json({ settings: { ...next, webSearchKeyStored: await webSearchKeyStored(s, next) } })
})

// ------------------------------------------------------------- search keys

/**
 * The key one hosted web-search engine is queried with.
 *
 * Deliberately not a settings field: `chat_settings` is a plaintext JSON blob that every surface reads and a
 * backup copies, and a vendor's API key belongs in neither. One encrypted row per engine holds it — the same
 * vault material a provider's key is — and these routes answer about it with only two facts: that one exists,
 * and what its last four characters are. Nothing here returns a key, and none of it is in a backup, so a
 * reader who restores their account onto another deployment picks their engine again and types its key again.
 */
assistantRoutes.get('/search-keys', async (c) => c.json({ keys: await store(c).listSearchKeys() }))

/** Writes one engine's key, or replaces it. The value that went in is never the value that comes back. */
assistantRoutes.put('/search-keys/:engine', async (c) => {
  const engine = searchEngineParam(c.req.param('engine'))
  const body = await readJson<{ apiKey?: unknown }>(c, JSON_BODY_LIMITS.small)
  const key = await store(c).putSearchKey(engine, searchEngineKeyValue(body.apiKey))
  return c.json({ key })
})

assistantRoutes.delete('/search-keys/:engine', async (c) => {
  const engine = searchEngineParam(c.req.param('engine'))
  // The account is bound into the statement, so an engine named here can only ever forget this reader's own
  // key. Nothing stored for it is answered as not found rather than as a deletion that did nothing.
  if (!await store(c).deleteSearchKey(engine)) throw ApiError.notFound('No key is stored for that search engine.')
  return c.json({ deleted: true })
})

/** An engine named in a path, checked against the table the assistant can build a request from. */
function searchEngineParam(value: unknown): string {
  if (!isWebSearchEngineId(value)) throw ApiError.badRequest('That is not one of the search engines the assistant knows.')
  return value as string
}

/**
 * A key as it arrives: text, not blank, and short enough to store.
 *
 * Clipped rather than refused would be the worse silence — a vendor's token cut by four characters is a key
 * that answers 401 forever and reads as the reader having typed the wrong thing.
 */
function searchEngineKeyValue(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('A search engine key is written as text.')
  const key = value.trim()
  if (!key) throw ApiError.badRequest('A search engine key cannot be empty.')
  if (key.length > MAX_SEARCH_KEY_CHARS) throw ApiError.badRequest('That search engine key is too long to store.')
  return key
}

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

/**
 * The composer's X button: an upload nobody sent is an upload that should stop existing.
 *
 * The count is part of the answer because the file is not always standalone. Turns keep their own record of
 * what was attached to them, so a delete that found references rewrote those rows, and a caller that said
 * only "deleted" would be describing something else — a file that had been part of the conversation.
 */
assistantRoutes.delete('/files/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const { removed, strippedTurns } = await s.deleteChatAttachment(id)
  // Safe to take the bytes only now: the references and the row went together, so nothing this account owns
  // can still name this object.
  if (removed) await deleteChatObject(c.env, removed.key)
  return c.json({ deleted: Boolean(removed), referenced_by_turns: strippedTurns })
})

// -------------------------------------------------------------------- skills

/** The reader's own skill library, the words behind the composer's `/` and ➕ entries. */
assistantRoutes.get('/skills', async (c) => {
  const query = c.req.query('q')?.trim().slice(0, 200)
  const group = c.req.query('group')?.trim().slice(0, 60)
  const skills = await store(c).listSkills({
    ...(query ? { query } : {}),
    ...(group ? { group } : {}),
    limit: Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200)),
  })
  return c.json({ skills })
})

/**
 * The model a saved skill asks for, kept only when this account actually has it.
 *
 * A skill names its model by id and the reader may delete that model later, so the check happens where
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

assistantRoutes.post('/skills', async (c) => {
  // A skill is prose: the small limit is for ids and flags, and 8 KB would refuse a paragraph.
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const s = store(c)
  // Either half may be empty on its own — a skill can be a block of text with no name, or a name the
  // reader fills in later — so neither goes through `text`, which refuses an empty value outright.
  const title = optionalSkillText(body.title, MAX_SKILL_TITLE_CHARS)
  const content = optionalSkillText(body.content, MAX_SKILL_CONTENT_CHARS)
  if (!title && !content) throw ApiError.badRequest('A skill needs a title or the words themselves.')
  const skill = await s.insertSkill({
    title: title || content.slice(0, 40),
    content,
    group: body.group === undefined ? '' : optionalSkillText(body.group, 60),
    // One emoji, not prose: the limit is the multi-code-point forms a family or a flag is written with.
    icon: optionalSkillText(body.icon, MAX_SKILL_ICON_CHARS),
    // The three bindings are a turn preset: the same two lists the composer pins with `/` and `#`, read
    // through the same filter, because a saved skill must not reach past the turn it stands for.
    tools: pinnedTools(body.tools),
    scopes: pinnedScopes(body.scopes),
    modelId: body.modelId === undefined ? null : await pinnedModel(s, body.modelId),
  })
  return c.json({ skill }, 201)
})

assistantRoutes.patch('/skills/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const updated = await s.updateSkill(id, {
    // Read the same forgiving way the create does: clearing the group, or the words, is an edit a reader
    // is entitled to make, and `text` would answer it with "This cannot be empty."
    ...(body.title !== undefined ? { title: optionalSkillText(body.title, MAX_SKILL_TITLE_CHARS) } : {}),
    ...(body.content !== undefined ? { content: optionalSkillText(body.content, MAX_SKILL_CONTENT_CHARS) } : {}),
    ...(body.group !== undefined ? { group: optionalSkillText(body.group, 60) } : {}),
    ...(body.icon !== undefined ? { icon: optionalSkillText(body.icon, MAX_SKILL_ICON_CHARS) } : {}),
    ...(body.tools !== undefined ? { tools: pinnedTools(body.tools) } : {}),
    ...(body.scopes !== undefined ? { scopes: pinnedScopes(body.scopes) } : {}),
    ...(body.modelId !== undefined ? { modelId: await pinnedModel(s, body.modelId) } : {}),
  })
  if (!updated) throw ApiError.notFound('Skill not found')
  return c.json({ skill: updated })
})

assistantRoutes.delete('/skills/:id', async (c) => {
  const removed = await store(c).deleteSkill(requiredId(c.req.param('id')))
  return c.json({ deleted: removed })
})

/**
 * The whole library as one file.
 *
 * Read from the server rather than from the list the client already holds: the list is paged and
 * search-narrowed, and an export that quietly left out everything past the page would be worse than none.
 */
assistantRoutes.get('/skills/export', async (c) => {
  const skills = await store(c).listSkills({ limit: MAX_SKILL_BUNDLE_SKILLS })
  return c.json({ bundle: skillBundleOf(skills) })
})

/**
 * The model an imported skill asks for, kept only when this account has it.
 *
 * Unlike the create route, an id this account has never heard of is dropped rather than refused. A bundle
 * written on another machine names models that do not exist here, and one such name must not throw away
 * the ninety other skills in the same file.
 */
async function importableModel(s: AssistantStore, value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !isValidId(value) || !(await s.getModel(value))) return null
  return value
}

/**
 * A bundle read back in, one skill at a time.
 *
 * Each entry goes through the same filters the create route uses, so a file cannot reach past what a
 * reader could have typed: an uncallable tool is dropped, a scope has to be a real id shape, and a model
 * has to be one of this account's. What cannot be read at all is reported rather than failing the file —
 * one malformed skill in a list of ten must not hide the other nine.
 */
assistantRoutes.post('/skills/import', async (c) => {
  const body = await readJson<{ skills?: unknown }>(c, JSON_BODY_LIMITS.skillBundle)
  const entries = Array.isArray(body.skills) ? body.skills.slice(0, MAX_SKILL_BUNDLE_SKILLS) : []
  const s = store(c)
  const skipped: { title: string, reason: SkillImportSkip }[] = []
  let imported = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push({ title: '', reason: 'shape' })
      continue
    }
    const record = entry as Record<string, unknown>
    const title = optionalSkillText(record.title, MAX_SKILL_TITLE_CHARS)
    const content = optionalSkillText(record.content, MAX_SKILL_CONTENT_CHARS)
    // A skill is a name or the words; an entry with neither is not a skill this app could have saved.
    if (!title && !content) {
      skipped.push({ title: '', reason: 'empty' })
      continue
    }
    await s.insertSkill({
      title: title || content.slice(0, 40),
      content,
      group: optionalSkillText(record.group, 60),
      icon: optionalSkillText(record.icon, MAX_SKILL_ICON_CHARS),
      tools: pinnedTools(record.tools),
      scopes: pinnedScopes(record.scopes),
      modelId: await importableModel(s, record.modelId),
    })
    imported++
  }
  return c.json({ imported, skipped })
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
    ...(body.label !== undefined ? { label: text(body.label, 60, 'A provider name is required.') } : {}),
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

/**
 * What is left in each of one provider's wallets.
 *
 * A reading per stored key, because that is how the reader divided the budget: three keys are three wallets,
 * and a single number beside the provider would be one of them chosen by an order nobody can see. The answer
 * holds no credential — the row's id, the label the reader gave it, its last four characters, and whatever
 * the vendor said about what is left.
 *
 * A provider whose address is not one of the vendors this build knows how to ask is answered as
 * `supported: false`, not as a failure: "this provider does not tell" is information, and an error beside a
 * key that is working fine is a lie about the reader's account.
 */
assistantRoutes.get('/providers/:id/balance', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const targets = await s.providerKeySecrets(id)
  if (!targets.baseUrl) throw ApiError.notFound('Provider not found')
  const spec = balanceSpecFor(targets.baseUrl)
  if (!spec) return c.json({ supported: false, readings: [] })
  const readings = await Promise.all(targets.keys.map(async (entry) => ({
    keyId: entry.keyId,
    label: entry.label,
    keyHint: entry.keyHint,
    ...await fetchProviderBalance(spec, targets.baseUrl, entry.key, `${c.get('userId')}:${id}:${entry.keyId}`),
  })))
  return c.json({ supported: true, readings })
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
    // Absent or null is "no per-model sampling setting"; anything else has to be a number the field can
    // hold, because a model created without one must not be refused.
    temperature: body.temperature === undefined || body.temperature === null
      ? null
      : numberInRange(body.temperature, 0, 1.5),
    // The same range the patch above accepts: a model's own ceiling is not the account's, and the editor
    // offers presets well past 8192, so clamping here quietly stored something other than what was picked.
    maxOutputTokens: clampTokens(body.maxOutputTokens, 64, MAX_TOKEN_CEILING),
    reasoning: reasoningValue(body.reasoning),
    contextTokens: contextBudgetValue(body.contextTokens),
    // What the vendor's listing said, carried in from the picker so a synced row knows its own limits
    // rather than only what a bundled table guesses about its name. Null means unstated, which is not the
    // same as zero and must never be rounded up into a ceiling.
    vendorContextTokens: clampTokens(body.vendorContextTokens, 1, MAX_TOKEN_CEILING),
    vendorMaxOutputTokens: clampTokens(body.vendorMaxOutputTokens, 1, MAX_TOKEN_CEILING),
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

/**
 * A number the reader typed, answered inside the range the field can hold.
 *
 * The clamps on their own could not fail: `Number('abc')` is NaN, and NaN survives both `Math.min` and
 * `Math.max`, so a sampling field the editor could not parse was stored as NaN and handed back to the
 * provider as one. A value the field cannot mean is refused, named for the request that carried it.
 */
function numberInRange(value: unknown, min: number, max: number): number {
  const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) throw ApiError.badRequest('A number is required for this field.')
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

/**
 * The model a reader named as this one's spare, or null for none.
 *
 * A self-reference is refused because it is a chain of one that can never answer; an id that is not one of
 * the reader's own models is refused because the turn could not resolve it. Both are answered rather than
 * stored, since a spare that silently does nothing is worse than being told the pick was wrong.
 */
async function spareModelFor(s: AssistantStore, selfId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '') return null
  if (!isValidId(value)) throw ApiError.badRequest('That fallback model does not exist.')
  if (value === selfId) throw ApiError.badRequest('A model cannot fall back to itself.')
  if (!(await s.getModel(value))) throw ApiError.badRequest('That fallback model does not exist.')
  return value
}

assistantRoutes.patch('/models/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const updated = await s.updateModel(id, {
    ...(body.label !== undefined ? { label: text(body.label, 60, 'A model name is required.') } : {}),
    ...(body.model !== undefined ? { model: text(body.model, 120).replace(/\s+/g, '') } : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature === null ? null : numberInRange(body.temperature, 0, 1.5) }
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
    ...(body.fallbackModelId !== undefined ? { fallbackModelId: await spareModelFor(s, id, body.fallbackModelId) } : {}),
    ...(body.supportsTools !== undefined ? { supportsTools: Boolean(body.supportsTools) } : {}),
    ...(body.noTools !== undefined ? { noTools: Boolean(body.noTools) } : {}),
    ...(body.maxInputTokens !== undefined ? { maxInputTokens: clampTokens(body.maxInputTokens, 1, MAX_TOKEN_CEILING) } : {}),
    // An unknown modality is dropped, not defaulted: a list of one typo must not silently reset the
    // whole set the reader had already picked.
    ...(Array.isArray(body.modalities) ? { modalities: parseModelModalities(body.modalities) } : {}),
    ...(body.topP !== undefined
      ? { topP: body.topP === null ? null : numberInRange(body.topP, 0, 1) }
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
    ...(body.priceCurrency !== undefined ? { priceCurrency: currencyValue(body.priceCurrency) } : {}),
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

/**
 * What a realtime voice session is told about the reader.
 *
 * This mode speaks through the provider's own realtime model, outside the runner, so it has no note
 * tools, no memories and no ability to write. Saying that plainly in the instructions is better than
 * letting the model promise to read a note it cannot see.
 */
function realtimeVoiceInstructions(settings: AssistantSettings): string {
  const language = settings.language === 'zh-CN' ? 'Simplified Chinese' : 'English'
  return [
    `You are ${settings.agentName}, a voice assistant inside the reader's private Inkstone notebook.`,
    `Speak ${language}. Keep replies short, natural and suitable for speech; avoid Markdown tables and long code.`,
    settings.customInstructions.trim() ? `The reader's standing instructions: ${settings.customInstructions.trim()}` : '',
    'This realtime voice session cannot read or change notes and cannot use the notebook tools. Say so when asked; suggest the text assistant for that work.',
  ].filter(Boolean).join('\n')
}

/**
 * The terms of a voice session.
 *
 * For an OpenAI provider this is a short-lived provider secret the browser uses for WebRTC; the
 * long-lived key never leaves this Worker. A ModelBest provider cannot be called that way — its browser
 * handshake carries the key itself — so it answers with a relay path instead and the audio is proxied
 * through this deployment.
 */
assistantRoutes.post('/realtime/session', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<{ modelId?: unknown }>(c, JSON_BODY_LIMITS.small)
  const models = (await s.listModels()).filter((model) => model.enabled && model.purpose === 'realtime')
  const requested = body.modelId === undefined || body.modelId === null
    ? settings.realtimeModelId
    : requiredId(body.modelId)
  if (requested && !models.some((model) => model.id === requested)) {
    throw ApiError.badRequest('That model is not an enabled realtime voice model.')
  }
  const model = requested ? models.find((entry) => entry.id === requested) : models[0]
  if (!model) throw ApiError.badRequest('No enabled realtime voice model is configured.')
  const provider = await s.providerRecord(model.providerId)
  if (!provider) throw ApiError.badRequest('The voice model has no provider.')
  if (provider.protocol !== 'openai') {
    throw ApiError.badRequest('Realtime voice currently needs an OpenAI-compatible provider.')
  }
  const key = await s.pickProviderKey(provider)
  if (!key) throw ApiError.badRequest('The voice provider has no API key.')
  if (isModelBestEndpoint(provider.base_url)) {
    const relay: RealtimeRelayDescriptor = {
      transport: 'modelbest',
      model: model.model,
      relayPath: `/api/assistant/realtime/relay?modelId=${encodeURIComponent(model.id)}`,
      expiresAt: null,
    }
    return c.json({ session: relay })
  }
  try {
    const session = await mintRealtimeSession({
      baseUrl: provider.base_url,
      apiKey: key.key,
      model: model.model,
      instructions: realtimeVoiceInstructions(settings),
    })
    await s.markProviderKeyUsed(provider.id, key.keyId)
    return c.json({ session })
  } catch (error) {
    if (error instanceof RealtimeSessionError) {
      throw new ApiError(error.status >= 500 ? 502 : 400, 'realtime_refused', error.message)
    }
    throw error
  }
})

/**
 * The bridge between a browser's voice socket and a ModelBest realtime session.
 *
 * The browser is untrusted input: it may ask for audio frames and a close, and nothing else. In
 * particular it cannot write `session.init` — the system prompt belongs to this deployment — and it
 * never sees the provider key, which is written into the upstream handshake here.
 */
assistantRoutes.get('/realtime/relay', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw ApiError.badRequest('This endpoint accepts only WebSocket upgrade requests.')
  }
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) {
    throw ApiError.forbidden('The realtime connection origin is not trusted')
  }
  const modelId = c.req.query('modelId')
  if (!modelId) throw ApiError.badRequest('A realtime voice model is required.')
  const s = store(c)
  const model = (await s.listModels()).find((entry) => entry.id === modelId && entry.enabled && entry.purpose === 'realtime')
  if (!model) throw ApiError.badRequest('That model is not an enabled realtime voice model.')
  const provider = await s.providerRecord(model.providerId)
  if (!provider || !isModelBestEndpoint(provider.base_url)) {
    throw ApiError.badRequest('This voice model is not served by a realtime WebSocket provider.')
  }
  const key = await s.pickProviderKey(provider)
  if (!key) throw ApiError.badRequest('The voice provider has no API key.')
  const settings = await s.getSettings()

  assertRelayableEndpoint(provider.base_url)
  const target = new URL(modelBestSocketUrl(provider.base_url, model.model))
  // Workers fetch a WebSocket as an HTTP upgrade, not as a wss:// URL.
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target.toString(), {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${key.key}` },
    })
  } catch (error) {
    console.warn('[inkstone] realtime relay could not reach the provider', error instanceof Error ? error.message : 'unknown')
    throw new ApiError(502, 'realtime_refused', 'The realtime provider could not be reached.')
  }
  const upstream = upstreamResponse.webSocket
  if (!upstream) {
    console.warn('[inkstone] realtime relay was refused by the provider', upstreamResponse.status)
    throw new ApiError(502, 'realtime_refused', `The realtime provider refused the voice connection (HTTP ${upstreamResponse.status}).`)
  }
  upstream.accept()

  const pair = new WebSocketPair()
  const [client, server] = [pair[0], pair[1]]
  server.accept()
  let initialized = false
  let ready = false
  let closed = false
  const initFrame = modelBestSessionInit(realtimeVoiceInstructions(settings), settings.temperature)
  const finish = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    clearTimeout(initTimer)
    try { server.close(code, reason) } catch { /* already closed */ }
    try { upstream.close(code, reason) } catch { /* already closed */ }
  }
  const initialize = (): void => {
    if (initialized || closed) return
    initialized = true
    clearTimeout(initTimer)
    try {
      upstream.send(initFrame)
    } catch {
      finish(1011, 'init failed')
    }
  }
  const initTimer = setTimeout(initialize, MODELBEST_INIT_FALLBACK_MS)

  upstream.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    let type = ''
    try { type = String((JSON.parse(event.data) as { type?: unknown }).type ?? '') } catch { /* forward opaque text as-is */ }
    if (!initialized && (type === 'session.queue_done' || type === 'queue_done')) initialize()
    else if (!initialized && (type === 'session.queued' || type === 'queued' || type === 'session.queue_update')) clearTimeout(initTimer)
    if (type === 'session.created') ready = true
    try {
      server.send(event.data)
    } catch {
      finish(1011, 'client send failed')
    }
  })
  upstream.addEventListener('close', () => finish(1000, 'provider closed'))
  upstream.addEventListener('error', () => finish(1011, 'provider error'))

  server.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > MODELBEST_MAX_FRAME_CHARS) {
      finish(1009, 'frame too large')
      return
    }
    let frame: { type?: unknown, input?: { audio?: unknown } }
    try { frame = JSON.parse(event.data) as { type?: unknown, input?: { audio?: unknown } } } catch { return }
    if (frame.type === 'input.append') {
      const audio = frame.input?.audio
      if (typeof audio !== 'string' || !audio) {
        finish(1008, 'invalid audio frame')
        return
      }
      if (!ready) return
      try {
        upstream.send(JSON.stringify({ type: 'input.append', input: { audio } }))
      } catch {
        finish(1011, 'provider send failed')
      }
      return
    }
    if (frame.type === 'session.close') {
      try { upstream.send(JSON.stringify({ type: 'session.close', reason: 'user_stop' })) } catch { /* closing anyway */ }
      return
    }
    finish(1008, 'unsupported frame')
  })
  server.addEventListener('close', () => {
    closed = true
    clearTimeout(initTimer)
    try { upstream.close(1000, 'client closed') } catch { /* already closed */ }
  })

  // The call is already live; a bookkeeping failure must not turn it into a refused upgrade.
  try {
    await s.markProviderKeyUsed(provider.id, key.keyId)
  } catch (error) {
    console.warn('[inkstone] realtime relay key usage was not recorded', error instanceof Error ? error.message : 'unknown')
  }
  return new Response(null, { status: 101, webSocket: client })
})

assistantRoutes.get('/usage', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  // The reader's own day, which is the key the counters are filed under: a screen that named the server's
  // day would quote a row the quota is not measured against.
  const day = await s.currentUsageDay()
  const [today, week] = await Promise.all([s.todayUsage(), s.usageRange(dayBefore(day, 6), day)])
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
  const day = await s.currentUsageDay()
  const from = range === 0 ? (await s.firstUsageDay()) ?? day : dayBefore(day, range - 1)
  // A day recorded before the by-model dimension existed has totals and no model rows, which reads as a
  // chart of zeros. The messages are the truth those totals came from, so the missing rows are rebuilt
  // here, on the read that needs them; the write is idempotent and only ever touches past days.
  await s.backfillModelUsage(day)
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
  const [total, days, modelRows, keyRows, seriesRows, conversations, models, optionRows] = await Promise.all([
    narrowed ? s.usageRangeIn(from, day, filter) : s.usageRange(from, day),
    narrowed ? s.usageDaysIn(from, day, filter) : s.usageDays(from, day),
    narrowed ? s.modelUsageRangeIn(from, day, filter) : s.modelUsageRange(from, day),
    s.keyUsageRange(from, day),
    s.usageSeries(from, day, filter),
    s.usageByConversation(from, day),
    s.listModels(),
    // The model picker keeps offering every model in the window even while the window is filtered by
    // one: a list narrowed to the choice already made would strand the reader with no way back.
    narrowed ? s.modelUsageRange(from, day) : Promise.resolve([]),
  ])
  const spend = new Map<string, number>()
  let unpriced = 0
  const byModel = modelRows.map((row) => {
    const base = {
      label: row.modelLabel,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      toolCalls: row.toolCalls,
      errors: row.errors,
    }
    const price = priceUsage(models, row.modelLabel, row.inputTokens, row.outputTokens, row.modelId)
    if (!price) {
      unpriced++
      return { ...base, currency: '', cost: null }
    }
    spend.set(price.currency, (spend.get(price.currency) ?? 0) + price.amount)
    return { ...base, currency: price.currency, cost: price.amount }
  })
  return c.json({
    range: range === 0 ? 'all' : String(range),
    from,
    to: day,
    total,
    days,
    models: byModel,
    keys: foldKeyUsage(keyRows, models),
    series: buildUsageSeries(seriesRows, models),
    // Built from the key rows, which the filter never narrows, so picking one filter cannot empty the
    // other picker.
    modelOptions: [...new Set([
      ...keyRows.map((row) => row.modelLabel),
      ...(narrowed ? optionRows : modelRows).map((row) => row.modelLabel),
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    conversations,
    spend: [...spend].map(([currency, amount]) => ({ currency, amount })),
    unpricedModels: unpriced,
    generatedAt: Date.now(),
    limits: settings.limits,
  })
})

/**
 * What one model's tokens cost, or null when the reader has not priced it.
 *
 * Null is a claim of its own: an unpriced model is not a free one, and a chart that counted it as zero would
 * understate the bill for exactly the models the reader has not got round to entering. A model that carries a
 * price but no currency is null for the same reason — there is no unit to state the number in, and inventing
 * dollars would total up money in a currency nobody chose.
 *
 * Resolved by id first when the usage row carries one: a model that has been renamed keeps its id, so its
 * history stays priced at its own rate even though the label on those rows is the word it used to answer to.
 */
function priceUsage(
  models: AssistantModel[],
  label: string,
  inputTokens: number,
  outputTokens: number,
  modelId?: string,
): { currency: string, amount: number } | null {
  const model = (modelId ? models.find((entry) => entry.id === modelId) : undefined)
    ?? models.find((entry) => entry.label === label || entry.model === label)
  if (!model || (model.inputPrice === null && model.outputPrice === null)) return null
  if (!model.priceCurrency) return null
  return {
    currency: model.priceCurrency,
    amount: ((model.inputPrice ?? 0) * inputTokens + (model.outputPrice ?? 0) * outputTokens) / 1_000_000,
  }
}

/** One bar's worth of a day, while the rows are still being folded into it. */
interface SliceTally {
  id: string
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  unpriced: boolean
  costs: Map<string, number>
}

interface DayTally {
  requests: number
  inputTokens: number
  outputTokens: number
  models: Map<string, SliceTally>
  keys: Map<string, SliceTally>
}

/**
 * The window day by day, priced and split both ways.
 *
 * The chart's toggle asks the same days to be grouped by model and by key, so both splits are built here
 * from one set of rows — and the slices are ordered by their whole-window weight rather than per day, or a
 * stack would reorder itself every time a quiet day came round and the chart would be unreadable.
 */
function buildUsageSeries(
  rows: Awaited<ReturnType<ReturnType<typeof store>['usageSeries']>>,
  models: AssistantModel[],
): AssistantUsageDay[] {
  const byDay = new Map<string, DayTally>()
  const weight = new Map<string, number>()
  for (const row of rows) {
    const tally = byDay.get(row.day) ?? { requests: 0, inputTokens: 0, outputTokens: 0, models: new Map(), keys: new Map() }
    byDay.set(row.day, tally)
    tally.requests += row.requests
    tally.inputTokens += row.inputTokens
    tally.outputTokens += row.outputTokens
    const price = priceUsage(models, row.modelLabel, row.inputTokens, row.outputTokens, row.modelId)
    // The day is split by model and by key over the same rows, so one unpriced row marks both of its slices.
    foldSlice('m', weight, tally.models, row.modelLabel || '', row.modelLabel, row, price)
    // A rebuilt history row carries no provider or key, so it belongs to the model split and not to a
    // nameless bar in the key split: the key it was paid with was never recorded, which is the honest
    // reading and not a key called ''.
    if (row.providerId) foldSlice('k', weight, tally.keys, `${row.providerId}:${row.keyId}`, keySliceLabel(row), row, price)
  }
  const order = (prefix: 'm' | 'k') => (left: SliceTally, right: SliceTally) =>
    (weight.get(`${prefix}:${right.id}`) ?? 0) - (weight.get(`${prefix}:${left.id}`) ?? 0) || left.label.localeCompare(right.label)
  return [...byDay]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, tally]) => ({
      day,
      requests: tally.requests,
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      // The day's own cost is the models' — the key split describes the same money, not more of it.
      costs: sumCosts([...tally.models.values()]),
      models: [...tally.models.values()].sort(order('m')).map(finishSlice),
      keys: [...tally.keys.values()].sort(order('k')).map(finishSlice),
    }))
}

function foldSlice(
  prefix: 'm' | 'k',
  weight: Map<string, number>,
  into: Map<string, SliceTally>,
  id: string,
  label: string,
  row: { requests: number, inputTokens: number, outputTokens: number },
  price: { currency: string, amount: number } | null,
): void {
  const slice = into.get(id) ?? { id, label, requests: 0, inputTokens: 0, outputTokens: 0, unpriced: false, costs: new Map() }
  into.set(id, slice)
  slice.requests += row.requests
  slice.inputTokens += row.inputTokens
  slice.outputTokens += row.outputTokens
  if (price) slice.costs.set(price.currency, (slice.costs.get(price.currency) ?? 0) + price.amount)
  else if (label) slice.unpriced = true
  const key = `${prefix}:${id}`
  weight.set(key, (weight.get(key) ?? 0) + row.inputTokens + row.outputTokens)
}

function finishSlice(tally: SliceTally): AssistantUsageSlice {
  return {
    id: tally.id,
    label: tally.label,
    requests: tally.requests,
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    costs: [...tally.costs].map(([currency, amount]) => ({ currency, amount })),
    unpriced: tally.unpriced,
  }
}

/** One currency's entries added up, kept apart rather than summed across: a bill is in one currency. */
function sumCosts(slices: readonly SliceTally[]): Array<{ currency: string, amount: number }> {
  const out = new Map<string, number>()
  for (const slice of slices) for (const [currency, amount] of slice.costs) out.set(currency, (out.get(currency) ?? 0) + amount)
  return [...out].map(([currency, amount]) => ({ currency, amount }))
}

/** How a key slice is named, spelled the way the usage panel's own key picker spells it. */
function keySliceLabel(row: { providerLabel: string, keyId: string, keyLabel: string }): string {
  return row.keyId ? `${row.providerLabel} · ${row.keyLabel}` : row.providerLabel
}

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
    const currency = model.priceCurrency
    // A price with no currency has no unit to be summed in: the same rule the model rows follow, so a key
    // is reported unpriced rather than given a dollar total nobody chose. (The key dimension still matches
    // by label — only `chat_usage_daily_model` carries an id — so this is the rename limit of that view.)
    if (!currency) {
      if (row.modelLabel) entry.unpriced = true
      continue
    }
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

assistantRoutes.get('/stats/overview', async (c) => c.json({ overview: await store(c).usageOverview() }))

assistantRoutes.get('/activity', async (c) => c.json({ activity: await store(c).listActivity(100) }))

// -------------------------------------------------------------- export/import

/**
 * The backup file, together with the size a restore can read.
 *
 * Export is unbounded and import is not: `MAX_BACKUP_BYTES` is what the import route accepts, so a big
 * account can write a file it cannot read back. The file is the reader's own data, so this still hands it
 * over — refusing would turn "too large to restore" into "no copy at all" — but it says the truth in every
 * channel a response has, because the worst time to meet that ceiling is the day the file is needed.
 * Nothing here truncates: the number reported is the number of bytes sent.
 */
assistantRoutes.get('/export', async (c) => {
  const s = store(c)
  const payload = await exportAssistant(s)
  const text = JSON.stringify(payload, null, 2)
  const bytes = new TextEncoder().encode(text).byteLength
  const importable = bytes <= MAX_BACKUP_BYTES
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': 'attachment; filename="inkstone-assistant-backup.json"',
    'x-backup-bytes': String(bytes),
    'x-backup-importable': String(importable),
  })
  if (!importable) {
    headers.set('warning', `299 inkstone "This backup is ${formatBytes(bytes)}, over the ${formatBytes(MAX_BACKUP_BYTES)} a restore can read. Delete older conversations or answers and export again."`)
  }
  await s.recordActivity('data.exported', importable
    ? 'assistant backup downloaded'
    : `assistant backup downloaded: ${formatBytes(bytes)}, over the ${formatBytes(MAX_BACKUP_BYTES)} a restore can read`)
  return new Response(text, { headers })
})

assistantRoutes.post('/import', async (c) => {
  const s = store(c)
  // A backup is a file the reader picked, so it is read under the same byte ceiling as the other
  // whole-store imports rather than handed to `req.json()` uncapped.
  let raw: Record<string, unknown>
  try {
    raw = await readJson<Record<string, unknown>>(c, MAX_BACKUP_BYTES)
  } catch (error) {
    // The body reader answers "too large" with no number and no way down. This file came from an export
    // that is deliberately unbounded, so the one thing the reader can still do is named here.
    if (error instanceof ApiError && error.status === 413) {
      throw ApiError.tooLarge(`That backup is over the ${formatBytes(MAX_BACKUP_BYTES)} a restore can read. Delete older conversations or answers, export again, and import the new file.`)
    }
    throw error
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw ApiError.badRequest('The backup is not a JSON object.')
  const summary = await importAssistant(s, raw as Record<string, unknown>)
  await s.recordActivity('data.imported', `backup imported (${summary.conversations} conversation(s))`)
  return c.json({ imported: summary })
})

/**
 * A chat log exported somewhere else, read in as threads of this account.
 *
 * Not the backup route: this file was not written by this app, so there is no format marker to check and
 * no promise that its rows are rows. What is promised instead is in `session-import.ts` — the shapes a
 * reader is likely to have are read, the turns that cannot be stored are refused out loud, and the counts
 * in the answer are the counts the batches wrote. The text arrives as a JSON field rather than as a file
 * body because that is the shape the backup import on the same screen already posts; the ceiling is on the
 * text either way, and the ceiling that counts is the one applied here rather than the one the browser
 * checked before asking.
 */
assistantRoutes.post('/sessions/import', async (c) => {
  const s = store(c)
  let raw: { filename?: unknown, text?: unknown }
  try {
    raw = await readJson<{ filename?: unknown, text?: unknown }>(c, SESSION_IMPORT_BODY_BYTES)
  } catch (error) {
    // The body reader gives no number and no way down, and the reader has to know which file to go split.
    if (error instanceof ApiError && error.status === 413) {
      throw ApiError.tooLarge(`That file is over the ${formatBytes(MAX_SESSION_FILE_BYTES)} a session import reads. Split it into fewer conversations and import them one at a time.`)
    }
    throw error
  }
  if (typeof raw.text !== 'string' || !raw.text.trim()) throw ApiError.badRequest('No file text arrived.')
  // The name only steers which shape is tried first; the content decides, so a lying extension costs the
  // reader a retry rather than a wrong import.
  const filename = typeof raw.filename === 'string' ? raw.filename.slice(0, 300) : ''
  const summary = await importSessionFile(s, filename, raw.text)
  await s.recordActivity('session.imported', `session file imported (${summary.threads} thread(s), ${summary.messages} message(s))`)
  return c.json({ imported: summary })
})
