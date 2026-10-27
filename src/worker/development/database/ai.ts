import { z } from 'zod'
import { normalizeAssistantSettings, type AssistantSettings } from '@shared/assistant'
import { DATABASE_AI_SYSTEM_PROMPT, DATABASE_AGENT_SYSTEM_PROMPT } from '@shared/development/database/prompt'
import { DATABASE_TOOL_DEFS } from '@shared/development/database/tools'
import { isWriteSql } from '@shared/development/database/sql-utils'
import type { AssistantModel } from '@shared/assistant'
import type { Env } from '../../env'
import { AssistantStore, type ProviderRow } from '../../assistant/store'
import { loadModelAndProvider, modelEndpoint, type ResolvedModel } from '../../assistant/model-config'
import { AbortError, streamUpstream, type ModelTurn, type ToolCallRecord, type ToolSchema } from '../../assistant/upstream'
import { executeDatabaseTool } from './executor'

export type DatabaseStreamEvent =
  | { type: 'start'; model?: string }
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
  | { type: 'tool_results'; results: Array<{ id: string; name: string; content: string; isError?: boolean }> }
  | { type: 'done'; aborted?: boolean }
  | { type: 'error'; code: string; message: string }

export const AGENT_WRITE_REFUSAL =
  'Writes are off for this conversation. Ask the reader to turn on the write switch in the Agent panel, or run the statement from the query editor.'

export function isAgentWrite(name: string, args: Record<string, unknown>): boolean {
  return name === 'run_query' && isWriteSql(String(args.sql ?? ''))
}

export interface ResolvedDatabaseAi {  store: AssistantStore
  settings: AssistantSettings
  model: AssistantModel
  provider: ProviderRow
}

async function resolveAi(env: Env, userId: string): Promise<ResolvedDatabaseAi | null> {
  const store = new AssistantStore(env.DB, userId, env)
  const settings = normalizeAssistantSettings(await store.getSettings())
  const resolved: ResolvedModel = await loadModelAndProvider(store, settings, null)
  if (!resolved.model || !resolved.provider) return null
  return { store, settings, model: resolved.model, provider: resolved.provider }
}

