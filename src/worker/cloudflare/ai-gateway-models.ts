/**
 * The two OpenAI faces of the gateway: Chat Completions and Responses.
 *
 * Both are normalised to one canonical messages array before quota estimation and before the upstream
 * call. That is what makes "the same content" cost the same neurons in either format and keeps the
 * Responses path from quietly under-counting `instructions` or tool turns.
 */
import { ApiError } from '../lib/errors'
import { estimateNeurons } from './pricing'

export const GATEWAY_MODEL_ALIASES = {
  qwen3: '@cf/qwen/qwen3-30b-a3b-fp8',
  'glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
  'llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct-fp8',
} as const

export type GatewayModelAlias = keyof typeof GATEWAY_MODEL_ALIASES

const MODEL_BY_ID = Object.fromEntries(
  Object.entries(GATEWAY_MODEL_ALIASES).map(([alias, id]) => [id, alias]),
) as Record<string, GatewayModelAlias>

export interface GatewayModelInfo {
  id: GatewayModelAlias
  object: 'model'
  owned_by: 'workers-ai'
  worker_model: string
}

export function listGatewayModels(): GatewayModelInfo[] {
  return Object.entries(GATEWAY_MODEL_ALIASES).map(([alias, worker]) => ({
    id: alias as GatewayModelAlias,
    object: 'model',
    owned_by: 'workers-ai',
    worker_model: worker,
  }))
}

export function resolveGatewayModel(value: string): { alias: GatewayModelAlias; model: string } | null {
  const alias = (GATEWAY_MODEL_ALIASES as Record<string, string>)[value]
  if (alias) return { alias: value as GatewayModelAlias, model: alias }
  const idAlias = MODEL_BY_ID[value]
  if (idAlias) return { alias: idAlias, model: GATEWAY_MODEL_ALIASES[idAlias] }
  return null
}

export type GatewayFormat = 'chat' | 'responses'

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

export interface CanonicalRequest {
  format: GatewayFormat
  alias: GatewayModelAlias
  workerModel: string
  messages: CanonicalMessage[]
  tools?: unknown[]
  toolChoice?: unknown
  maxOutputTokens: number
  temperature?: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  stream: boolean
}

const MAX_MESSAGES = 200
const MAX_CONTENT_CHARS = 100_000
const MAX_TOOLS = 128
const MAX_OUTPUT_TOKENS = 32_768
const DEFAULT_OUTPUT_TOKENS = 4096

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requiredText(value: unknown, label: string, max = MAX_CONTENT_CHARS): string {
  if (typeof value !== 'string' || value.length === 0) throw ApiError.badRequest(`${label} is required`)
  if (value.length > max) throw ApiError.tooLarge(`${label} is too long`)
  return value
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw ApiError.badRequest(`${label} must be a number between ${min} and ${max}`)
  }
  return value
}

function contentText(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (value.length > MAX_CONTENT_CHARS) throw ApiError.tooLarge(`${label} is too long`)
    return value
  }
  if (!Array.isArray(value)) throw ApiError.badRequest(`${label} must be a string or a content array`)
  const parts: string[] = []
  for (const part of value) {
    const item = record(part)
    if (!item) throw ApiError.badRequest(`${label} has an invalid content part`)
    if (item.type !== 'text' && item.type !== 'input_text' && item.type !== 'output_text') {
      throw ApiError.badRequest(`${label} contains an unsupported content part: ${String(item.type)}`)
    }
    if (typeof item.text !== 'string') throw ApiError.badRequest(`${label} has a content part without text`)
    parts.push(item.text)
  }
  const text = parts.join('\n')
  if (text.length > MAX_CONTENT_CHARS) throw ApiError.tooLarge(`${label} is too long`)
  return text
}

