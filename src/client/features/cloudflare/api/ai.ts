/**
 * The Cloudflare AI contract between the app and `/api/cloudflare/v1`.
 *
 * The endpoints are OpenAI-shaped on purpose: they are a proxy to Cloudflare's own OpenAI-compatible
 * API, the reference module's screens already read that shape, and it is what a reader pasting a
 * request from another tool expects. Account selection travels in the body (`accountId`) rather than a
 * custom header, so the streaming path and the JSON path share one request shape.
 */
import { cfRequest, cfStream } from './client'

export interface AiModel {
  id: string
  task?: string
  speakers?: string[]
  default_speaker?: string
  advanced_params?: Record<string, unknown>
}

export interface AiUsageModel {
  modelId: string
  neurons: number
  requests: number
}

export interface AiUsageAccount {
  accountId: string
  accountName: string
  totalNeurons: number
  models: AiUsageModel[]
  warning?: string
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  model: string
  messages: AiChatMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
  accountId?: string
}

export interface AiChatCompletion {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string }
    delta?: { content?: string; reasoning_content?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

export interface AiImageRequest {
  model: string
  prompt: string
  accountId?: string
  image?: string
  strength?: number
  num_steps?: number
  width?: number
  height?: number
  guidance?: number
  negative_prompt?: string
}

export interface AiImageResponse {
  created?: number
  data: Array<{ b64_json: string; neurons?: number }>
}

export interface AiAudioRequest {
  model: string
  input: string
  voice?: string
  accountId?: string
  [key: string]: unknown
}

export interface AiAudioResponse {
  data: Array<{ audio: string; content_type?: string; neurons?: number }>
}

export interface AiTranslateRequest {
  model: string
  text: string
  source_lang?: string
  target_lang: string
  accountId?: string
}

export interface AiTranslateResponse {
  data: Array<{ translated_text: string; neurons?: number }>
}

export const aiApi = {
  models: (task: string, accountId?: string) =>
    cfRequest<{ object: 'list'; data: AiModel[] }>(
      `/v1/models?task=${encodeURIComponent(task)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`,
      { timeoutMs: 60_000 },
    ),
  usage: () => cfRequest<AiUsageAccount[]>('/ai/usage', { timeoutMs: 60_000 }),
  /** The caller owns the stream and must cancel the reader when it stops. */
  chatStream: (body: AiChatRequest, signal?: AbortSignal) => cfStream('/v1/chat/completions', body, signal),
  chat: (body: AiChatRequest) => cfRequest<AiChatCompletion>('/v1/chat/completions', { method: 'POST', body, timeoutMs: 300_000 }),
  image: (body: AiImageRequest) =>
    cfRequest<AiImageResponse>('/v1/images/generations', { method: 'POST', body, timeoutMs: 300_000 }),
  audio: (body: AiAudioRequest) =>
    cfRequest<AiAudioResponse>('/v1/audio/speech', { method: 'POST', body, timeoutMs: 300_000 }),
  translate: (body: AiTranslateRequest) =>
    cfRequest<AiTranslateResponse>('/v1/translations', { method: 'POST', body, timeoutMs: 120_000 }),
}

/** Parse one SSE chunk payload into the delta fields the chat screen shows. */
export function readChatDelta(payload: string): { content: string; reasoning: string; done: boolean } {
  if (payload.trim() === '[DONE]') return { content: '', reasoning: '', done: true }
  try {
    const parsed = JSON.parse(payload) as AiChatCompletion
    const choice = parsed.choices?.[0]
    return {
      content: choice?.delta?.content ?? '',
      reasoning: choice?.delta?.reasoning_content ?? '',
      done: choice?.finish_reason != null,
    }
  } catch {
    return { content: '', reasoning: '', done: false }
  }
}
