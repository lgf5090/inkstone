/**
 * `/api/cloudflare/v1` — the OpenAI-compatible face of Cloudflare Workers AI.
 *
 * The shapes are OpenAI's on purpose: the screens already speak them, and a request copied from
 * another tool works unchanged. Account selection travels in the body (`accountId`), because the
 * streaming and JSON paths share one request shape and a custom header would only be readable by one
 * of them.
 *
 * Cloudflare's free allowance is per account and per UTC day. A refusal that means "today is used up"
 * marks the account exhausted and moves to the next one, so a reader with several accounts never sees
 * a limit before every account has one. The upstream's own words are kept, truncated, for the account
 * owner to read; they are never turned into a status Cloudflare did not send.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings, Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { toBase64 } from '../../lib/encoding'
import { isValidId, newId } from '../../lib/id'
import {
  accountHasFeature,
  loadAccount,
  loadActiveAccounts,
  type LoadedAccount,
} from '../../cloudflare/accounts'
import { cfFetchRaw } from '../../cloudflare/cf-api'
import { createAuditLog } from '../../cloudflare/audit'
import {
  estimateImageNeurons,
  estimateNeurons,
  estimateTranslationNeurons,
  estimateTtsNeurons,
} from '../../cloudflare/pricing'
import {
  QUOTA_LIMITS,
  getQuotaForAccount,
  incrementQuota,
  setExhausted,
} from '../../cloudflare/quota'
import {
  buildTtsCfBody,
  extractTtsAdvancedParams,
  extractTtsSpeakerMeta,
  getAvailableModels,
  getModelInputSchema,
  type TtsAdvancedOptions,
} from '../../cloudflare/ai-models'

export const aiV1Router = new Hono<AppBindings>()

const AI_DAILY_NEURON_LIMIT = QUOTA_LIMITS.ai_neurons

const MAX_MODEL_CHARS = 200
const MAX_CHAT_MESSAGES = 200
const MAX_CHAT_CONTENT_CHARS = 100_000
const MAX_CHAT_TOKENS = 32_768
const MAX_PROMPT_CHARS = 10_000
const MAX_IMAGE_INPUT_CHARS = 16_000_000
const MAX_TTS_CHARS = 10_000
const MAX_TRANSLATION_CHARS = 10_000
const MAX_ACCOUNT_ID_CHARS = 64

const NON_STREAM_TIMEOUT_MS = 300_000
const STREAM_TIMEOUT_MS = 600_000
const HEARTBEAT_DELAY_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 10_000

const MAX_ERROR_CHARS = 300

/** Cloudflare model ids look like `@cf/meta/llama-3.1-8b-instruct`; nothing else may enter a path. */
const MODEL_ID_RE = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/

const CHAT_ROLES = new Set(['system', 'user', 'assistant'])

/** The 64x64 white mask SDXL's image-to-image mode requires; a full-white mask allows every pixel to change. */
const WHITE_MASK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAKUlEQVR4nO3MQREAAAwCIPuX1hD77SAA6VEEAoFAIBAIBAKBQCAQfA8Gpwvw4pr3blgAAAAASUVORK5CYII='

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface UpstreamFailure {
  status: number
  body: string
}

type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; failure: UpstreamFailure }

// ---------------------------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------------------------

async function readJsonBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null)
  const record = asRecord(value)
  if (!record) throw ApiError.badRequest('A JSON object body is required')
  return record
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readAccountId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest('accountId must be a string')
  const id = value.trim()
  if (!id || id === 'auto') return undefined
  if (id.length > MAX_ACCOUNT_ID_CHARS || !isValidId(id)) {
    throw ApiError.badRequest('accountId is not a valid account id')
  }
  return id
}

function readModel(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('model is required')
  const model = value.trim()
  if (!model || model.length > MAX_MODEL_CHARS || !MODEL_ID_RE.test(model) || model.includes('..')) {
    throw ApiError.badRequest('model is not a valid Cloudflare model id')
  }
  return model
}

function readText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) throw ApiError.badRequest(`${field} is required`)
  if (value.length > max) throw ApiError.tooLarge(`${field} is too long`)
  return value
}

function readOptionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`)
  const text = value.trim()
  if (!text) return undefined
  if (text.length > max) throw ApiError.tooLarge(`${field} is too long`)
  return text
}

function readOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.badRequest(`${field} must be a number`)
  }
  if (value < min || value > max) throw ApiError.badRequest(`${field} is out of range`)
  return value
}

function readChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('messages must be a non-empty array')
  }
  if (value.length > MAX_CHAT_MESSAGES) {
    throw ApiError.badRequest(`messages cannot exceed ${MAX_CHAT_MESSAGES} entries`)
  }
  return value.map((entry, index) => {
    const record = asRecord(entry)
    if (!record) throw ApiError.badRequest(`messages[${index}] must be an object`)
    const role = record.role
    if (typeof role !== 'string' || !CHAT_ROLES.has(role)) {
      throw ApiError.badRequest(`messages[${index}].role must be system, user or assistant`)
    }
    const content = record.content
    if (typeof content !== 'string') {
      throw ApiError.badRequest(`messages[${index}].content must be a string`)
    }
    if (content.length > MAX_CHAT_CONTENT_CHARS) {
      throw ApiError.tooLarge(`messages[${index}].content is too long`)
    }
    return { role: role as ChatMessage['role'], content }
  })
}

// ---------------------------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------------------------

function hasUsableAuth(account: LoadedAccount): boolean {
  return account.auth.auth_type === 'token'
    ? Boolean(account.auth.api_token)
    : Boolean(account.auth.api_key && account.auth.email)
}

async function usableAiAccounts(
  env: Env,
  userId: string,
  skip: Set<string>,
): Promise<LoadedAccount[]> {
  return (await loadActiveAccounts(env, userId)).filter(({ row }) => (
    !skip.has(row.id)
    && Boolean(row.cf_account_id)
    && accountHasFeature(row, 'ai')
  )).filter(hasUsableAuth)
}

async function selectAiAccount(
  env: Env,
  userId: string,
  skip: Set<string>,
): Promise<LoadedAccount | null> {
  const accounts = await usableAiAccounts(env, userId, skip)
  const available: Array<{ account: LoadedAccount; used: number }> = []
  for (const account of accounts) {
    const quota = await getQuotaForAccount(env, userId, account.row.id, 'ai_neurons')
    if (quota?.exhausted === 1) continue
    const used = quota?.count ?? 0
    if (used >= AI_DAILY_NEURON_LIMIT) continue
    available.push({ account, used })
  }
  available.sort((left, right) => (
    left.used - right.used
    || left.account.row.created_at - right.account.row.created_at
    || left.account.row.id.localeCompare(right.account.row.id)
  ))
  return available[0]?.account ?? null
}

/** Whether the reader has an AI account at all, as opposed to one whose allowance is spent. */
async function hasAiAccount(env: Env, userId: string): Promise<boolean> {
  return (await usableAiAccounts(env, userId, new Set())).length > 0
}

async function loadRequestedAccount(env: Env, userId: string, id: string): Promise<LoadedAccount> {
  const account = await loadAccount(env, userId, id)
  if (account.row.is_active !== 1) throw ApiError.notFound('That Cloudflare account is not active')
  if (!accountHasFeature(account.row, 'ai')) throw ApiError.badRequest('That account does not have AI enabled')
  if (!account.row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id')
  if (!hasUsableAuth(account)) throw ApiError.badRequest('That account has no Cloudflare credential')
  return account
}

/** An explicit account is either used or refused; only the automatic choice may rotate. */
async function chooseAiAccount(
  env: Env,
  userId: string,
  accountId: string | undefined,
  skip: Set<string>,
): Promise<LoadedAccount | null> {
  if (accountId) return skip.size > 0 ? null : await loadRequestedAccount(env, userId, accountId)
  return await selectAiAccount(env, userId, skip)
}

function accountPath(account: LoadedAccount, suffix: string): string {
  const id = account.row.cf_account_id
  if (!id) throw ApiError.badRequest('That account has no Cloudflare account id')
  return `/accounts/${encodeURIComponent(id)}${suffix}`
}

function runPath(account: LoadedAccount, model: string): string {
  return accountPath(account, `/ai/run/${model}`)
}

async function postJson(
  account: LoadedAccount,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return await cfFetchRaw(account.auth, path, {
    method: 'POST',
    body,
    timeoutMs,
    headers: { Accept: 'application/json', ...(extraHeaders ?? {}) },
    ...(signal ? { signal } : {}),
  })
}

// ---------------------------------------------------------------------------------------------
// Upstream errors and rotation
// ---------------------------------------------------------------------------------------------

function isNeuronLimitError(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    const record = asRecord(parsed)
    const errors = Array.isArray(parsed)
      ? parsed
      : record?.errors ?? asRecord(record?.result)?.errors
    if (Array.isArray(errors)) {
      const hit = errors.some((entry) => Number(asRecord(entry)?.code) === 4006)
      if (hit) return true
    }
  } catch {
    // Not JSON: the keyword check below is the fallback Cloudflare's prose still satisfies.
  }
  const lower = text.toLowerCase()
  return lower.includes('daily free allocation') || lower.includes('neuron limit')
}

function extractCfError(raw: string): string {
  try {
    const parsed = asRecord(JSON.parse(raw))
    const errors = parsed?.errors
    if (Array.isArray(errors)) {
      const message = asRecord(errors[0])?.message
      if (typeof message === 'string' && message) return message.slice(0, MAX_ERROR_CHARS)
    }
    const errorMessage = asRecord(parsed?.error)?.message
    if (typeof errorMessage === 'string' && errorMessage) return errorMessage.slice(0, MAX_ERROR_CHARS)
    if (typeof parsed?.message === 'string' && parsed.message) return parsed.message.slice(0, MAX_ERROR_CHARS)
  } catch {
    // Plain text is still the upstream's answer.
  }
  const trimmed = raw.trim()
  return (trimmed || 'Cloudflare refused the request').slice(0, MAX_ERROR_CHARS)
}

function upstreamFailureError(failure: UpstreamFailure): ApiError {
  const message = extractCfError(failure.body)
  if (failure.status === 400 || failure.status === 413 || failure.status === 415 || failure.status === 422) {
    return new ApiError(
      failure.status,
      failure.status === 413 ? 'payload_too_large' : 'bad_request',
      message,
    )
  }
  if (failure.status === 429) return new ApiError(429, 'cloudflare_upstream', message)
  return new ApiError(502, 'cloudflare_upstream', message)
}

function quotaExceededError(): ApiError {
  return new ApiError(
    429,
    'cloudflare_quota_exceeded',
    'All Cloudflare accounts have reached the daily AI neuron limit',
  )
}

function notConfiguredError(): ApiError {
  return new ApiError(
    503,
    'cloudflare_not_configured',
    'No active Cloudflare account with AI enabled is available',
  )
}

/**
 * Run one request against the first usable account, and after a daily-limit refusal against the next.
 *
 * Any other refusal is the answer: rotating on a bad model id or a malformed body would hide a bug
 * from the caller and spend another account's allowance proving the same thing.
 */
async function runWithAiAccount<T>(
  env: Env,
  userId: string,
  accountId: string | undefined,
  attempt: (account: LoadedAccount) => Promise<AttemptOutcome<T>>,
  firstAccount?: LoadedAccount,
): Promise<T> {
  const skip = new Set<string>()
  let next: LoadedAccount | null = firstAccount ?? null
  let lastFailure: UpstreamFailure | null = null
  for (;;) {
    const account = next ?? await chooseAiAccount(env, userId, accountId, skip)
    next = null
    if (!account) {
      if (lastFailure || await hasAiAccount(env, userId)) throw quotaExceededError()
      throw notConfiguredError()
    }
    skip.add(account.row.id)
    const outcome = await attempt(account)
    if (outcome.ok) return outcome.value
    lastFailure = outcome.failure
    if (!isNeuronLimitError(outcome.failure.body)) throw upstreamFailureError(outcome.failure)
    await setExhausted(env, userId, account.row.id, 'ai_neurons')
  }
}

// ---------------------------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------------------------

interface AiModelView {
  id: string
  task?: string
  speakers?: string[]
  default_speaker?: string
  advanced_params?: Record<string, unknown>
}

function normalizeTaskName(value: string): string {
  return value.toLowerCase().replace(/-/g, ' ')
}

aiV1Router.get('/models', async (c) => {
  const userId = c.get('userId')
  const task = c.req.query('task')?.trim() || undefined
  const requested = readAccountId(c.req.query('accountId'))
  const account = requested
    ? await loadRequestedAccount(c.env, userId, requested)
    : await selectAiAccount(c.env, userId, new Set())
  if (!account) {
    const exhausted = await hasAiAccount(c.env, userId)
    throw exhausted ? quotaExceededError() : notConfiguredError()
  }

  const models = await getAvailableModels(account, task)
  const wantsSpeech = task ? normalizeTaskName(task).includes('text to speech') : false
  const metadata = new Map<string, {
    speakers?: string[]
    defaultSpeaker?: string
    advancedParams?: Record<string, unknown>
  }>()

  if (wantsSpeech) {
    await Promise.all(models.map(async (model) => {
      const schema = await getModelInputSchema(account, model.id)
      if (!schema) return
      const speaker = extractTtsSpeakerMeta(schema)
      const advancedParams = extractTtsAdvancedParams(schema)
      metadata.set(model.id, {
        ...(speaker.speakers.length ? { speakers: speaker.speakers } : {}),
        ...(speaker.defaultSpeaker ? { defaultSpeaker: speaker.defaultSpeaker } : {}),
        ...(advancedParams ? { advancedParams } : {}),
      })
    }))
  }

  const data: AiModelView[] = models.map((model) => {
    const meta = metadata.get(model.id)
    return {
      id: model.id,
      ...(model.task ? { task: model.task } : {}),
      ...(meta?.speakers ? { speakers: meta.speakers } : {}),
      ...(meta?.defaultSpeaker ? { default_speaker: meta.defaultSpeaker } : {}),
      ...(meta?.advancedParams ? { advanced_params: meta.advancedParams } : {}),
    }
  })

  return c.json({ object: 'list', data })
})

// ---------------------------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------------------------

function readChatUsage(value: unknown): ChatUsage | null {
  const record = asRecord(value)
  if (!record) return null
  const details = asRecord(record.prompt_tokens_details)
  const read = (key: string): number | undefined => (
    typeof record[key] === 'number' ? record[key] as number : undefined
  )
  return {
    prompt_tokens: read('prompt_tokens'),
    completion_tokens: read('completion_tokens'),
    total_tokens: read('total_tokens'),
    ...(typeof details?.cached_tokens === 'number'
      ? { prompt_tokens_details: { cached_tokens: details.cached_tokens } }
      : {}),
  }
}

function neuronsForChat(model: string, usage: ChatUsage): number {
  return estimateNeurons(
    model,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
    usage.prompt_tokens_details?.cached_tokens ?? 0,
  )
}

function chatAuditDetail(rid: string, kind: string, usage: ChatUsage, neurons: number): string {
  return `[${rid}] ${kind} tokens: in=${usage.prompt_tokens ?? 0} out=${usage.completion_tokens ?? 0}`
    + ` total=${usage.total_tokens ?? 0} cached=${usage.prompt_tokens_details?.cached_tokens ?? 0}`
    + ` neurons=${neurons}`
}

function buildChatUpstreamBody(
  body: Record<string, unknown>,
  model: string,
  messages: ChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  const upstream: Record<string, unknown> = { model, messages }
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ApiError.badRequest(`${key} must be a number`)
    }
    upstream[key] = value
  }
  if (body.max_tokens !== undefined) {
    const maxTokens = readOptionalNumber(body.max_tokens, 'max_tokens', 1, MAX_CHAT_TOKENS)
    if (maxTokens === undefined) throw ApiError.badRequest('max_tokens must be a number')
    upstream.max_tokens = Math.round(maxTokens)
  } else if (body.max_completion_tokens !== undefined) {
    const maxTokens = readOptionalNumber(body.max_completion_tokens, 'max_completion_tokens', 1, MAX_CHAT_TOKENS)
    if (maxTokens === undefined) throw ApiError.badRequest('max_completion_tokens must be a number')
    upstream.max_completion_tokens = Math.round(maxTokens)
  } else {
    upstream.max_tokens = 4096
  }
  if (stream) {
    upstream.stream = true
    upstream.stream_options = { include_usage: true }
  }
  return upstream
}

interface SseLine {
  done: boolean
  usage?: ChatUsage
  error: boolean
}

function inspectSseLine(line: string): SseLine {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return { done: false, error: false }
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return { done: true, error: false }
  try {
    const parsed = asRecord(JSON.parse(payload))
    return {
      done: false,
      error: Boolean(parsed?.error),
      ...(parsed?.usage ? { usage: readChatUsage(parsed.usage) ?? undefined } : {}),
    }
  } catch {
    return { done: false, error: false }
  }
}

aiV1Router.post('/chat/completions', async (c) => {
  const userId = c.get('userId')
  const body = await readJsonBody(c)
  const model = readModel(body.model)
  const messages = readChatMessages(body.messages)
  const accountId = readAccountId(body.accountId)
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw ApiError.badRequest('stream must be a boolean')
  }
  const stream = body.stream === true
  const upstreamBody = buildChatUpstreamBody(body, model, messages, stream)
  const rid = newId().slice(0, 8)

  if (!stream) {
    const completion = await runWithAiAccount(c.env, userId, accountId, async (account) => {
      const response = await postJson(
        account,
        accountPath(account, '/ai/v1/chat/completions'),
        upstreamBody,
        NON_STREAM_TIMEOUT_MS,
      )
      if (!response.ok) {
        return { ok: false, failure: { status: response.status, body: await response.text() } }
      }
      const parsed = asRecord(await response.json().catch(() => null))
      if (!parsed) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare returned an unexpected completion body')
      const usage = readChatUsage(parsed.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      const neurons = neuronsForChat(model, usage)
      await incrementQuota(c.env, userId, account.row.id, 'ai_neurons', neurons)
      await createAuditLog(
        c.env,
        userId,
        account.row.id,
        'ai_chat_completion',
        model,
        chatAuditDetail(rid, 'non-stream', usage, neurons),
        'success',
      )
      return {
        ok: true,
        value: {
          ...parsed,
          id: typeof parsed.id === 'string' && parsed.id ? parsed.id : `chatcmpl-${newId()}`,
          object: typeof parsed.object === 'string' && parsed.object ? parsed.object : 'chat.completion',
          model: typeof parsed.model === 'string' && parsed.model ? parsed.model : model,
          usage,
        } satisfies Record<string, unknown>,
      }
    })
    return c.json(completion)
  }

  const first = await chooseAiAccount(c.env, userId, accountId, new Set())
  if (!first) {
    const exhausted = await hasAiAccount(c.env, userId)
    throw exhausted ? quotaExceededError() : notConfiguredError()
  }

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const upstreamController = new AbortController()
  let readerGone = false
  let closed = false

  const onClientAbort = (): void => {
    readerGone = true
    upstreamController.abort()
  }
  if (c.req.raw.signal.aborted) onClientAbort()
  else c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true })

  const write = async (chunk: string | Uint8Array): Promise<boolean> => {
    if (closed || readerGone) return false
    try {
      await writer.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      return true
    } catch {
      readerGone = true
      upstreamController.abort()
      return false
    }
  }

  const sendEvent = async (payload: unknown): Promise<void> => {
    await write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await writer.close()
    } catch {
      // Already cancelled by the reader; nothing is left to close.
    }
  }

  const run = async (): Promise<void> => {
    let usedAccount: LoadedAccount | null = null
    let usage: ChatUsage | null = null
    let seenDone = false
    let status: 'success' | 'error' = 'success'
    let interval: ReturnType<typeof setInterval> | null = null
    const stopHeartbeat = (): void => {
      clearTimeout(delay)
      if (interval !== null) clearInterval(interval)
      interval = null
    }
    const delay = setTimeout(() => {
      void write(': heartbeat\n\n')
      interval = setInterval(() => { void write(': heartbeat\n\n') }, HEARTBEAT_INTERVAL_MS)
    }, HEARTBEAT_DELAY_MS)

    try {
      let account: LoadedAccount | null = first
      const skip = new Set<string>()
      let response: Response | null = null
      while (!response) {
        if (!account) {
          status = 'error'
          await sendEvent({
            error: {
              message: 'All Cloudflare accounts have reached the daily AI neuron limit',
              type: 'quota_exceeded',
              code: 'cloudflare_quota_exceeded',
            },
          })
          await write('data: [DONE]\n\n')
          return
        }
        skip.add(account.row.id)
        const candidate = await postJson(
          account,
          accountPath(account, '/ai/v1/chat/completions'),
          upstreamBody,
          STREAM_TIMEOUT_MS,
          upstreamController.signal,
        )
        if (candidate.ok) {
          response = candidate
          usedAccount = account
          break
        }
        const failureBody = await candidate.text()
        if (!isNeuronLimitError(failureBody)) {
          status = 'error'
          await sendEvent({
            error: {
              message: extractCfError(failureBody),
              type: 'upstream_error',
              code: 'cloudflare_upstream',
            },
          })
          await write('data: [DONE]\n\n')
          return
        }
        await setExhausted(c.env, userId, account.row.id, 'ai_neurons')
        account = await chooseAiAccount(c.env, userId, accountId, skip)
      }

      const responseBody = response.body
      if (!responseBody) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare returned an empty stream')
      const reader = responseBody.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let firstChunk = true
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (readerGone) {
          await reader.cancel().catch(() => undefined)
          break
        }
        if (firstChunk) {
          stopHeartbeat()
          firstChunk = false
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const inspected = inspectSseLine(line)
          if (inspected.done) seenDone = true
          if (inspected.error) status = 'error'
          if (inspected.usage) usage = inspected.usage
        }
        if (!(await write(value))) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        const inspected = inspectSseLine(buffer)
        if (inspected.done) seenDone = true
        if (inspected.error) status = 'error'
        if (inspected.usage) usage = inspected.usage
      }
      if (!readerGone && !seenDone) await write('data: [DONE]\n\n')
    } catch (error) {
      status = 'error'
      if (!readerGone) {
        await sendEvent({
          error: {
            message: error instanceof ApiError ? error.message : 'The completion stream failed',
            type: 'server_error',
            code: error instanceof ApiError ? error.code : 'internal',
          },
        })
        await write('data: [DONE]\n\n')
      }
    } finally {
      stopHeartbeat()
      c.req.raw.signal.removeEventListener('abort', onClientAbort)
      if (readerGone) status = 'error'
      if (usedAccount) {
        // Accounting happens after the readable content; a failure here must not leave the stream open.
        try {
          if (usage) {
            const neurons = neuronsForChat(model, usage)
            await incrementQuota(c.env, userId, usedAccount.row.id, 'ai_neurons', neurons)
            await createAuditLog(
              c.env,
              userId,
              usedAccount.row.id,
              'ai_chat_completion',
              model,
              chatAuditDetail(rid, 'stream', usage, neurons),
              status,
            )
          } else {
            await createAuditLog(
              c.env,
              userId,
              usedAccount.row.id,
              'ai_chat_completion',
              model,
              `[${rid}] stream ${status} tokens: none (no usage in SSE)`,
              status,
            )
          }
        } catch (error) {
          console.error(`[inkstone] AI stream accounting failed (${rid}):`, (error as Error)?.message)
        }
      }
      await close()
    }
  }

  c.executionCtx.waitUntil(run())

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
    },
  })
})

// ---------------------------------------------------------------------------------------------
// POST /v1/images/generations
// ---------------------------------------------------------------------------------------------

function readImageBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const prompt = readText(body.prompt, 'prompt', MAX_PROMPT_CHARS)
  const image = readOptionalText(body.image, 'image', MAX_IMAGE_INPUT_CHARS)
  const numSteps = readOptionalNumber(body.num_steps, 'num_steps', 1, 50)
  const width = readOptionalNumber(body.width, 'width', 64, 2048)
  const height = readOptionalNumber(body.height, 'height', 64, 2048)
  const guidance = readOptionalNumber(body.guidance, 'guidance', 0, 30)
  const strength = readOptionalNumber(body.strength, 'strength', 0, 1)
  const negativePrompt = readOptionalText(body.negative_prompt, 'negative_prompt', MAX_PROMPT_CHARS)

  const cfBody: Record<string, unknown> = { prompt }
  const isFlux = model.includes('flux')
  const isSd = model.includes('stable-diffusion')

  if (isFlux) {
    if (numSteps !== undefined) cfBody.steps = Math.round(numSteps)
  } else if (isSd) {
    if (image) {
      cfBody.image_b64 = image
      // SDXL's image-to-image mode refuses a request without a mask; white means "may change anywhere".
      cfBody.mask_image = WHITE_MASK_PNG
    }
    if (width !== undefined) cfBody.width = Math.round(width)
    if (height !== undefined) cfBody.height = Math.round(height)
    if (numSteps !== undefined) cfBody.num_steps = Math.round(numSteps)
    if (guidance !== undefined) cfBody.guidance = guidance
    if (negativePrompt) cfBody.negative_prompt = negativePrompt
    if (strength !== undefined) cfBody.strength = strength
  } else {
    if (image) cfBody.image = image
    if (width !== undefined) cfBody.width = Math.round(width)
    if (height !== undefined) cfBody.height = Math.round(height)
    if (numSteps !== undefined) cfBody.num_steps = Math.round(numSteps)
    if (guidance !== undefined) cfBody.guidance = guidance
    if (negativePrompt) cfBody.negative_prompt = negativePrompt
  }

  return cfBody
}

/** Flux 2 accepts multipart only; its fields are prompt and steps. */
function buildImageRequest(
  model: string,
  cfBody: Record<string, unknown>,
): { body: string; contentType: string } {
  if (!model.includes('flux-2')) {
    return { body: JSON.stringify(cfBody), contentType: 'application/json' }
  }
  const boundary = `----InkstoneBoundary${newId()}`
  const addField = (name: string, value: string): string => (
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  )
  let body = addField('prompt', String(cfBody.prompt ?? ''))
  if (cfBody.steps !== undefined) body += addField('steps', String(cfBody.steps))
  body += `--${boundary}--\r\n`
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

async function readImageResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('image/') || contentType.includes('octet-stream')) {
    return toBase64(await response.arrayBuffer())
  }
  const text = await response.text()
  if (contentType.includes('json') || text.trim().startsWith('{')) {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = asRecord(JSON.parse(text))
    } catch {
      parsed = null
    }
    if (!parsed) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered with something that is not JSON')
    }
    if (parsed.success === false) return throwUpstreamBody(parsed, 'Cloudflare image generation failed')
    const result = asRecord(parsed.result)
    const images = result?.images
    const image = result?.image
      ?? parsed.image
      ?? (Array.isArray(images) ? images.find((entry): entry is string => typeof entry === 'string') : undefined)
    return typeof image === 'string' ? image : ''
  }
  if (text.trim().length > 100 && BASE64_RE.test(text.trim())) return text.trim()
  try {
    const parsed = asRecord(JSON.parse(text))
    const result = asRecord(parsed?.result)
    return typeof result?.image === 'string' ? result.image : ''
  } catch {
    return toBase64(new TextEncoder().encode(text))
  }
}

function throwUpstreamBody(parsed: Record<string, unknown>, fallback: string): never {
  const errors = parsed.errors
  const message = Array.isArray(errors) ? asRecord(errors[0])?.message : undefined
  throw new ApiError(
    502,
    'cloudflare_upstream',
    typeof message === 'string' ? message.slice(0, MAX_ERROR_CHARS) : fallback,
  )
}

aiV1Router.post('/images/generations', async (c) => {
  const userId = c.get('userId')
  const body = await readJsonBody(c)
  const model = readModel(body.model)
  const cfBody = readImageBody(body, model)
  const request = buildImageRequest(model, cfBody)
  const accountId = readAccountId(body.accountId)
  const rid = newId().slice(0, 8)

  const result = await runWithAiAccount(c.env, userId, accountId, async (account) => {
    const response = await postJson(
      account,
      runPath(account, model),
      request.body,
      NON_STREAM_TIMEOUT_MS,
      undefined,
      { 'Content-Type': request.contentType },
    )
    if (!response.ok) {
      return { ok: false, failure: { status: response.status, body: await response.text() } }
    }
    const b64 = await readImageResponse(response)
    if (!b64) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare returned no image')
    const neurons = estimateImageNeurons(model)
    await incrementQuota(c.env, userId, account.row.id, 'ai_neurons', neurons)
    await createAuditLog(
      c.env,
      userId,
      account.row.id,
      'ai_image_generation',
      model,
      `[${rid}] ${body.image ? 'image-to-image' : 'text-to-image'} neurons=${neurons}`,
      'success',
    )
    return {
      ok: true,
      value: {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: b64, neurons }],
      },
    }
  })

  return c.json(result)
})

// ---------------------------------------------------------------------------------------------
// POST /v1/audio/speech
// ---------------------------------------------------------------------------------------------

function readTtsOptions(body: Record<string, unknown>): TtsAdvancedOptions {
  const encoding = readOptionalText(body.encoding, 'encoding', 40)
  const container = readOptionalText(body.container, 'container', 40)
  const lang = readOptionalText(body.lang, 'lang', 40)
  const sampleRate = readOptionalNumber(body.sample_rate, 'sample_rate', 1, 192_000)
  const bitRate = readOptionalNumber(body.bit_rate, 'bit_rate', 1, 512_000)
  return {
    ...(encoding ? { encoding } : {}),
    ...(container ? { container } : {}),
    ...(lang ? { lang } : {}),
    ...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
    ...(bitRate !== undefined ? { bit_rate: bitRate } : {}),
  }
}

function findBase64Audio(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    return value.length > 50 && BASE64_RE.test(value) ? value : ''
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBase64Audio(entry, depth + 1)
      if (found) return found
    }
    return ''
  }
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.audio === 'string' && record.audio.length > 50) return record.audio
  for (const entry of Object.values(record)) {
    const found = findBase64Audio(entry, depth + 1)
    if (found) return found
  }
  return ''
}

async function readAudioResponse(response: Response): Promise<{ audio: string; contentType: string }> {
  const rawContentType = response.headers.get('content-type') ?? 'audio/mpeg'
  if (rawContentType.includes('json')) {
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered with something that is not JSON')
    }
    return { audio: findBase64Audio(parsed), contentType: 'audio/mpeg' }
  }
  return {
    audio: toBase64(await response.arrayBuffer()),
    contentType: rawContentType.startsWith('audio/') ? rawContentType : 'audio/mpeg',
  }
}

aiV1Router.post('/audio/speech', async (c) => {
  const userId = c.get('userId')
  const body = await readJsonBody(c)
  const model = readModel(body.model)
  const input = readText(body.input, 'input', MAX_TTS_CHARS)
  const voice = readOptionalText(body.voice, 'voice', 100)
  const accountId = readAccountId(body.accountId)
  const rid = newId().slice(0, 8)

  const target = await chooseAiAccount(c.env, userId, accountId, new Set())
  if (!target) {
    const exhausted = await hasAiAccount(c.env, userId)
    throw exhausted ? quotaExceededError() : notConfiguredError()
  }

  // The schema decides the text field and the speaker enum, so it is read from the account that is
  // about to speak; a rotated account receives the same body, which Cloudflare accepts for the model.
  const schema = await getModelInputSchema(target, model)
  const { body: cfBody, speaker } = buildTtsCfBody(
    schema,
    model,
    input,
    voice,
    readTtsOptions(body),
  )

  const result = await runWithAiAccount(c.env, userId, accountId, async (account) => {
    const response = await postJson(account, runPath(account, model), cfBody, NON_STREAM_TIMEOUT_MS)
    if (!response.ok) {
      return { ok: false, failure: { status: response.status, body: await response.text() } }
    }
    const audio = await readAudioResponse(response)
    if (!audio.audio) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare returned no audio')
    }
    const neurons = estimateTtsNeurons(input, model)
    await incrementQuota(c.env, userId, account.row.id, 'ai_neurons', neurons)
    await createAuditLog(
      c.env,
      userId,
      account.row.id,
      'ai_tts_generation',
      model,
      `[${rid}] chars=${input.length} speaker=${speaker ?? ''} neurons=${neurons}`,
      'success',
    )
    return {
      ok: true,
      value: {
        data: [{ audio: audio.audio, content_type: audio.contentType, neurons }],
      },
    }
  }, target)

  return c.json(result)
})

// ---------------------------------------------------------------------------------------------
// POST /v1/translations
// ---------------------------------------------------------------------------------------------

aiV1Router.post('/translations', async (c) => {
  const userId = c.get('userId')
  const body = await readJsonBody(c)
  const model = readModel(body.model)
  const text = readText(body.text, 'text', MAX_TRANSLATION_CHARS)
  const targetLang = readText(body.target_lang, 'target_lang', 40)
  const sourceLang = readOptionalText(body.source_lang, 'source_lang', 40)
  const accountId = readAccountId(body.accountId)
  const rid = newId().slice(0, 8)

  const indic = model.includes('indictrans2')
  const cfBody: Record<string, unknown> = indic
    ? { text, target_language: targetLang }
    : { text, source_lang: sourceLang ?? 'en', target_lang: targetLang }

  const result = await runWithAiAccount(c.env, userId, accountId, async (account) => {
    const response = await postJson(account, runPath(account, model), cfBody, NON_STREAM_TIMEOUT_MS)
    if (!response.ok) {
      return { ok: false, failure: { status: response.status, body: await response.text() } }
    }
    const parsed = asRecord(await response.json().catch(() => null))
    const nested = asRecord(parsed?.result)
    const translations = nested?.translations
    const translated = indic
      ? (Array.isArray(translations) && typeof translations[0] === 'string' ? translations[0] : '')
      : (typeof nested?.translated_text === 'string' && nested.translated_text)
        || (typeof nested?.output === 'string' && nested.output)
        || (typeof parsed?.translated_text === 'string' ? parsed.translated_text : '')
    if (!translated) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare returned no translation')
    const neurons = estimateTranslationNeurons(text, model)
    await incrementQuota(c.env, userId, account.row.id, 'ai_neurons', neurons)
    await createAuditLog(
      c.env,
      userId,
      account.row.id,
      'ai_translation',
      model,
      `[${rid}] chars=${text.length} source=${sourceLang ?? 'auto'} target=${targetLang} neurons=${neurons}`,
      'success',
    )
    return {
      ok: true,
      value: {
        data: [{ translated_text: translated, neurons }],
      },
    }
  })

  return c.json(result)
})