function readToolCalls(value: unknown): CanonicalMessage['tool_calls'] {
  if (!Array.isArray(value)) throw ApiError.badRequest('tool_calls must be an array')
  return value.map((entry) => {
    const item = record(entry)
    if (!item) throw ApiError.badRequest('tool_calls has an invalid entry')
    const fn = record(item.function)
    if (!fn || typeof fn.name !== 'string' || !fn.name) throw ApiError.badRequest('A tool call needs a function name')
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
    return {
      id: typeof item.id === 'string' && item.id ? item.id : `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: fn.name, arguments: args },
    }
  })
}

function chatMessages(value: unknown): CanonicalMessage[] {
  if (!Array.isArray(value) || value.length === 0) throw ApiError.badRequest('messages must be a non-empty array')
  if (value.length > MAX_MESSAGES) throw ApiError.badRequest(`At most ${MAX_MESSAGES} messages are allowed`)
  return value.map((entry, index) => {
    const item = record(entry)
    if (!item) throw ApiError.badRequest(`messages[${index}] is not an object`)
    const role = item.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw ApiError.badRequest(`messages[${index}] has an unsupported role`)
    }
    if (role === 'tool') {
      const toolCallId = typeof item.tool_call_id === 'string' ? item.tool_call_id : ''
      if (!toolCallId) throw ApiError.badRequest(`messages[${index}] needs tool_call_id`)
      return { role, content: contentText(item.content, `messages[${index}].content`), tool_call_id: toolCallId }
    }
    if (role === 'assistant' && item.tool_calls !== undefined) {
      const calls = readToolCalls(item.tool_calls)
      const content = item.content === null || item.content === undefined
        ? null
        : contentText(item.content, `messages[${index}].content`)
      return { role, content, tool_calls: calls }
    }
    return { role, content: contentText(item.content, `messages[${index}].content`) }
  })
}

function responsesItems(input: unknown, instructions: unknown): CanonicalMessage[] {
  const messages: CanonicalMessage[] = []
  if (instructions !== undefined) {
    const text = requiredText(instructions, 'instructions')
    messages.push({ role: 'system', content: text })
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: requiredText(input, 'input') })
    return messages
  }
  if (!Array.isArray(input)) throw ApiError.badRequest('input must be a string or an items array')
  if (input.length > MAX_MESSAGES) throw ApiError.badRequest(`At most ${MAX_MESSAGES} input items are allowed`)
  for (const [index, entry] of input.entries()) {
    const item = record(entry)
    if (!item) throw ApiError.badRequest(`input[${index}] is not an object`)
    const type = item.type
    if (type === 'function_call') {
      const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${index}`
      const name = requiredText(item.name, `input[${index}].name`, 128)
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
      })
      continue
    }
    if (type === 'function_call_output') {
      const callId = requiredText(item.call_id, `input[${index}].call_id`, 128)
      messages.push({ role: 'tool', content: contentText(item.output, `input[${index}].output`), tool_call_id: callId })
      continue
    }
    if (type !== undefined && type !== 'message' && type !== 'input_text' && type !== 'output_text') {
      throw ApiError.badRequest(`input[${index}] has an unsupported type: ${String(type)}`)
    }
    const role = item.role ?? (type === 'input_text' || type === 'output_text' ? 'user' : undefined)
    if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
      throw ApiError.badRequest(`input[${index}] has an unsupported role`)
    }
    messages.push({
      role: role === 'developer' ? 'system' : role,
      content: contentText(item.content ?? item.text, `input[${index}].content`),
    })
  }
  if (messages.filter((message) => message.role !== 'system').length === 0) {
    throw ApiError.badRequest('input must contain at least one user, assistant or tool item')
  }
  return messages
}

function chatTools(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw ApiError.badRequest('tools must be a non-empty array')
  if (value.length > MAX_TOOLS) throw ApiError.badRequest(`At most ${MAX_TOOLS} tools are allowed`)
  for (const [index, entry] of value.entries()) {
    const item = record(entry)
    const fn = record(item?.function)
    if (!item || item.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name) {
      throw ApiError.badRequest(`tools[${index}] must be a function tool with a name`)
    }
  }
  return value
}

function responsesTools(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw ApiError.badRequest('tools must be a non-empty array')
  if (value.length > MAX_TOOLS) throw ApiError.badRequest(`At most ${MAX_TOOLS} tools are allowed`)
  return value.map((entry, index) => {
    const item = record(entry)
    if (!item || item.type !== 'function' || typeof item.name !== 'string' || !item.name) {
      throw ApiError.badRequest(`tools[${index}] must be a flat function tool with a name`)
    }
    return {
      type: 'function',
      function: {
        name: item.name,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.parameters !== undefined ? { parameters: item.parameters } : {}),
        ...(item.strict !== undefined ? { strict: item.strict } : {}),
      },
    }
  })
}

