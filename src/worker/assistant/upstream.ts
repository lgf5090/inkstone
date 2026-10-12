/**
 * Talking to a model provider.
 *
 * Three wire protocols cover the services a reader can bring a key for: the OpenAI chat-completions
 * shape (which DeepSeek, Kimi, Qwen, OpenRouter, vLLM, Ollama and a hundred others imitate), Anthropic's
 * messages API, and Google's Gemini. Each is a streaming, tool-calling endpoint, and each fragments a
 * tool call's arguments across events, so the accumulation below is the part that has to be right — a
 * dropped `arguments` chunk is a tool that silently receives `{}`.
 *
 * The key is put on the request here and nowhere else: no route echoes it, and the browser never holds
 * it. Every address is vetted by the same guard the existing AI relay uses, and redirects are refused,
 * or a reader-supplied base URL would hand the worker an address it never checked.
 */

import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import type { AssistantProtocol } from '@shared/assistant'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

export interface ToolSchema {
  name: string
  description: string
  /** A JSON Schema object, built by `toolSchemaFor` from the tool's own declared parameters. */
  parameters: Record<string, unknown>
}

export interface ToolCallRecord {
  id: string
  name: string
  args: unknown
  result: string
  error: boolean
}

/** One turn of history as the providers need it: text, plus the calls an assistant turn made. */
export interface ModelTurn {
  role: 'user' | 'assistant'
  content: string
  calls?: ToolCallRecord[]
}

export type UpstreamEvent
  = | { type: 'text', delta: string }
    | { type: 'reasoning', delta: string }
    | { type: 'tool-call', id: string, name: string, args: unknown }
    | { type: 'usage', inputTokens: number, outputTokens: number }

export interface UpstreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  turns: ModelTurn[]
  tools: ToolSchema[]
  maxOutputTokens: number
  temperature: number
  signal: AbortSignal
}

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate' | 'quota' | 'unreachable' | 'unsupported' | 'bad-request' | 'timeout',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/** A stream that stalls must not hold the request open forever. */
const FIRST_CHUNK_TIMEOUT_MS = 60_000
const IDLE_CHUNK_TIMEOUT_MS = 90_000

export async function* streamUpstream(
  protocol: AssistantProtocol,
  request: UpstreamRequest,
): AsyncGenerator<UpstreamEvent> {
  switch (protocol) {
    case 'anthropic':
      return yield* streamAnthropic(request)
    case 'gemini':
      return yield* streamGemini(request)
    default:
      return yield* streamOpenAi(request)
  }
}

// --------------------------------------------------------------------- fetch

interface PreparedRequest {
  url: string
  init: RequestInit
}

async function postStream(prepared: PreparedRequest, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const detach = () => signal.removeEventListener('abort', onAbort)
  let response: Response
  try {
    response = await fetch(prepared.url, { ...prepared.init, signal: controller.signal })
  } catch (error) {
    detach()
    if (signal.aborted) throw new AbortError()
    throw new UpstreamError('unreachable', error instanceof Error ? error.message : 'The provider could not be reached')
  }
  if (isRedirectResponse(response)) {
    detach()
    throw new UpstreamError('unreachable', 'The provider answered with a redirect, which the assistant refuses to follow')
  }
  if (!response.ok) {
    const failure = await describeFailure(response)
    detach()
    throw failure
  }
  if (!response.body) {
    detach()
    throw new UpstreamError('unreachable', 'The provider returned an empty response body')
  }
  // The listener stays attached for the life of the body: a reader who closes the tab has to stop the
  // download, not merely the request that started it. Detaching after the headers arrived would leave
  // the model writing into a stream nobody reads until the idle timer gave up.
  return response
}

/** A name the runner can branch on without reading a message string. */
export class AbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortError'
  }
}

async function describeFailure(response: Response): Promise<UpstreamError> {
  const text = (await response.text().catch(() => '')).slice(0, 600)
  const lower = text.toLowerCase()
  if (response.status === 401 || response.status === 403) {
    return new UpstreamError('auth', 'The provider rejected the API key.', response.status)
  }
  if (response.status === 429) {
    const quota = /quota|exhausted|insufficient|billing|balance/.test(lower)
    return new UpstreamError(quota ? 'quota' : 'rate', quota
      ? 'The provider reports the account is out of quota.'
      : 'The provider is rate-limiting this account. Try again shortly.', response.status)
  }
  if (response.status === 404 || /model|not found|unsupported/.test(lower)) {
    return new UpstreamError('unsupported', `The provider does not know that model (${response.status}).`, response.status)
  }
  if (response.status >= 500) {
    return new UpstreamError('unreachable', `The provider is unavailable (${response.status}).`, response.status)
  }
  return new UpstreamError('bad-request', `The provider rejected the request (${response.status}).`, response.status)
}

