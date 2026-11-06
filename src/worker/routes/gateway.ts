/**
 * The public face of the self-hosted gateway.
 *
 * Two OpenAI formats share one canonical messages array, one reservation, one upstream call, and one
 * usage/neuron calculation. The router itself is unauthenticated; a `gw_` bearer key is the only
 * credential, and every response error is rewritten to OpenAI's `{error:{message,type,code}}` shape so
 * an Inkstone internal error can never leak to an external caller.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { cfFetchRaw } from '../cloudflare/cf-api'
import { estimateNeurons } from '../cloudflare/pricing'
import {
  canonicalChatRequest,
  canonicalResponsesRequest,
  estimatePromptTokens,
  listGatewayModels,
  reservationFor,
  type CanonicalRequest,
} from '../cloudflare/ai-gateway-models'
import {
  addKeyUsage,
  consumeKeyRequest,
  keyAllowsModel,
  verifyGatewayKey,
  type GatewayKeyAuth,
} from '../cloudflare/ai-gateway-keys'
import {
  gatewayDay,
  gatewayLimit,
  markAccountFailure,
  markAccountSelected,
  markAccountSuccess,
  reserveNeurons,
  selectGatewayAccount,
  setAccountStatus,
  settleNeurons,
} from '../cloudflare/ai-gateway-quota'
import { insertGatewayRequest, type GatewayRequestInput } from '../cloudflare/ai-gateway-log'
import type { LoadedAccount } from '../cloudflare/accounts'

export const gatewayRoutes = new Hono<AppBindings>()

const MAX_BODY_BYTES = 512 * 1024
const MAX_ATTEMPTS = 3

class OpenAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
    readonly code: string,
  ) {
    super(message)
  }
}

function errorCodeOf(error: unknown): { status: number; type: string; code: string; message: string } {
  if (error instanceof OpenAiError) {
    return { status: error.status, type: error.type, code: error.code, message: error.message }
  }
  if (error instanceof ApiError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500
    return {
      status,
      type: status === 400 || status === 413 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error',
      code: error.code,
      message: error.message,
    }
  }
  return { status: 500, type: 'api_error', code: 'internal', message: 'The gateway failed to complete the request' }
}

function openAiJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  })
}

function openAiError(error: unknown, extra: Record<string, string> = {}): Response {
  const mapped = errorCodeOf(error)
  return openAiJson({ error: { message: mapped.message, type: mapped.type, code: mapped.code } }, mapped.status, extra)
}

function requestOrigin(c: Context<AppBindings>): string | null {
  const origin = c.req.header('origin')
  return origin && origin.trim() ? origin.trim() : null
}

function originAllowed(c: Context<AppBindings>): boolean {
  const origin = requestOrigin(c)
  if (!origin) return true
  const allowed = new Set<string>()
  allowed.add(new URL(c.req.url).origin)
  if (c.env.PUBLIC_URL) {
    try { allowed.add(new URL(c.env.PUBLIC_URL).origin) } catch { /* ignore a malformed deployment URL */ }
  }
  try {
    const url = new URL(origin)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return true
  } catch { return false }
  return allowed.has(origin)
}