export async function databaseAiStatus(env: Env, userId: string): Promise<{ configured: boolean; modelLabel?: string }> {
  const resolved = await resolveAi(env, userId)
  return resolved ? { configured: true, modelLabel: resolved.model.label || resolved.model.model } : { configured: false }
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`
}

function errorCode(error: unknown): { code: string; message: string } {
  if (error instanceof AbortError) return { code: 'aborted', message: 'The request was cancelled.' }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'upstream', message }
}

function toolSchemas(): ToolSchema[] {
  return DATABASE_TOOL_DEFS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: z.toJSONSchema(definition.schema) as Record<string, unknown>,
  }))
}

async function signKey(ai: ResolvedDatabaseAi): Promise<string> {
  const picked = await ai.store.pickProviderKey(ai.provider)
  if (!picked) return ''
  await ai.store.markProviderKeyUsed(ai.provider.id, picked.keyId)
  return picked.key
}

function keyRef(ai: ResolvedDatabaseAi) {
  return { providerId: ai.provider.id, providerLabel: ai.provider.label }
}

function userMessage(input: { mode: 'generate' | 'explain' | 'optimize'; prompt?: string; currentSql?: string; schemaText?: string }): string {
  if (input.mode === 'generate') {
    return `${input.prompt ?? ''}${input.schemaText ? `\n\nSchema:\n${input.schemaText}` : ''}`
  }
  if (input.mode === 'explain') {
    return `Explain this SQLite SQL step by step:\n\n${input.currentSql ?? ''}`
  }
  return `Analyze this SQLite SQL and return the full optimized SQL only:\n\n${input.currentSql ?? ''}`
}

export async function* streamDatabaseAi(
  env: Env,
  userId: string,
  input: { mode: 'generate' | 'explain' | 'optimize'; prompt?: string; currentSql?: string; schemaText?: string },
  signal: AbortSignal,
): AsyncGenerator<string> {
  let ai: ResolvedDatabaseAi | null
  try {
    ai = await resolveAi(env, userId)
  } catch (error) {
    const failure = errorCode(error)
    yield sse('error', failure)
    return
  }
  if (!ai) {
    yield sse('error', { code: 'no_model', message: 'No assistant model is configured.' })
    return
  }
  if (!(await ai.store.reserveRequests(1, ai.settings.limits.maxRequestsPerDay, ai.model.label, keyRef(ai)))) {
    yield sse('error', { code: 'quota', message: 'The daily assistant request limit was reached.' })
    return
  }
  const call = modelEndpoint(ai.model, ai.provider)
  const usage = { inputTokens: 0, outputTokens: 0 }
  try {
    const apiKey = await signKey(ai)
    if (!apiKey) throw new Error('The assistant provider has no usable API key.')
    yield sse('start', { model: ai.model.label || ai.model.model })
    for await (const event of streamUpstream(call.protocol, {
      baseUrl: call.baseUrl,
      apiKey,
      model: ai.model.model,
      system: DATABASE_AI_SYSTEM_PROMPT,
      turns: [{ role: 'user', content: userMessage(input) }],
      tools: [],
      maxOutputTokens: Math.min(2_048, ai.model.maxOutputTokens ?? 2_048),
      temperature: 0.2,
      reasoning: 'off',
      reasoningDialect: call.reasoningDialect,
      signal,
    })) {
      if (event.type === 'text') yield sse('delta', { content: event.delta })
      else if (event.type === 'reasoning') yield sse('reasoning', { content: event.delta })
      else if (event.type === 'usage') {
        usage.inputTokens = Math.max(usage.inputTokens, event.inputTokens)
        usage.outputTokens = Math.max(usage.outputTokens, event.outputTokens)
      }
    }
    await ai.store.incrementUsage(usage, undefined, ai.model.label, keyRef(ai))
    yield sse('done', {})
  } catch (error) {
    const failure = errorCode(error)
    await ai.store.incrementUsage({ errors: 1 }, undefined, ai.model.label, keyRef(ai))
    yield sse('error', failure)
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function* streamDatabaseAgent(
  env: Env,
  userId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal: AbortSignal,
  allowWrites = false,
): AsyncGenerator<string> {
  let ai: ResolvedDatabaseAi | null
  try {
    ai = await resolveAi(env, userId)
  } catch (error) {
    const failure = errorCode(error)
    yield sse('error', failure)
    return
  }
  if (!ai) {
    yield sse('error', { code: 'no_model', message: 'No assistant model is configured.' })
    return
  }
  const call = modelEndpoint(ai.model, ai.provider)
  const turns: ModelTurn[] = messages.map((message) => ({ role: message.role, content: message.content }))
  const tools = toolSchemas()
  const totalUsage = { inputTokens: 0, outputTokens: 0 }
  let toolCalls = 0
  const maxSteps = Math.min(8, ai.settings.limits.maxAgentSteps)
  yield sse('start', { model: ai.model.label || ai.model.model })

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        yield sse('done', { aborted: true })
        return
      }
      if (!(await ai.store.reserveRequests(1, ai.settings.limits.maxRequestsPerDay, ai.model.label, keyRef(ai)))) {
        yield sse('error', { code: 'quota', message: 'The daily assistant request limit was reached.' })
        return
      }
      const apiKey = await signKey(ai)
      if (!apiKey) throw new Error('The assistant provider has no usable API key.')

      let text = ''
      const calls: ToolCallRecord[] = []
      const stepUsage = { inputTokens: 0, outputTokens: 0 }
      for await (const event of streamUpstream(call.protocol, {
        baseUrl: call.baseUrl,
        apiKey,
        model: ai.model.model,
        system: DATABASE_AGENT_SYSTEM_PROMPT,
        turns,
        tools,
        maxOutputTokens: Math.min(2_048, ai.model.maxOutputTokens ?? 2_048),
        temperature: 0.2,
        reasoning: 'auto',
        reasoningDialect: call.reasoningDialect,
        signal,
      })) {
        if (event.type === 'text') {
          text += event.delta
          yield sse('delta', { content: event.delta })
        } else if (event.type === 'reasoning') {
          yield sse('reasoning', { content: event.delta })
        } else if (event.type === 'tool-call') {
          calls.push({ id: event.id, name: event.name, args: event.args, result: '', error: false })
          toolCalls++
        } else if (event.type === 'usage') {
          stepUsage.inputTokens = Math.max(stepUsage.inputTokens, event.inputTokens)
          stepUsage.outputTokens = Math.max(stepUsage.outputTokens, event.outputTokens)
        }
      }
      totalUsage.inputTokens += stepUsage.inputTokens
      totalUsage.outputTokens += stepUsage.outputTokens
      if (calls.length === 0) break

      yield sse('tool_calls', {
        calls: calls.map((entry) => ({ id: entry.id, name: entry.name, arguments: parseArguments(entry.args) })),
      })
      const results: Array<{ id: string; name: string; content: string; isError?: boolean }> = []
      for (const entry of calls) {
        const args = parseArguments(entry.args)
        if (!allowWrites && isAgentWrite(entry.name, args)) {
          entry.error = true
          entry.result = AGENT_WRITE_REFUSAL
          results.push({ id: entry.id, name: entry.name, content: AGENT_WRITE_REFUSAL, isError: true })
          continue
        }
        try {
          const value = await executeDatabaseTool(env, userId, entry.name, args)
          const content = typeof value === 'string' ? value : JSON.stringify(value)
          entry.result = content
          results.push({ id: entry.id, name: entry.name, content })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          entry.error = true
          entry.result = message
          results.push({ id: entry.id, name: entry.name, content: message, isError: true })
        }
      }
      yield sse('tool_results', { results })
      turns.push({ role: 'assistant', content: text, calls })
      if (toolCalls >= ai.settings.limits.maxToolCalls) {
        yield sse('done', {})
        await ai.store.incrementUsage(totalUsage, undefined, ai.model.label, keyRef(ai))
        return
      }
    }
    await ai.store.incrementUsage(totalUsage, undefined, ai.model.label, keyRef(ai))
    yield sse('done', {})
  } catch (error) {
    const failure = errorCode(error)
    await ai.store.incrementUsage({ errors: 1 }, undefined, ai.model.label, keyRef(ai))
    yield sse('error', failure)
  }
}

export function streamResponse(stream: AsyncIterable<string>): Response {
  const encoder = new TextEncoder()
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) controller.enqueue(encoder.encode(chunk))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        controller.enqueue(encoder.encode(sse('error', { code: 'internal', message })))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