/**
 * Reads a server-sent-events body, yielding each frame's `data:` payload.
 *
 * Frames are split on the blank line rather than per line, because a JSON payload may itself contain a
 * newline inside a string; and an idle stream is cancelled, so a provider that stops answering cannot
 * hold a reader's conversation open.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  /** Overridable so a stalled-stream test does not have to sit on the real minute-long timer. */
  timeouts: { first?: number, idle?: number } = {},
): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const firstMs = timeouts.first ?? FIRST_CHUNK_TIMEOUT_MS
  const idleMs = timeouts.idle ?? IDLE_CHUNK_TIMEOUT_MS
  let buffer = ''
  let idle: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const arm = (ms: number) => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      timedOut = true
      void reader.cancel().catch(() => {})
    }, ms)
  }
  try {
    arm(firstMs)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        // A cancel from the idle timer arrives as an ordinary end of stream. Reported as one, a
        // provider that went silent would save a half answer as if it were the whole answer.
        if (timedOut) throw new UpstreamError('timeout', 'The provider stopped answering before the end.')
        break
      }
      arm(idleMs)
      // Some gateways frame their events with CRLF; a blank line is a blank line either way, and a
      // carriage return surviving into a `data:` payload would only break the JSON parse after it.
      // The whole buffer is normalised because a CRLF pair can be split across two chunks.
      buffer = (buffer + value).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data && data !== '[DONE]') yield data
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.name === 'AbortError') throw new AbortError()
    throw error
  } finally {
    if (idle) clearTimeout(idle)
    try {
      reader.releaseLock()
    } catch {
      /* the stream was already released by the cancel above */
    }
  }
}

function vettedUrl(endpoint: string): URL {
  try {
    return assertRelayableEndpoint(endpoint)
  } catch (error) {
    throw new UpstreamError('bad-request', error instanceof Error ? error.message : 'Invalid provider address')
  }
}

function jsonHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...extra,
  }
  // Only the allowlisted names survive, so a caller cannot smuggle a cookie or an origin header upstream.
  return pickRelayHeaders({ ...headers, authorization: apiKey ? `Bearer ${apiKey}` : '' }) as Record<string, string>
}

// -------------------------------------------------------------------- OpenAI

function openAiBody(request: UpstreamRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: request.system }]
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content })
      continue
    }
    const calls = turn.calls ?? []
    if (!calls.length) {
      messages.push({ role: 'assistant', content: turn.content })
      continue
    }
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    })
    for (const call of calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: call.result })
    }
  }
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
  }
}

async function* streamOpenAi(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(openAiEndpoint(request.baseUrl))
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: jsonHeaders(request.apiKey),
      body: JSON.stringify(openAiBody(request)),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  const pending = new Map<number, { id: string, name: string, args: string }>()
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const usage = parsed.usage as Record<string, unknown> | undefined
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: numberOr(usage.prompt_tokens) ?? 0,
        outputTokens: numberOr(usage.completion_tokens) ?? 0,
      }
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
    if (!choice) continue
    const delta = (choice.delta ?? {}) as Record<string, unknown>
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content }
    // DeepSeek-R1 and friends stream their chain of thought on a separate field.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', delta: delta.reasoning_content as string }
    }
    const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : []
    for (const call of calls) {
      const slot = numberOr(call.index) ?? 0
      const fn = (call.function ?? {}) as Record<string, unknown>
      const entry = pending.get(slot) ?? { id: '', name: '', args: '' }
      if (typeof call.id === 'string') entry.id = call.id
      if (typeof fn.name === 'string') entry.name += fn.name
      if (typeof fn.arguments === 'string') entry.args += fn.arguments
      pending.set(slot, entry)
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== 'tool_calls') {
      for (const entry of flush(pending)) yield entry
    }
  }
  for (const entry of flush(pending)) yield entry
}

function flush(pending: Map<number, { id: string, name: string, args: string }>): UpstreamEvent[] {
  const out: UpstreamEvent[] = []
  for (const [slot, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue
    out.push({ type: 'tool-call', id: entry.id || `${entry.name}-${slot}`, name: entry.name, args: parseArgs(entry.args) })
    pending.delete(slot)
  }
  return out
}

export function openAiEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) return base
  // A reader pastes a host, not a path ("https://api.openai.com"), and the OpenAI-compatible
  // services answer under /v1; a base that already carries a path is left exactly as written.
  const afterHost = base.replace(/^[a-z]+:\/\//i, '')
  return afterHost.includes('/') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    // A truncated argument object is reported as an empty call, which the executor rejects by name and
    // the model sees as a tool error — better than feeding it a half-parsed object.
    return {}
  }
}

// ---------------------------------------------------------------- Anthropic