function corsHeaders(c: Context<AppBindings>): Record<string, string> {
  const origin = requestOrigin(c)
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

async function authenticate(c: Context<AppBindings>): Promise<GatewayKeyAuth> {
  if (!originAllowed(c)) {
    throw new OpenAiError(403, 'This origin is not allowed to use the gateway', 'permission_error', 'origin_not_allowed')
  }
  const header = c.req.header('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new OpenAiError(401, 'Missing bearer key', 'authentication_error', 'invalid_api_key')
  const key = await verifyGatewayKey(c.env, match[1].trim())
  if (!key) throw new OpenAiError(401, 'Invalid or revoked gateway key', 'authentication_error', 'invalid_api_key')
  return key
}

async function readBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'The request body is too large')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw ApiError.badRequest('The request body is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('The request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function upstreamBody(request: CanonicalRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.workerModel,
    messages: request.messages,
    stream: request.stream,
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty
  if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty
  if (request.tools !== undefined) body.tools = request.tools
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice
  body.max_tokens = request.maxOutputTokens
  if (request.stream) body.stream_options = { include_usage: true }
  return body
}

function isNeuronLimitError(text: string): boolean {
  return /4006|daily free allocation|neuron limit/i.test(text)
}

function classifyUpstream(status: number, text: string): 'auth' | 'exhausted' | 'cooling' | 'client' {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || isNeuronLimitError(text)) return 'exhausted'
  if (status >= 500 || status === 408) return 'cooling'
  return 'client'
}

interface Acquired {
  account: LoadedAccount
  reserved: number
}

async function acquireAccount(
  env: Env,
  userId: string,
  model: string,
  reserve: number,
  limit: number,
  skip: Set<string>,
): Promise<Acquired | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = await selectGatewayAccount(env, userId, skip, reserve, limit)
    if (!candidate) return null
    const reservation = await reserveNeurons(env, userId, candidate.account.row.id, model, reserve, limit)
    if (reservation.ok) {
      await markAccountSelected(env, userId, candidate.account.row.id)
      return { account: candidate.account, reserved: reserve }
    }
    skip.add(candidate.account.row.id)
    if (reservation.reason === 'exhausted') {
      await setAccountStatus(env, userId, candidate.account.row.id, 'exhausted_today')
    }
  }
  return null
}

interface UpstreamOutcome {
  response: Response
  acquired: Acquired
}

async function callUpstream(
  c: Context<AppBindings>,
  request: CanonicalRequest,
  reserve: number,
  limit: number,
  skip: Set<string>,
  userId: string,
): Promise<UpstreamOutcome | { failure: 'no_account' | 'upstream'; upstreamStatus?: number; message?: string }> {
  let lastStatus: number | undefined
  let lastMessage = 'All eligible accounts failed'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const acquired = await acquireAccount(c.env, userId, request.alias, reserve, limit, skip)
    if (!acquired) return { failure: 'no_account' }
    const cfId = acquired.account.row.cf_account_id
    if (!cfId) {
      skip.add(acquired.account.row.id)
      await markAccountFailure(c.env, userId, acquired.account.row.id, 'auth_error', 'missing_cf_account_id')
      continue
    }
    let response: Response
    try {
      response = await cfFetchRaw(acquired.account.auth, `/accounts/${encodeURIComponent(cfId)}/ai/v1/chat/completions`, {
        method: 'POST',
        body: upstreamBody(request),
        timeoutMs: request.stream ? 600_000 : 300_000,
        headers: { Accept: request.stream ? 'text/event-stream' : 'application/json' },
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'cloudflare_not_configured') {
        lastStatus = 401
        lastMessage = error.message
        await markAccountFailure(c.env, userId, acquired.account.row.id, 'auth_error', 'missing_credentials')
        skip.add(acquired.account.row.id)
        continue
      }
      lastStatus = 502
      lastMessage = (error as Error)?.message ?? 'The upstream request failed'
      await markAccountFailure(c.env, userId, acquired.account.row.id, 'cooling', 'upstream_timeout')
      skip.add(acquired.account.row.id)
      continue
    }
    if (response.ok) return { response, acquired }
    lastStatus = response.status
    lastMessage = (await response.text()).slice(0, 300)
    const kind = classifyUpstream(response.status, lastMessage)
    if (kind === 'auth') {
      await markAccountFailure(c.env, userId, acquired.account.row.id, 'auth_error', 'upstream_auth')
    } else if (kind === 'exhausted') {
      await setAccountStatus(c.env, userId, acquired.account.row.id, 'exhausted_today', Date.now(), 0, 'upstream_neuron_limit')
    } else {
      await markAccountFailure(c.env, userId, acquired.account.row.id, 'cooling', `upstream_${response.status}`)
    }
    skip.add(acquired.account.row.id)
    if (kind === 'client') {
      return { failure: 'upstream', upstreamStatus: response.status, message: lastMessage || 'Cloudflare refused the request' }
    }
  }
  return { failure: 'upstream', upstreamStatus: lastStatus, message: lastMessage }
}

interface Usage {
  prompt: number
  completion: number
  total: number
  /** Cloudflare's OpenAI-compatible endpoint reports the billed neurons alongside the token counts. */
  neurons?: number
}

function readUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const prompt = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : 0
  const completion = typeof record.completion_tokens === 'number' ? record.completion_tokens : 0
  const total = typeof record.total_tokens === 'number' ? record.total_tokens : prompt + completion
  const neurons = typeof record.neurons === 'number' && Number.isFinite(record.neurons) ? record.neurons : undefined
  return { prompt, completion, total, ...(neurons !== undefined ? { neurons } : {}) }
}

function completionText(parsed: Record<string, unknown>): string {
  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  const message = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? (choices[0] as Record<string, unknown>).message
    : null
  if (!message || typeof message !== 'object' || Array.isArray(message)) return ''
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function fallbackUsage(request: CanonicalRequest, text: string): Usage {
  const prompt = estimatePromptTokens(request)
  const completion = Math.max(1, Math.ceil(text.length / 3))
  return { prompt, completion, total: prompt + completion }
}

interface FinalizeInput {
  request: CanonicalRequest
  acquired: Acquired
  at: number
  started: number
  usage: Usage | null
  status: GatewayRequestInput['status']
  httpStatus: number
  upstreamStatus?: number | null
  errorCode?: string | null
  requestId: string
}

async function finalize(
  env: Env,
  key: GatewayKeyAuth,
  input: FinalizeInput,
): Promise<void> {
  const { request, acquired, at, started, usage, requestId } = input
  const day = gatewayDay(at)
  const limit = gatewayLimit(env)
  const actual = usage
    ? Math.max(
        1,
        usage.neurons !== undefined
          ? Math.ceil(usage.neurons)
          : estimateNeurons(request.workerModel, usage.prompt, usage.completion),
      )
    : 0
  if (usage) {
    await settleNeurons(env, key.userId, acquired.account.row.id, request.alias, actual, limit, at)
    await addKeyUsage(env, key.id, key.userId, day, actual, usage.total)
    if (input.status === 'success') await markAccountSuccess(env, key.userId, acquired.account.row.id, at)
  }
  await insertGatewayRequest(env, {
    id: requestId,
    userId: key.userId,
    keyId: key.id,
    accountId: acquired.account.row.id,
    day,
    format: request.format,
    stream: request.stream,
    model: request.alias,
    status: input.status,
    httpStatus: input.httpStatus,
    upstreamStatus: input.upstreamStatus ?? null,
    reservedNeurons: acquired.reserved,
    actualNeurons: actual,
    promptTokens: usage?.prompt ?? 0,
    completionTokens: usage?.completion ?? 0,
    durationMs: at - started,
    errorCode: input.errorCode ?? null,
    now: at,
  })
}

function logFailure(
  env: Env,
  key: GatewayKeyAuth,
  request: CanonicalRequest | null,
  status: GatewayRequestInput['status'],
  httpStatus: number,
  code: string | null,
  started: number,
  requestId: string,
): void {
  void insertGatewayRequest(env, {
    id: requestId,
    userId: key.userId,
    keyId: key.id,
    accountId: '',
    day: gatewayDay(),
    format: request?.format ?? 'chat',
    stream: request?.stream ?? false,
    model: request?.alias ?? '',
    status,
    httpStatus,
    reservedNeurons: 0,
    actualNeurons: 0,
    promptTokens: 0,
    completionTokens: 0,
    durationMs: Date.now() - started,
    errorCode: code,
  }).catch(() => undefined)
}

function chatResponse(parsed: Record<string, unknown>, request: CanonicalRequest, cors: Record<string, string>): Response {
  return openAiJson({ ...parsed, model: request.alias }, 200, cors)
}

function responsesResponse(
  parsed: Record<string, unknown>,
  request: CanonicalRequest,
  requestId: string,
  usage: Usage,
): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000)
  const message = (Array.isArray(parsed.choices) ? parsed.choices[0] : null) as Record<string, unknown> | null
  const body = message && typeof message === 'object' ? message.message as Record<string, unknown> | undefined : undefined
  const text = body && typeof body.content === 'string' ? body.content : ''
  const calls = body && Array.isArray(body.tool_calls) ? body.tool_calls : []
  const output: Record<string, unknown>[] = []
  if (text) {
    output.push({
      type: 'message',
      id: `msg_${requestId}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const call of calls) {
    const record = call as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    if (!fn || typeof fn.name !== 'string') continue
    output.push({
      type: 'function_call',
      id: typeof record.id === 'string' ? record.id : `call_${requestId}`,
      call_id: typeof record.id === 'string' ? record.id : `call_${requestId}`,
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
      status: 'completed',
    })
  }
  if (output.length === 0) {
    output.push({ type: 'message', id: `msg_${requestId}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] })
  }
  return {
    id: `resp_${requestId}`,
    object: 'response',
    created_at: created,
    status: 'completed',
    model: request.alias,
    output,
    usage: { input_tokens: usage.prompt, output_tokens: usage.completion, total_tokens: usage.total },
  }
}

