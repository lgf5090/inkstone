/**
 * Asking a vendor which models a key can call.
 *
 * The picker shows what the account actually has: nothing here is a bundled guess, and when the listing
 * fails the reader is told and can still type an id. The three protocols answer with three shapes and put
 * the useful name in three places, so the mapping is the part that has to be right.
 *
 * The address is built from the same endpoint helpers the chat calls use, so a base URL that works for
 * answering also works for listing, and it goes through the same guard: a key must never be sent to an
 * address inside the network or after a redirect.
 */
import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import { MAX_TOKEN_CEILING, type AssistantProtocol, type AssistantVendorModel } from '@shared/assistant'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'
import { anthropicEndpoint, openAiEndpoint } from './upstream'

/** A listing is a convenience, not a data migration: past this the picker is unusable anyway. */
export const MAX_VENDOR_MODELS = 500

export type VendorModel = AssistantVendorModel

export interface VendorListing {
  ok: boolean
  error: string | null
  models: VendorModel[]
}

const LIST_TIMEOUT_MS = 20_000

export function vendorModelsEndpoint(protocol: AssistantProtocol, baseUrl: string): string {
  if (protocol === 'anthropic') return anthropicEndpoint(baseUrl).replace(/\/messages$/, '/models')
  if (protocol === 'gemini') {
    // The same two suffixes `geminiEndpoint` strips, so a base copied from either address works here.
    const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1beta$/, '').replace(/\/models$/, '')
    return `${base}/v1beta/models`
  }
  return openAiEndpoint(baseUrl).replace(/\/chat\/completions$/, '/models')
}

export async function listVendorModels(protocol: AssistantProtocol, baseUrl: string, apiKey: string): Promise<VendorListing> {
  let url: URL
  try {
    url = assertRelayableEndpoint(vendorModelsEndpoint(protocol, baseUrl))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid provider address', models: [] }
  }
  // The key goes in a header and never in the query: a request line is what an access log, a proxy trace
  // and a browser history keep word for word, and this is the account's own provider key.
  const headers = protocol === 'anthropic'
    ? pickRelayHeaders({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' })
    : protocol === 'gemini'
      ? pickRelayHeaders({ 'x-goog-api-key': apiKey, accept: 'application/json' })
      : pickRelayHeaders({ authorization: apiKey ? `Bearer ${apiKey}` : '', accept: 'application/json' })
  let text = ''
  let status = 0
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: headers as Record<string, string>,
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    })
    status = response.status
    if (isRedirectResponse(response)) {
      return { ok: false, error: `The provider redirected (HTTP ${response.status}) instead of answering; redirects are refused.`, models: [] }
    }
    text = await response.text()
    // Only the status is told back: a vendor's error body is its own text, and it has carried keys and
    // internal addresses before, so it is never handed on to a browser as though it were an explanation.
    if (!response.ok) return { ok: false, error: `The provider answered HTTP ${status}.`, models: [] }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The provider could not be reached.', models: [] }
  }
  return { ok: true, error: null, models: parseVendorModels(protocol, text) }
}

function parseVendorModels(protocol: AssistantProtocol, text: string): VendorModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const models: VendorModel[] = []
  for (const entry of rows) {
    if (models.length >= MAX_VENDOR_MODELS) break
    const model = vendorModel(protocol, entry)
    if (model) models.push(model)
  }
  return models
}

function vendorModel(protocol: AssistantProtocol, entry: unknown): VendorModel | null {
  if (typeof entry !== 'object' || entry === null) return null
  const row = entry as Record<string, unknown>
  const raw = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : ''
  // Gemini answers with a resource name, and the part after the slash is the id the request needs.
  const id = (protocol === 'gemini' ? raw.replace(/^models\//, '') : raw).trim().slice(0, 200)
  if (!id) return null
  const label = text(row.display_name ?? row.displayName, 200) || id
  const created = typeof row.created === 'number' ? row.created : Date.parse(text(row.created_at, 40))
  const limits = listingLimits(protocol, row)
  return {
    id, label,
    ownedBy: text(row.owned_by ?? row.ownedBy, 120) || null,
    created: Number.isFinite(created) ? created : null,
    contextTokens: limits.contextTokens,
    maxOutputTokens: limits.maxOutputTokens,
  }
}

/**
 * The two numbers a listing row carries about a model, when it carries any.
 *
 * Gemini names them on the model resource itself. An OpenAI-shaped row from OpenAI carries none — the
 * vendor's `/v1/models` gives `id`, `created` and `owned_by` — but relays that do publish limits put
 * them on the row under one of the names below, `context_length` being what OpenRouter answers with.
 * Anthropic's `/v1/models` has no limits field at all, so its rows are asked nothing.
 *
 * Everything this cannot find reads as null, which means "the vendor did not say" and not "no ceiling".
 */
function listingLimits(protocol: AssistantProtocol, row: Record<string, unknown>): { contextTokens: number | null, maxOutputTokens: number | null } {
  if (protocol === 'gemini') {
    return { contextTokens: tokenField(row.inputTokenLimit), maxOutputTokens: tokenField(row.outputTokenLimit) }
  }
  if (protocol !== 'openai') return { contextTokens: null, maxOutputTokens: null }
  return {
    contextTokens: tokenField(row.context_length ?? row.context_window),
    maxOutputTokens: tokenField(row.max_output_tokens ?? row.max_completion_tokens),
  }
}

/** A count the listing gave as a usable token number, clamped to the one this app can store. */
function tokenField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.trunc(value), MAX_TOKEN_CEILING)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