async function* streamAnthropic(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(anthropicEndpoint(request.baseUrl))
  const blocks: Record<string, unknown>[] = []
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      blocks.push({ role: 'user', content: turn.content })
      continue
    }
    const calls = turn.calls ?? []
    const content: Record<string, unknown>[] = []
    if (turn.content) content.push({ type: 'text', text: turn.content })
    for (const call of calls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
    }
    if (!content.length) content.push({ type: 'text', text: ' ' })
    blocks.push({ role: 'assistant', content })
    const results = calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: call.result,
      ...(call.error ? { is_error: true } : {}),
    }))
    if (results.length) blocks.push({ role: 'user', content: results })
  }
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: anthropicHeaders(request.apiKey),
      body: JSON.stringify({
        model: request.model,
        system: request.system,
        messages: blocks,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        stream: true,
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
      }),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  interface OpenBlock { kind: string, id: string, name: string, json: string }
  const open = new Map<number, OpenBlock>()
  // Anthropic reports the prompt size once, at the start, and the answer size at the end; the two
  // arrive in different events and the reader's usage meter needs both.
  let inputTokens = 0
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const type = parsed.type
    if (type === 'message_start') {
      const message = (parsed.message ?? {}) as Record<string, unknown>
      const start = (message.usage ?? {}) as Record<string, unknown>
      inputTokens = numberOr(start.input_tokens) ?? 0
    } else if (type === 'content_block_start') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const block = (parsed.content_block ?? {}) as Record<string, unknown>
      open.set(index, {
        kind: String(block.type ?? ''),
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        json: '',
      })
    } else if (type === 'content_block_delta') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const delta = (parsed.delta ?? {}) as Record<string, unknown>
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        yield { type: 'text', delta: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        yield { type: 'reasoning', delta: delta.thinking }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = open.get(index)
        if (block) block.json += delta.partial_json
      }
    } else if (type === 'content_block_stop') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const block = open.get(index)
      open.delete(index)
      if (block?.kind === 'tool_use') {
        yield { type: 'tool-call', id: block.id || `${block.name}-${index}`, name: block.name, args: parseArgs(block.json) }
      }
    } else if (type === 'message_delta') {
      const usage = (parsed.usage ?? {}) as Record<string, unknown>
      const input = numberOr(usage.input_tokens) ?? inputTokens
      const output = numberOr(usage.output_tokens)
      if (input > 0 || output !== undefined) {
        yield { type: 'usage', inputTokens: input, outputTokens: output ?? 0 }
      }
    }
  }
}

export function anthropicEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/messages')) return base
  if (base.endsWith('/v1')) return `${base}/messages`
  return `${base}/v1/messages`
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  const merged = pickRelayHeaders({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }) as Record<string, string>
  if (!merged['x-api-key']) throw new UpstreamError('auth', 'This provider needs an API key before it can be used.')
  return merged
}

// ------------------------------------------------------------------- Gemini

async function* streamGemini(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(geminiEndpoint(request.baseUrl, request.model))
  const contents: Record<string, unknown>[] = []
  for (const turn of request.turns) {
    const parts: Record<string, unknown>[] = []
    if (turn.content) parts.push({ text: turn.content })
    for (const call of turn.calls ?? []) {
      parts.push({ functionCall: { name: call.name, args: (call.args as Record<string, unknown>) ?? {} } })
    }
    for (const call of turn.calls ?? []) {
      parts.push({ functionResponse: { name: call.name, response: { result: call.result } } })
    }
    if (!parts.length) parts.push({ text: ' ' })
    contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts })
  }
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: jsonHeaders(request.apiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents,
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
        },
        ...(request.tools.length
          ? {
              tools: [{
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              }],
            }
          : {}),
      }),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  let callIndex = 0
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const usage = (parsed.usageMetadata ?? parsed.usage_metadata) as Record<string, unknown> | undefined
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: numberOr(usage.promptTokenCount ?? usage.prompt_tokens) ?? 0,
        outputTokens: numberOr(usage.candidatesTokenCount ?? usage.candidates_tokens) ?? 0,
      }
    }
    const candidate = Array.isArray(parsed.candidates) ? (parsed.candidates[0] as Record<string, unknown>) : undefined
    const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? []) as Record<string, unknown>[]
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        yield part.thought === true ? { type: 'reasoning', delta: part.text } : { type: 'text', delta: part.text }
      }
      const call = part.functionCall as Record<string, unknown> | undefined
      if (call && typeof call.name === 'string') {
        callIndex++
        yield {
          type: 'tool-call',
          id: `${call.name}-${callIndex}`,
          name: call.name,
          args: (call.args as Record<string, unknown>) ?? {},
        }
      }
    }
  }
}

/**
 * Gemini puts the model in the path and the key in the query, so the address is assembled rather than
 * configured. `alt=sse` is what makes the response a stream of frames instead of one JSON array.
 */
export function geminiEndpoint(baseUrl: string, model: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const trimmed = base.replace(/\/v1beta$/, '').replace(/\/models$/, '')
  return `${trimmed}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}

// -------------------------------------------------------------------- shared

function parseFrame(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