function streamHeaders(cors: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    ...cors,
  }
}

async function proxyChatStream(
  c: Context<AppBindings>,
  response: Response,
  acquired: Acquired,
  request: CanonicalRequest,
  key: GatewayKeyAuth,
  started: number,
  requestId: string,
): Promise<Response> {
  const body = response.body
  if (!body) throw new OpenAiError(502, 'Cloudflare returned an empty stream', 'api_error', 'upstream_error')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const abort = new AbortController()
  const onAbort = (): void => { abort.abort() }
  c.req.raw.signal?.addEventListener('abort', onAbort)
  let buffer = ''
  let usage: Usage | null = null
  let text = ''
  let status: GatewayRequestInput['status'] = 'success'
  let errorCode: string | null = null
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const parsed = parseSseData(line)
            if (!parsed) continue
            if (parsed.usage) usage = parsed.usage
            if (parsed.delta) text += parsed.delta
            if (parsed.error) { status = 'error'; errorCode = 'upstream_stream_error' }
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) {
          const parsed = parseSseData(buffer)
          if (parsed?.usage) usage = parsed.usage
          if (parsed?.delta) text += parsed.delta
        }
      } catch {
        status = 'client_abort'
      } finally {
        c.req.raw.signal?.removeEventListener('abort', onAbort)
        try {
          await finalize(c.env, key, {
            request,
            acquired,
            at: Date.now(),
            started,
            usage: usage ?? fallbackUsage(request, text),
            status,
            httpStatus: 200,
            errorCode,
            requestId,
          })
        } catch (error) {
          console.error('[inkstone] gateway stream accounting failed:', (error as Error)?.message)
        }
        controller.close()
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined)
    },
  })
  return new Response(stream, { headers: streamHeaders(corsHeaders(c)) })
}

function parseSseData(line: string): { delta?: string; usage?: Usage; error?: boolean } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    if (parsed.error) return { error: true }
    const usage = readUsage(parsed.usage)
    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    const choice = choices[0] as Record<string, unknown> | undefined
    const delta = choice && typeof choice === 'object' ? choice.delta as Record<string, unknown> | undefined : undefined
    return {
      ...(usage ? { usage } : {}),
      ...(delta && typeof delta.content === 'string' ? { delta: delta.content } : {}),
    }
  } catch {
    return null
  }
}

