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
  ASSISTANT_PROTOCOLS,
  AUTOMATION_KINDS,
  MAX_AUTOMATION_MESSAGE_CHARS,
  MAX_CONVERSATION_TITLE_CHARS,
  MAX_MEMORY_CHARS,
  MAX_TASK_NOTES_CHARS,
  MAX_TASK_TITLE_CHARS,
  MEMORY_REVIEW_ACTIONS,
  ASSISTANT_SETTING_KEYS,
  normalizeAssistantSettings,
  titleFromMessage,
  type AssistantMemoryCategory,
  type AssistantProtocol,
  type MemoryReviewAction,
  type TaskPriority,
  type TaskStatus,
} from '@shared/assistant'
import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { localDayBounds, parseLocalTime } from '@shared/assistant-time'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { FORM_BODY_LIMITS, JSON_BODY_LIMITS, readFormDataWithinLimit, readJson } from '../lib/request'
import { isValidId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { AssistantStore } from '../assistant/store'
import { MemoryHistoryService } from '../assistant/memory-service'
import { AutomationService } from '../assistant/automations'
import { AssistantRunner } from '../assistant/runner'
import { cancelApprovedAction, runApprovedAction } from '../assistant/tools'
import { exportAssistant, importAssistant } from '../assistant/backup'
import { suggestActiveModel } from '../assistant/model-config'
import { memoryEmbeddingStatus, reindexMemoryEmbeddings, semanticModel } from '../assistant/semantic'
import { CONTEXT_TOKEN_STEPS, reasoningValue } from '@shared/assistant'
import {
  CHAT_IMAGE_MAX_BYTES,
  ChatUploadError,
  deleteChatObject,
  formatBytes,
  readChatObject,
  saveChatUpload,
} from '../assistant/chat-files'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

/** Reads a stream up to a ceiling, so a remote server cannot decide how much memory this request uses. */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  const reader = body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel('payload_too_large')
      throw ApiError.badRequest(`That file is larger than ${formatBytes(maxBytes)}.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** A context budget is the reader's own choice from the composer's slider; null means 'use the global limit'. */
function contextBudgetValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(CONTEXT_TOKEN_STEPS[CONTEXT_TOKEN_STEPS.length - 1]!, Math.trunc(number))
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
  const tag = c.req.query('tag')?.trim().slice(0, 26)
  const filter: { folderId?: string | null, tagId?: string, starred?: boolean, pinned?: boolean } = {}
  // `folder=none` is the unfiled view; an absent parameter is the whole list.
  if (folder !== undefined) filter.folderId = folder === 'none' ? null : (isValidId(folder) ? folder : 'none')
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

assistantRoutes.patch('/conversations/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getConversation(id))) throw ApiError.notFound('Conversation not found')
  const body = await readJson<{ title?: unknown, pinned?: unknown, starred?: unknown, folderId?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.title === 'string') await s.renameConversation(id, text(body.title, MAX_CONVERSATION_TITLE_CHARS))
  if (typeof body.pinned === 'boolean') await s.setConversationPinned(id, body.pinned)
  if (typeof body.starred === 'boolean') await s.setConversationStarred(id, body.starred)
  if (body.folderId === null) await s.setConversationFolder(id, null)
  else if (typeof body.folderId === 'string') {
    if (!isValidId(body.folderId) || !(await s.knownFolder(body.folderId))) throw ApiError.badRequest('Unknown folder.')
    await s.setConversationFolder(id, body.folderId)
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
 * One turn, streamed as server-sent events.
 *
 * The reader's own disconnect is the abort signal: when the write fails the generator stops, so a
 * closed tab does not keep spending the account's AI budget on an answer nobody is reading.
 */
assistantRoutes.post('/chat', async (c) => {
  const body = await readJson<{ conversationId?: unknown, message?: string, retry?: boolean, attachments?: unknown }>(c, 64 * 1024)
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
  const content = message.trim().slice(0, 16_000)
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
  const action = await runApprovedAction(s, await approvalContext(c, s, settings), id)
  if (action) {
    const located = await s.messageForAction(id)
    if (located) await s.attachActionToMessage(located.messageId, located.toolId, action)
  }
  return c.json({ action })
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
  return {
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

assistantRoutes.post('/projects', async (c) => {
  const s = store(c)
  const body = await readJson<{ name?: unknown, description?: unknown }>(c, JSON_BODY_LIMITS.small)
  const name = text(body.name, 200)
  const existing = await s.findProjectByName(name)
  if (existing) return c.json({ project: existing })
  return c.json({ project: await s.createProject({ name, description: optionalText(body.description, 2000) ?? '' }) }, 201)
})

assistantRoutes.patch('/projects/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<{ name?: unknown, description?: unknown }>(c, JSON_BODY_LIMITS.small)
  const project = await s.updateProject(id, {
    ...(body.name !== undefined ? { name: text(body.name, 200) } : {}),
    ...(body.description !== undefined ? { description: optionalText(body.description, 2000) ?? '' } : {}),
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
  try {
    const attachment = await saveChatUpload(s, c.env, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      filename: file.name,
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
  const provider = await s.createProvider({ label, protocol, baseUrl, apiKey })
  const models = Array.isArray(body.models) ? body.models : []
  for (const entry of models.slice(0, 20)) {
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
  })
  if (!provider) throw ApiError.notFound('Provider not found')
  return c.json({ provider })
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
    maxOutputTokens: typeof body.maxOutputTokens === 'number'
      ? Math.min(8192, Math.max(64, Math.trunc(body.maxOutputTokens)))
      : null,
    reasoning: reasoningValue(body.reasoning),
    contextTokens: contextBudgetValue(body.contextTokens),
    vision: body.vision === undefined ? true : Boolean(body.vision),
  })
  return c.json({ model: created }, 201)
})

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
      ? { maxOutputTokens: body.maxOutputTokens === null ? null : Math.min(8192, Math.max(64, Math.trunc(Number(body.maxOutputTokens)))) }
      : {}),
    ...(body.reasoning !== undefined ? { reasoning: reasoningValue(body.reasoning) } : {}),
    ...(body.contextTokens !== undefined ? { contextTokens: contextBudgetValue(body.contextTokens) } : {}),
    ...(body.vision !== undefined ? { vision: Boolean(body.vision) } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
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