function commonNumbers(body: Record<string, unknown>): Pick<CanonicalRequest, 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty'> {
  return {
    temperature: optionalNumber(body.temperature, 'temperature', 0, 2),
    topP: optionalNumber(body.top_p, 'top_p', 0, 1),
    presencePenalty: optionalNumber(body.presence_penalty, 'presence_penalty', -2, 2),
    frequencyPenalty: optionalNumber(body.frequency_penalty, 'frequency_penalty', -2, 2),
  }
}

function resolveModel(value: unknown): { alias: GatewayModelAlias; model: string } {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest('model is required')
  const resolved = resolveGatewayModel(value.trim())
  if (!resolved) throw ApiError.badRequest(`Unknown model alias: ${value}`)
  return resolved
}

export function canonicalChatRequest(body: Record<string, unknown>): CanonicalRequest {
  if (body.n !== undefined && body.n !== 1) throw ApiError.badRequest('n other than 1 is not supported')
  if (body.logprobs !== undefined || body.top_logprobs !== undefined) throw ApiError.badRequest('logprobs is not supported')
  if (body.response_format !== undefined) throw ApiError.badRequest('response_format is not supported')
  if (body.audio !== undefined || body.modalities !== undefined) throw ApiError.badRequest('audio/modalities are not supported')
  const resolved = resolveModel(body.model)
  const messages = chatMessages(body.messages)
  const tools = chatTools(body.tools)
  const maxOutput = body.max_tokens !== undefined
    ? optionalNumber(body.max_tokens, 'max_tokens', 1, MAX_OUTPUT_TOKENS) ?? DEFAULT_OUTPUT_TOKENS
    : body.max_completion_tokens !== undefined
      ? optionalNumber(body.max_completion_tokens, 'max_completion_tokens', 1, MAX_OUTPUT_TOKENS) ?? DEFAULT_OUTPUT_TOKENS
      : DEFAULT_OUTPUT_TOKENS
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw ApiError.badRequest('stream must be a boolean')
  return {
    format: 'chat',
    alias: resolved.alias,
    workerModel: resolved.model,
    messages,
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
    maxOutputTokens: Math.round(maxOutput),
    ...commonNumbers(body),
    stream: body.stream === true,
  }
}

export function canonicalResponsesRequest(body: Record<string, unknown>): CanonicalRequest {
  for (const unsupported of ['previous_response_id', 'conversation', 'background', 'include']) {
    if (body[unsupported] !== undefined) throw ApiError.badRequest(`${unsupported} is not supported`)
  }
  if (body.store === true) throw ApiError.badRequest('store is not supported')
  const text = record(body.text)
  if (text?.format !== undefined) throw ApiError.badRequest('text.format is not supported')
  const resolved = resolveModel(body.model)
  const messages = responsesItems(body.input, body.instructions)
  const tools = responsesTools(body.tools)
  const maxOutput = body.max_output_tokens !== undefined
    ? optionalNumber(body.max_output_tokens, 'max_output_tokens', 1, MAX_OUTPUT_TOKENS) ?? DEFAULT_OUTPUT_TOKENS
    : DEFAULT_OUTPUT_TOKENS
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw ApiError.badRequest('stream must be a boolean')
  return {
    format: 'responses',
    alias: resolved.alias,
    workerModel: resolved.model,
    messages,
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
    maxOutputTokens: Math.round(maxOutput),
    ...commonNumbers(body),
    stream: body.stream === true,
  }
}

export function estimatePromptTokens(request: Pick<CanonicalRequest, 'messages' | 'tools'>): number {
  const raw = JSON.stringify({ messages: request.messages, tools: request.tools ?? null })
  return Math.max(1, Math.ceil(raw.length / 3))
}

export function reservationFor(request: Pick<CanonicalRequest, 'workerModel' | 'messages' | 'tools' | 'maxOutputTokens'>): number {
  const promptTokens = estimatePromptTokens(request)
  const estimated = estimateNeurons(request.workerModel, promptTokens, request.maxOutputTokens)
  return Math.max(50, Math.ceil(estimated * 1.10))
}