async function proxyResponsesStream(
  c: Context<AppBindings>,
  response: Response,
  acquired: Acquired,
  request: CanonicalRequest,
  key: GatewayKeyAuth,
  started: number,
  requestId: string,
): Promise<Response> {
  const body = response.body
  if (!body) throw new OpenAiError(502, 'Cloudflare returned an empty stream', 'api_error', 'upstream_error')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const responseId = `resp_${requestId}`
  const itemId = `msg_${requestId}`
  const createdAt = Math.floor(Date.now() / 1000)
  let buffer = ''
  let text = ''
  let usage: Usage | null = null
  let status: GatewayRequestInput['status'] = 'success'
  let sequence = 0
  let textStarted = false
  const toolItems = new Map<number, { id: string; name: string; arguments: string }>()
  const cors = corsHeaders(c)
  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: Record<string, unknown>): void => {
        controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`))
      }
      const responseObject = (state: string, output: unknown[] = []): Record<string, unknown> => ({
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: state,
        model: request.alias,
        output,
        usage: usage ? { input_tokens: usage.prompt, output_tokens: usage.completion, total_tokens: usage.total } : null,
      })
      send('response.created', { response: responseObject('in_progress') })
      send('response.in_progress', { response: responseObject('in_progress') })
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const parsed = parseSseData(line)
            if (!parsed) continue
            if (parsed.usage) usage = parsed.usage
            if (parsed.error) { status = 'error' }
            if (parsed.delta) {
              if (!textStarted) {
                textStarted = true
                send('response.output_item.added', {
                  output_index: 0,
                  item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
                })
                send('response.content_part.added', {
                  item_id: itemId, output_index: 0, content_index: 0,
                  part: { type: 'output_text', text: '', annotations: [] },
                })
              }
              text += parsed.delta
              send('response.output_text.delta', {
                item_id: itemId, output_index: 0, content_index: 0, delta: parsed.delta,
              })
            }
            const calls = extractToolDeltas(line)
            for (const call of calls) {
              const current = toolItems.get(call.index) ?? { id: `call_${requestId}_${call.index}`, name: '', arguments: '' }
              if (call.name) current.name = call.name
              current.arguments += call.arguments
              toolItems.set(call.index, current)
              if (call.name) {
                send('response.output_item.added', {
                  output_index: textStarted ? 1 + call.index : call.index,
                  item: { type: 'function_call', id: current.id, call_id: current.id, name: current.name, arguments: '', status: 'in_progress' },
                })
              }
              if (call.arguments) {
                send('response.function_call_arguments.delta', {
                  item_id: current.id, output_index: textStarted ? 1 + call.index : call.index, delta: call.arguments,
                })
              }
            }
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) {
          const parsed = parseSseData(buffer)
          if (parsed?.usage) usage = parsed.usage
          if (parsed?.delta) text += parsed.delta
        }
        if (textStarted) {
          send('response.output_text.done', {
            item_id: itemId, output_index: 0, content_index: 0, text,
          })
          send('response.content_part.done', {
            item_id: itemId, output_index: 0, content_index: 0,
            part: { type: 'output_text', text, annotations: [] },
          })
          send('response.output_item.done', {
            output_index: 0,
            item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
          })
        }
        for (const [index, call] of toolItems) {
          send('response.function_call_arguments.done', {
            item_id: call.id, output_index: textStarted ? 1 + index : index, arguments: call.arguments,
          })
          send('response.output_item.done', {
            output_index: textStarted ? 1 + index : index,
            item: { type: 'function_call', id: call.id, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' },
          })
        }
        const finalUsage = usage ?? fallbackUsage(request, text)
        const output = streamOutput(text, toolItems, itemId, requestId)
        send('response.completed', { response: { ...responseObject('completed', output), usage: {
          input_tokens: finalUsage.prompt, output_tokens: finalUsage.completion, total_tokens: finalUsage.total,
        } } })
      } catch {
        status = 'client_abort'
      } finally {
        try {
          await finalize(c.env, key, {
            request,
            acquired,
            at: Date.now(),
            started,
            usage: usage ?? fallbackUsage(request, text),
            status,
            httpStatus: 200,
            errorCode: status === 'error' ? 'upstream_stream_error' : null,
            requestId,
          })
        } catch (error) {
          console.error('[inkstone] gateway responses accounting failed:', (error as Error)?.message)
        }
        controller.close()
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined)
    },
  })
  return new Response(stream, { headers: streamHeaders(cors) })
}

function extractToolDeltas(line: string): Array<{ index: number; name?: string; arguments: string }> {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return []
  try {
    const parsed = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>
    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    const delta = choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined
      : undefined
    const calls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    return calls.map((call, fallback) => {
      const record = call as Record<string, unknown>
      const fn = record.function as Record<string, unknown> | undefined
      return {
        index: typeof record.index === 'number' ? record.index : fallback,
        ...(fn && typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
        arguments: fn && typeof fn.arguments === 'string' ? fn.arguments : '',
      }
    })
  } catch {
    return []
  }
}

function streamOutput(
  text: string,
  tools: Map<number, { id: string; name: string; arguments: string }>,
  itemId: string,
  requestId: string,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  if (text) {
    output.push({
      type: 'message', id: itemId, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const [index, call] of tools) {
    output.push({
      type: 'function_call',
      id: call.id || `call_${requestId}_${index}`,
      call_id: call.id || `call_${requestId}_${index}`,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    })
  }
  if (output.length === 0) {
    output.push({ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] })
  }
  return output
}

async function handle(c: Context<AppBindings>, format: 'chat' | 'responses'): Promise<Response> {
  const started = Date.now()
  const requestId = newId().replace(/-/g, '').slice(0, 24)
  let key: GatewayKeyAuth | null = null
  let request: CanonicalRequest | null = null
  try {
    key = await authenticate(c)
    const body = await readBody(c)
    request = format === 'chat' ? canonicalChatRequest(body) : canonicalResponsesRequest(body)
    if (!keyAllowsModel(key, request.alias)) {
      throw new OpenAiError(403, 'This key is not allowed to use that model', 'permission_error', 'model_not_allowed')
    }
    const day = gatewayDay()
    const limit = gatewayLimit(c.env)
    if (!(await consumeKeyRequest(c.env, key, day))) {
      logFailure(c.env, key, request, 'quota', 429, 'key_daily_limit', started, requestId)
      throw new OpenAiError(429, 'This key has reached its daily request limit', 'rate_limit_error', 'key_daily_limit')
    }
    const reserve = reservationFor(request)
    const outcome = await callUpstream(c, request, reserve, limit, new Set(), key.userId)
    if ('failure' in outcome) {
      const noAccount = outcome.failure === 'no_account'
      logFailure(c.env, key, request, 'quota', 429, noAccount ? 'no_account_quota' : 'upstream_error', started, requestId)
      throw new OpenAiError(
        noAccount ? 429 : (outcome.upstreamStatus && outcome.upstreamStatus < 500 ? 400 : 502),
        noAccount ? 'No account has enough neuron quota left today' : (outcome.message ?? 'All accounts failed'),
        noAccount ? 'rate_limit_error' : 'api_error',
        noAccount ? 'insufficient_quota' : 'upstream_error',
      )
    }

    if (request.stream) {
      return format === 'chat'
        ? await proxyChatStream(c, outcome.response, outcome.acquired, request, key, started, requestId)
        : await proxyResponsesStream(c, outcome.response, outcome.acquired, request, key, started, requestId)
    }

    const text = await outcome.response.text()
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) as Record<string, unknown> } catch {
      throw new OpenAiError(502, 'Cloudflare returned an unexpected completion body', 'api_error', 'upstream_error')
    }
    const usage = readUsage(parsed.usage) ?? fallbackUsage(request, completionText(parsed))
    await finalize(c.env, key, {
      request,
      acquired: outcome.acquired,
      at: Date.now(),
      started,
      usage,
      status: 'success',
      httpStatus: 200,
      requestId,
    })
    if (format === 'chat') {
      return chatResponse(parsed, request, corsHeaders(c))
    }
    return openAiJson(responsesResponse(parsed, request, requestId, usage), 200, corsHeaders(c))
  } catch (error) {
    if (key && request) {
      logFailure(c.env, key, request, 'error', errorCodeOf(error).status, errorCodeOf(error).code, started, requestId)
    }
    return openAiError(error, corsHeaders(c))
  }
}

gatewayRoutes.options('*', (c) => {
  if (!originAllowed(c)) return openAiError(new OpenAiError(403, 'Origin not allowed', 'permission_error', 'origin_not_allowed'))
  return new Response(null, { status: 204, headers: corsHeaders(c) })
})

gatewayRoutes.get('/v1/models', async (c) => {
  try {
    await authenticate(c)
    return openAiJson({ object: 'list', data: listGatewayModels() }, 200, corsHeaders(c))
  } catch (error) {
    return openAiError(error, corsHeaders(c))
  }
})

gatewayRoutes.post('/v1/chat/completions', (c) => handle(c, 'chat'))
gatewayRoutes.post('/v1/responses', (c) => handle(c, 'responses'))
