// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppBindings } from '../src/worker/env'
import { gatewayRoutes } from '../src/worker/routes/gateway'
import {
  canonicalChatRequest,
  canonicalResponsesRequest,
  reservationFor,
} from '../src/worker/cloudflare/ai-gateway-models'
import { createGatewayKey } from '../src/worker/cloudflare/ai-gateway-keys'
import { readGatewayResponse, storeGatewayResponse } from '../src/worker/cloudflare/ai-gateway-responses'
import {
  gatewayDay,
  markAccountFailure,
  markAccountSelected,
  reconcileAccount,
  reserveNeurons,
  selectGatewayAccount,
  settleNeurons,
} from '../src/worker/cloudflare/ai-gateway-quota'
import {
  makeCloudflareBed,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

let bed: CloudflareTestBed
let app: Hono<AppBindings>

beforeEach(async () => {
  bed = await makeCloudflareBed()
  app = new Hono<AppBindings>()
  app.route('/api/gateway', gatewayRoutes)
})

describe('gateway quota gate', () => {
  it('never lets concurrent reservations pass the local threshold', async () => {
    const results = await Promise.all([
      reserveNeurons(bed.env, TEST_USER, 'account-a', 'qwen3', 20, 50),
      reserveNeurons(bed.env, TEST_USER, 'account-a', 'qwen3', 20, 50),
      reserveNeurons(bed.env, TEST_USER, 'account-a', 'qwen3', 20, 50),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(2)
    const row = await bed.env.DB.prepare(
      `SELECT reserved_neurons, actual_neurons, exhausted
         FROM ai_gateway_account_ledger
        WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
    ).bind(TEST_USER, 'account-a', gatewayDay()).first<{
      reserved_neurons: number
      actual_neurons: number
      exhausted: number
    }>()
    expect(Math.max(row?.reserved_neurons ?? 0, row?.actual_neurons ?? 0)).toBeLessThanOrEqual(50)
  })

  it('raises the gate when actual usage exceeds the reservation and never lowers it', async () => {
    expect((await reserveNeurons(bed.env, TEST_USER, 'account-b', 'qwen3', 10, 100)).ok).toBe(true)
    const settled = await settleNeurons(bed.env, TEST_USER, 'account-b', 'qwen3', 30, 100)
    expect(settled.effective).toBeGreaterThanOrEqual(30)
    const again = await reserveNeurons(bed.env, TEST_USER, 'account-b', 'qwen3', 80, 100)
    expect(again.ok).toBe(false)
    const row = await bed.env.DB.prepare(
      `SELECT MAX(reserved_neurons, actual_neurons) AS effective
         FROM ai_gateway_account_ledger
        WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
    ).bind(TEST_USER, 'account-b', gatewayDay()).first<{ effective: number }>()
    expect(row?.effective).toBeGreaterThanOrEqual(30)
  })

  it('accumulates settlements instead of letting the last request overwrite the total', async () => {
    expect((await reserveNeurons(bed.env, TEST_USER, 'account-c', 'qwen3', 10, 100)).ok).toBe(true)
    await settleNeurons(bed.env, TEST_USER, 'account-c', 'qwen3', 5, 100)
    await settleNeurons(bed.env, TEST_USER, 'account-c', 'qwen3', 7, 100)
    const row = await bed.env.DB.prepare(
      `SELECT actual_neurons, MAX(reserved_neurons, actual_neurons) AS effective
         FROM ai_gateway_account_ledger
        WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
    ).bind(TEST_USER, 'account-c', gatewayDay()).first<{ actual_neurons: number; effective: number }>()
    expect(row?.actual_neurons).toBe(12)
    expect(row?.effective).toBeGreaterThanOrEqual(12)
  })

  it('reconciles only upward and records an over-budget snapshot', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: 'c'.repeat(26), accountId: 'd'.repeat(32) })
    stubCloudflare(async (url) => {
      expect(url.pathname).toBe('/client/v4/graphql')
      return Response.json({
        data: { viewer: { accounts: [{ total: [{ sum: { totalNeurons: 120 } }], byModel: [] }] } },
      })
    })
    const result = await reconcileAccount(bed.env, TEST_USER, {
      id: account.id,
      user_id: TEST_USER,
      name: 'Test account',
      auth_type: 'token',
      email: null,
      cf_account_id: 'd'.repeat(32),
      is_active: 1,
      enabled_features: 'ai',
      available_features: '',
      has_credentials: 1,
      created_at: 0,
      updated_at: 0,
    }, {
      auth_type: 'token',
      api_token: 'test-token',
    } as never, 100)
    expect(result.outcome).toBe('over')
    const ledger = await bed.env.DB.prepare(
      `SELECT MAX(reserved_neurons, actual_neurons) AS effective, exhausted
         FROM ai_gateway_account_ledger
        WHERE user_id = ?1 AND account_id = ?2 AND day = ?3 AND model = '*'`,
    ).bind(TEST_USER, account.id, gatewayDay()).first<{ effective: number; exhausted: number }>()
    expect(ledger?.effective).toBe(120)
    expect(ledger?.exhausted).toBe(1)
  })
})

describe('gateway scheduler', () => {
  it('rotates between healthy accounts and skips cooling or auth-failed ones', async () => {
    await seedAccount(bed, TEST_USER, { id: 'g'.repeat(26), accountId: '1'.repeat(32) })
    await seedAccount(bed, TEST_USER, { id: 'h'.repeat(26), accountId: '2'.repeat(32) })

    const first = await selectGatewayAccount(bed.env, TEST_USER, new Set(), 10, 1_000)
    expect(first).not.toBeNull()
    await markAccountSelected(bed.env, TEST_USER, first!.account.row.id)
    const second = await selectGatewayAccount(bed.env, TEST_USER, new Set(), 10, 1_000)
    expect(second?.account.row.id).not.toBe(first?.account.row.id)

    await markAccountFailure(bed.env, TEST_USER, first!.account.row.id, 'cooling', 'upstream_429')
    const cooling = await selectGatewayAccount(bed.env, TEST_USER, new Set(), 10, 1_000)
    expect(cooling?.account.row.id).toBe(second?.account.row.id)

    await markAccountFailure(bed.env, TEST_USER, second!.account.row.id, 'auth_error', 'upstream_auth')
    expect(await selectGatewayAccount(bed.env, TEST_USER, new Set(), 10, 1_000)).toBeNull()
  })
})

describe('chat and responses normalisation', () => {
  it('gives the same reservation for the same text in both formats', () => {
    const chat = canonicalChatRequest({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] })
    const responses = canonicalResponsesRequest({ model: 'qwen3', input: 'hello' })
    expect(reservationFor(chat)).toBe(reservationFor(responses))
  })

  it('maps instructions, tool definitions and tool turns onto canonical messages', () => {
    const request = canonicalResponsesRequest({
      model: 'qwen3',
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
      max_output_tokens: 100,
    })
    expect(request.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(request.messages[1]).toMatchObject({ role: 'user', content: 'weather?' })
    expect(request.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] })
    expect(request.messages[3]).toMatchObject({ role: 'tool', content: 'sunny', tool_call_id: 'call_1' })
    expect(request.tools).toEqual([{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }])
  })

  it('rejects unsupported Responses context fields instead of silently ignoring them', () => {
    expect(() => canonicalResponsesRequest({ model: 'qwen3', input: 'hello', conversation: 'conv_1' }))
      .toThrow(/conversation/)
  })

  it('accepts the OpenAI fields the upstream endpooint supports and rejects impossible combinations', () => {
    const chat = canonicalChatRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hello' }],
      stop: ['END'],
      seed: 42,
      n: 2,
      parallel_tool_calls: false,
      logprobs: true,
      top_logprobs: 3,
      response_format: { type: 'json_object' },
      user: 'reader-1',
      metadata: { trace: 'abc' },
    })
    expect(chat.stop).toEqual(['END'])
    expect(chat.seed).toBe(42)
    expect(chat.n).toBe(2)
    expect(chat.parallelToolCalls).toBe(false)
    expect(chat.logprobs).toBe(true)
    expect(chat.topLogprobs).toBe(3)
    expect(chat.responseFormat).toEqual({ type: 'json_object' })
    expect(chat.user).toBe('reader-1')
    expect(chat.metadata).toEqual({ trace: 'abc' })
    expect(reservationFor(chat)).toBeGreaterThan(reservationFor({ ...chat, n: 1 }))
    expect(() => canonicalChatRequest({
      model: 'qwen3', messages: [{ role: 'user', content: 'hi' }], stream: true, response_format: { type: 'json_object' },
    })).toThrow(/streaming/)
    expect(() => canonicalChatRequest({
      model: 'qwen3', messages: [{ role: 'user', content: 'hi' }], top_logprobs: 3,
    })).toThrow(/logprobs/)
  })

  it('maps Responses text.format and keeps store/previous_response_id as context data', () => {
    const request = canonicalResponsesRequest({
      model: 'qwen3',
      input: 'hello',
      text: { format: { type: 'json_schema', name: 'Answer', schema: { type: 'object' }, strict: true } },
      store: false,
      previous_response_id: 'resp_1',
      truncation: 'disabled',
      parallel_tool_calls: false,
      metadata: { trace: 'abc' },
    })
    expect(request.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: { name: 'Answer', schema: { type: 'object' }, strict: true },
    })
    expect(request.store).toBe(false)
    expect(request.previousResponseId).toBe('resp_1')
    expect(request.truncation).toBe('disabled')
    expect(request.parallelToolCalls).toBe(false)
    expect(() => canonicalResponsesRequest({ model: 'qwen3', input: 'hello', truncation: 'auto' }))
      .toThrow(/truncation/)
    expect(() => canonicalResponsesRequest({ model: 'qwen3', input: 'hello', include: ['message.output_text.logprobs'] }))
      .toThrow(/include/)
  })
})

describe('public chat and responses data plane', () => {
  it('serves both formats through one account and one usage calculation', async () => {
    await seedAccount(bed, TEST_USER, { id: 'e'.repeat(26), accountId: 'f'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'test key' })
    stubCloudflare(async (url, init) => {
      expect(url.pathname).toBe(`/client/v4/accounts/${'f'.repeat(32)}/ai/v1/chat/completions`)
      const body = JSON.parse(init?.body as string) as { model: string; messages: unknown[] }
      expect(body.model).toBe('@cf/qwen/qwen3-30b-a3b-fp8')
      expect(body.messages).toHaveLength(1)
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    })
    const headers = { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }
    const chat = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] }),
    }, bed.env)
    expect(chat.status).toBe(200)
    expect(await chat.json()).toMatchObject({ model: 'qwen3', usage: { prompt_tokens: 10, completion_tokens: 5 } })

    const responses = await app.request('/api/gateway/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'qwen3', input: 'hello' }),
    }, bed.env)
    expect(responses.status).toBe(200)
    const body = await responses.json() as {
      object: string
      output: Array<{ type: string; content?: Array<{ text: string }> }>
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.object).toBe('response')
    expect(body.output[0]?.type).toBe('message')
    expect(body.output[0]?.content?.[0]?.text).toBe('hi there')
    expect(body.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 })

    const logs = await bed.env.DB.prepare(
      'SELECT format, model, status, actual_neurons FROM ai_gateway_requests ORDER BY created_at',
    ).all<{ format: string; model: string; status: string; actual_neurons: number }>()
    expect((logs.results ?? []).map((row) => row.format)).toEqual(['chat', 'responses'])
    expect((logs.results ?? []).every((row) => row.status === 'success')).toBe(true)
    expect((logs.results ?? []).every((row) => row.actual_neurons > 0)).toBe(true)
  })

  it('returns OpenAI-shaped errors for unknown keys and unsupported fields', async () => {
    const noKey = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] }),
    }, bed.env)
    expect(noKey.status).toBe(401)
    expect(await noKey.json()).toMatchObject({ error: { type: 'authentication_error', code: 'invalid_api_key' } })

    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'wrong model' })
    const unsupported = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }], audio: { voice: 'alloy', format: 'mp3' } }),
    }, bed.env)
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'bad_request' } })
  })

  it('passes the chat SSE through and settles from the final usage chunk', async () => {
    await seedAccount(bed, TEST_USER, { id: 'm'.repeat(26), accountId: '3'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'stream key' })
    stubCloudflare(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'llo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, neurons: 0.6 } })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    const response = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    }, bed.env)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"content":"he"')
    expect(text).toContain('"content":"llo"')
    expect(text).toContain('data: [DONE]')
    const log = await bed.env.DB.prepare(
      'SELECT stream, status, prompt_tokens, completion_tokens, actual_neurons FROM ai_gateway_requests',
    ).first<{ stream: number; status: string; prompt_tokens: number; completion_tokens: number; actual_neurons: number }>()
    expect(log).toMatchObject({ stream: 1, status: 'success', prompt_tokens: 10, completion_tokens: 5 })
    expect(log?.actual_neurons).toBe(1)
  })

  it('turns the upstream SSE into the Responses event sequence', async () => {
    await seedAccount(bed, TEST_USER, { id: 'j'.repeat(26), accountId: '4'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'responses stream key' })
    stubCloudflare(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'llo' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    const response = await app.request('/api/gateway/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', input: 'hello', stream: true }),
    }, bed.env)
    expect(response.status).toBe(200)
    const text = await response.text()
    const events = [...text.matchAll(/^event: ([a-z_.]+)$/gm)].map((match) => match[1])
    expect(events).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(text).toContain('"text":"hello"')
  })

  it('enforces the per-key daily request limit', async () => {
    await seedAccount(bed, TEST_USER, { id: 'k'.repeat(26), accountId: '5'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'limited key', dailyRequestLimit: 1 })
    stubCloudflare(async () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    const headers = { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }
    const body = JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] })
    const first = await app.request('/api/gateway/v1/chat/completions', { method: 'POST', headers, body }, bed.env)
    expect(first.status).toBe(200)
    const second = await app.request('/api/gateway/v1/chat/completions', { method: 'POST', headers, body }, bed.env)
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ error: { type: 'rate_limit_error', code: 'key_daily_limit' } })
  })

  it('forwards the supported OpenAI chat fields to the upstream endpoint', async () => {
    await seedAccount(bed, TEST_USER, { id: 'n'.repeat(26), accountId: '6'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'forward key' })
    let seen: Record<string, unknown> = {}
    stubCloudflare(async (_url, init) => {
      seen = JSON.parse(init?.body as string) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    })
    const response = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3',
        messages: [{ role: 'user', content: 'hello' }],
        stop: ['END'],
        seed: 42,
        n: 2,
        parallel_tool_calls: false,
        logprobs: true,
        top_logprobs: 3,
        response_format: { type: 'json_object' },
        user: 'reader-1',
        metadata: { trace: 'abc' },
      }),
    }, bed.env)
    expect(response.status).toBe(200)
    expect(seen).toMatchObject({
      stop: ['END'], seed: 42, n: 2, parallel_tool_calls: false,
      logprobs: true, top_logprobs: 3, response_format: { type: 'json_object' },
      user: 'reader-1', metadata: { trace: 'abc' },
    })
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  it('only emits the final usage chunk when stream_options.include_usage asks for it', async () => {
    await seedAccount(bed, TEST_USER, { id: 'p'.repeat(26), accountId: '7'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'usage key' })
    stubCloudflare(async () => sseResponse([
      `data: ${JSON.stringify({ id: 'id-1', created: 1, model: '@cf/qwen/qwen3-30b-a3b-fp8', choices: [{ delta: { content: 'ok' } }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'id-1', created: 1, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    const headers = { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }
    const body = JSON.stringify({
      model: 'qwen3', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true },
    })
    const withUsage = await app.request('/api/gateway/v1/chat/completions', { method: 'POST', headers, body }, bed.env)
    const text = await withUsage.text()
    expect(text).toContain('"choices":[]')
    expect(text).toContain('"prompt_tokens":10')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(text).toContain('"model":"qwen3"')

    const withoutUsage = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    }, bed.env)
    expect(await withoutUsage.text()).not.toContain('"usage"')
  })

  it('serves OpenAI-shaped model objects and a 404 error object for unknown routes', async () => {
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'models key' })
    const headers = { authorization: `Bearer ${created.token}` }
    const list = await app.request('/api/gateway/v1/models', { headers }, bed.env)
    expect(list.status).toBe(200)
    const body = await list.json() as { data: Array<{ id: string; object: string; created: number }> }
    expect(body.data[0]).toMatchObject({ object: 'model', created: 1_700_000_000 })
    expect(list.headers.get('x-request-id')).toBeTruthy()

    const one = await app.request('/api/gateway/v1/models/qwen3', { headers }, bed.env)
    expect(one.status).toBe(200)
    const missing = await app.request('/api/gateway/v1/models/nope', { headers }, bed.env)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'model_not_found', param: 'model' } })

    const unknown = await app.request('/api/gateway/v1/unknown', { method: 'POST', headers }, bed.env)
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as { error: { param: unknown } }).error).toHaveProperty('param')
  })

  it('sets Retry-After and the OpenAI error param on quota failures', async () => {
    const account = await seedAccount(bed, TEST_USER, { id: 'q'.repeat(26), accountId: '8'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'quota key' })
    await reserveNeurons(bed.env, TEST_USER, account.id, 'qwen3', 9_500, 9_500)
    const response = await app.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] }),
    }, bed.env)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
    expect(await response.json()).toMatchObject({
      error: { type: 'rate_limit_error', code: 'insufficient_quota', param: null },
    })
  })

  it('turns an upstream stream error into a response.failed event', async () => {
    await seedAccount(bed, TEST_USER, { id: 'r'.repeat(26), accountId: '9'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'failed key' })
    stubCloudflare(async () => sseResponse([
      `data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    const response = await app.request('/api/gateway/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', input: 'hello', stream: true }),
    }, bed.env)
    const text = await response.text()
    expect(text).toContain('event: response.failed')
    expect(text).not.toContain('event: response.completed')
  })
})

describe('Responses persistence', () => {
  async function setup() {
    const account = await seedAccount(bed, TEST_USER, { id: 's'.repeat(26), accountId: 'a'.repeat(32) })
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'store key' })
    const headers = { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' }
    return { account, created, headers }
  }

  it('stores a non-stream response, reads it back and deletes it', async () => {
    const { headers } = await setup()
    stubCloudflare(async () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    const created = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'qwen3', input: 'hello' }),
    }, bed.env)
    expect(created.status).toBe(200)
    const body = await created.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> }
    const stored = await bed.env.DB.prepare('SELECT id, output_text, expires_at FROM ai_gateway_responses WHERE id = ?1')
      .bind(body.id).first<{ id: string; output_text: string; expires_at: number }>()
    expect(stored?.output_text).toBe('hi there')
    expect(stored?.expires_at).toBeGreaterThan(Date.now())

    const read = await app.request(`/api/gateway/v1/responses/${body.id}`, { headers }, bed.env)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ object: 'response', id: body.id, output: body.output })

    const deleted = await app.request(`/api/gateway/v1/responses/${body.id}`, { method: 'DELETE', headers }, bed.env)
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ id: body.id, object: 'response.deleted', deleted: true })
    const missing = await app.request(`/api/gateway/v1/responses/${body.id}`, { headers }, bed.env)
    expect(missing.status).toBe(404)
  })

  it('chains previous_response_id into the next upstream request and reserves the full prompt', async () => {
    const { headers } = await setup()
    let calls = 0
    let secondMessages: unknown[] = []
    stubCloudflare(async (_url, init) => {
      calls += 1
      if (calls === 2) secondMessages = (JSON.parse(init?.body as string) as { messages: unknown[] }).messages
      return Response.json({
        choices: [{ message: { role: 'assistant', content: calls === 1 ? 'first answer' : 'second answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    })
    const first = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'qwen3', instructions: 'be brief', input: 'hello' }),
    }, bed.env)
    const firstBody = await first.json() as { id: string }
    const second = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'qwen3', previous_response_id: firstBody.id, input: 'again' }),
    }, bed.env)
    expect(second.status).toBe(200)
    expect(secondMessages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'again' },
    ])
    const missing = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'qwen3', previous_response_id: 'resp_missing', input: 'again' }),
    }, bed.env)
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: { code: 'previous_response_not_found', param: 'previous_response_id' } })
  })

  it('does not store when store is false, and rejects an oversized stored response', async () => {
    const { headers } = await setup()
    stubCloudflare(async () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    const skipped = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'qwen3', input: 'hello', store: false }),
    }, bed.env)
    expect(skipped.status).toBe(200)
    expect((await bed.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_gateway_responses').first<{ n: number }>())?.n).toBe(0)

    bed.env.AI_GATEWAY_RESPONSE_MAX_BYTES = '1024'
    stubCloudflare(async () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'x'.repeat(2000) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 500, total_tokens: 510 },
    }))
    const tooLarge = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'qwen3', input: 'hello' }),
    }, bed.env)
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'response_too_large_to_store' } })
  })

  it('stores a streaming response after response.completed', async () => {
    const { headers } = await setup()
    stubCloudflare(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ]))
    const response = await app.request('/api/gateway/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'qwen3', input: 'hello', stream: true }),
    }, bed.env)
    const text = await response.text()
    const id = /"id":"(resp_[^"]+)"/.exec(text)?.[1]
    expect(id).toBeTruthy()
    const stored = await bed.env.DB.prepare('SELECT output_text FROM ai_gateway_responses WHERE id = ?1')
      .bind(id).first<{ output_text: string }>()
    expect(stored?.output_text).toBe('hi there')
  })

  it('removes an expired stored response on read', async () => {
    await storeGatewayResponse(bed.env, {
      id: 'resp_expired',
      userId: TEST_USER,
      keyId: 'k',
      model: 'qwen3',
      canonicalMessages: [{ role: 'user', content: 'hello' }],
      outputItems: [],
      outputText: '',
      usage: {},
      now: Date.now() - 8 * 24 * 3600_000,
    })
    expect(await readGatewayResponse(bed.env, TEST_USER, 'resp_expired')).toBeNull()
    expect((await bed.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_gateway_responses').first<{ n: number }>())?.n).toBe(0)
  })
})

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
