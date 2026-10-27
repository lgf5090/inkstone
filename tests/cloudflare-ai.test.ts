// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAiModelSchemaCache } from '../src/worker/cloudflare/ai-models'
import { estimateNeurons } from '../src/worker/cloudflare/pricing'
import { setQuota } from '../src/worker/cloudflare/quota'
import {
  cfJson,
  makeCloudflareBed,
  readJson,
  seedAccount,
  stubCloudflare,
  TEST_USER,
} from './cloudflare-fixtures'

const mocks = vi.hoisted(() => ({ userId: 'u'.repeat(26) }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

beforeEach(() => clearAiModelSchemaCache())
afterEach(() => vi.unstubAllGlobals())

const CF_ACCOUNT = 'b'.repeat(32)
const SECOND_CF_ACCOUNT = 'd'.repeat(32)
const LLAMA = '@cf/meta/llama-3.1-8b-instruct'
const MELOTTS = '@cf/myshell/melotts'
const AURA = '@cf/deepgram/aura-2-en'

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function testExecutionContext(): { context: ExecutionContext; settle: () => Promise<void> } {
  const tasks: Promise<unknown>[] = []
  return {
    context: {
      waitUntil: (task: Promise<unknown>) => { tasks.push(task) },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    settle: async () => { await Promise.all(tasks.splice(0)) },
  }
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

async function quotaCount(
  bed: Awaited<ReturnType<typeof makeCloudflareBed>>,
  accountId: string,
): Promise<{ count: number; exhausted: number } | null> {
  return await bed.env.DB.prepare(
    `SELECT count, exhausted FROM cloudflare_quota_usage
      WHERE user_id = ? AND account_id = ? AND resource = 'ai_neurons'
        AND date = ?`,
  )
    .bind(TEST_USER, accountId, new Date().toISOString().slice(0, 10))
    .first<{ count: number; exhausted: number }>()
}

describe('the AI usage route', () => {
  it('falls back to the locally counted neurons with a warning', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    await setQuota(bed.env, TEST_USER, id, 'ai_neurons', 42)
    stubCloudflare((url) => {
      expect(url.pathname).toBe('/client/v4/graphql')
      return new Response('analytics unavailable', { status: 500 })
    })

    const response = await bed.app.request('/api/cloudflare/ai/usage', {}, bed.env)
    expect(response.status).toBe(200)
    const body = await readJson<Array<{
      accountId: string
      accountName: string
      totalNeurons: number
      models: unknown[]
      warning?: string
    }>>(response)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      accountId: CF_ACCOUNT,
      accountName: 'Test account',
      totalNeurons: 42,
      models: [],
    })
    expect(body[0]?.warning).toBeTruthy()
  })

  it('writes Cloudflare’s authoritative number back into the local counter', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubCloudflare((url) => {
      expect(url.pathname).toBe('/client/v4/graphql')
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              total: [{ sum: { totalNeurons: 123.4 } }],
              byModel: [{
                count: 3,
                sum: { totalNeurons: 123.4 },
                dimensions: { modelId: LLAMA },
              }],
            }],
          },
        },
      })
    })

    const response = await bed.app.request('/api/cloudflare/ai/usage', {}, bed.env)
    expect(response.status).toBe(200)
    const body = await readJson<Array<{
      totalNeurons: number
      models: Array<{ modelId: string; neurons: number; requests: number }>
      warning?: string
    }>>(response)
    expect(body[0]?.totalNeurons).toBe(123.4)
    expect(body[0]?.models).toEqual([{ modelId: LLAMA, neurons: 123.4, requests: 3 }])
    expect(body[0]?.warning).toBeUndefined()
    // The ledger keeps the fraction Cloudflare reports: a rounded allowance beside an unrounded model
    // row is what made a single model read as 104.7% of itself.
    expect((await quotaCount(bed, id))?.count).toBe(123.4)
  })
})

describe('the models route', () => {
  it('filters by task and adds speakers and advanced parameters for speech models', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubCloudflare((url) => {
      if (url.pathname.endsWith('/ai/models/search')) {
        return cfJson([
          { name: LLAMA, task: { name: 'Text Generation' } },
          { name: MELOTTS, task: { name: 'Text to Speech' } },
        ])
      }
      if (url.pathname.endsWith('/ai/models/schema')) {
        expect(url.searchParams.get('model')).toBe(MELOTTS)
        return cfJson({
          input: {
            properties: {
              prompt: { type: 'string' },
              speaker: { type: 'string', enum: ['luna', 'mars'], default: 'luna' },
              encoding: { type: 'string', enum: ['mp3', 'wav'] },
            },
            required: ['prompt'],
          },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const response = await bed.app.request(
      `/api/cloudflare/v1/models?task=text-to-speech&accountId=${id}`,
      {},
      bed.env,
    )
    expect(response.status).toBe(200)
    const body = await readJson<{
      object: string
      data: Array<{
        id: string
        task?: string
        speakers?: string[]
        default_speaker?: string
        advanced_params?: Record<string, unknown>
      }>
    }>(response)
    expect(body.object).toBe('list')
    expect(body.data).toEqual([{
      id: MELOTTS,
      task: 'Text to Speech',
      speakers: ['luna', 'mars'],
      default_speaker: 'luna',
      advanced_params: { encoding: { type: 'string', enum: ['mp3', 'wav'] } },
    }])
  })

  it('refuses another reader’s explicit account', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, 'o'.repeat(26))
    const response = await bed.app.request(
      `/api/cloudflare/v1/models?task=text-to-speech&accountId=${id}`,
      {},
      bed.env,
    )
    expect(response.status).toBe(404)
  })
})

describe('the chat completions route', () => {
  it('normalizes a non-stream completion and charges the estimated neurons', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    let upstreamBody: Record<string, unknown> | null = null
    stubCloudflare(async (url, init) => {
      expect(url.pathname).toBe(`/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`)
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { content: 'Hello' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      })
    })

    const response = await bed.app.request('/api/cloudflare/v1/chat/completions', jsonRequest({
      model: LLAMA,
      messages: [{ role: 'user', content: 'hi' }],
      accountId: id,
    }), bed.env)

    expect(response.status).toBe(200)
    const body = await readJson<{
      id: string
      object: string
      model: string
      usage: { prompt_tokens: number; completion_tokens: number }
    }>(response)
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe(LLAMA)
    expect(body.id).toMatch(/^chatcmpl-/)
    const sent = upstreamBody as Record<string, unknown> | null
    expect(sent).not.toBeNull()
    expect(sent).not.toHaveProperty('accountId')
    expect(sent?.max_tokens).toBe(4096)
    const expected = estimateNeurons(LLAMA, 1000, 500, 0)
    expect((await quotaCount(bed, id))?.count).toBe(expected)
    const audit = await bed.env.DB.prepare(
      'SELECT action, target FROM cloudflare_log WHERE user_id = ?',
    ).bind(TEST_USER).first<{ action: string; target: string }>()
    expect(audit).toEqual({ action: 'ai_chat_completion', target: LLAMA })
  })

  it('passes a stream through and appends the terminating event', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubCloudflare(() => sseResponse([
      'data: {"id":"x","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}\n\n',
    ]))

    const { context, settle } = testExecutionContext()
    const response = await bed.app.request('/api/cloudflare/v1/chat/completions', jsonRequest({
      model: LLAMA,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      accountId: id,
    }), bed.env, context)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    const text = await response.text()
    await settle()
    expect(text).toContain('data: {"id":"x"')
    expect(text).toContain('"content":"Hi"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
    expect((await quotaCount(bed, id))?.count).toBe(estimateNeurons(LLAMA, 1000, 500, 0))
  })

  it('rotates to the next account on a 4006 refusal and marks the first exhausted', async () => {
    const bed = await makeCloudflareBed()
    const first = await seedAccount(bed, TEST_USER)
    const second = await seedAccount(bed, TEST_USER, {
      id: 'c'.repeat(26),
      name: 'Second account',
      accountId: SECOND_CF_ACCOUNT,
    })
    stubCloudflare((url) => {
      if (url.pathname.includes(SECOND_CF_ACCOUNT)) {
        return Response.json({
          choices: [{ message: { content: 'from second' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      }
      return new Response(JSON.stringify({
        success: false,
        errors: [{ code: 4006, message: 'daily free allocation limit exceeded' }],
      }), { status: 429, headers: { 'content-type': 'application/json' } })
    })

    const response = await bed.app.request('/api/cloudflare/v1/chat/completions', jsonRequest({
      model: LLAMA,
      messages: [{ role: 'user', content: 'hi' }],
    }), bed.env)

    expect(response.status).toBe(200)
    const body = await readJson<{ choices: Array<{ message: { content: string } }> }>(response)
    expect(body.choices[0]?.message.content).toBe('from second')
    expect((await quotaCount(bed, first.id))?.exhausted).toBe(1)
    expect((await quotaCount(bed, second.id))?.count).toBeGreaterThan(0)
  })

  it('answers 429 when every account has reached the daily limit', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    let calls = 0
    stubCloudflare(() => {
      calls += 1
      return new Response(JSON.stringify({
        success: false,
        errors: [{ code: 4006, message: 'daily free allocation limit exceeded' }],
      }), { status: 429, headers: { 'content-type': 'application/json' } })
    })

    const request = () => bed.app.request('/api/cloudflare/v1/chat/completions', jsonRequest({
      model: LLAMA,
      messages: [{ role: 'user', content: 'hi' }],
    }), bed.env)

    const response = await request()
    expect(response.status).toBe(429)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('cloudflare_quota_exceeded')
    expect((await quotaCount(bed, id))?.exhausted).toBe(1)

    // A later request sees the exhausted marker and does not ask Cloudflare again.
    const again = await request()
    expect(again.status).toBe(429)
    expect(calls).toBe(1)
  })
})

describe('the image route', () => {
  it('builds the body each model family expects', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    const calls: Array<{ path: string; contentType: string; body: string }> = []
    stubCloudflare(async (url, init) => {
      calls.push({
        path: url.pathname,
        contentType: new Headers(init?.headers).get('content-type') ?? '',
        body: String(init?.body ?? ''),
      })
      return cfJson({ image: 'aW1hZ2U=' })
    })

    const flux = await bed.app.request('/api/cloudflare/v1/images/generations', jsonRequest({
      model: '@cf/black-forest-labs/flux-1-schnell',
      prompt: 'a cat',
      num_steps: 4,
      width: 512,
    }), bed.env)
    expect(flux.status).toBe(200)
    expect(calls[0]!.path).toBe(
      `/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    )
    expect(JSON.parse(calls[0]!.body)).toEqual({ prompt: 'a cat', steps: 4 })

    const sdxl = await bed.app.request('/api/cloudflare/v1/images/generations', jsonRequest({
      model: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      prompt: 'a dog',
      image: 'aW5wdXQ=',
      width: 768,
      height: 512,
      num_steps: 20,
      guidance: 7.5,
      strength: 0.6,
      negative_prompt: 'blurry',
    }), bed.env)
    expect(sdxl.status).toBe(200)
    const sdBody = JSON.parse(calls[1]!.body) as Record<string, unknown>
    expect(sdBody).toMatchObject({
      prompt: 'a dog',
      image_b64: 'aW5wdXQ=',
      width: 768,
      height: 512,
      num_steps: 20,
      guidance: 7.5,
      strength: 0.6,
      negative_prompt: 'blurry',
    })
    expect(typeof sdBody.mask_image).toBe('string')

    const flux2 = await bed.app.request('/api/cloudflare/v1/images/generations', jsonRequest({
      model: '@cf/black-forest-labs/flux-2-klein',
      prompt: 'a bird',
      num_steps: 6,
    }), bed.env)
    expect(flux2.status).toBe(200)
    expect(calls[2]!.contentType).toContain('multipart/form-data')
    expect(calls[2]!.body).toContain('name="prompt"')
    expect(calls[2]!.body).toContain('a bird')
    expect(calls[2]!.body).toContain('name="steps"')

    const body = await readJson<{ created: number; data: Array<{ b64_json: string; neurons: number }> }>(flux)
    expect(body.data[0]?.b64_json).toBe('aW1hZ2U=')
    expect(body.data[0]?.neurons).toBeGreaterThan(0)
  })
})

describe('the speech route', () => {
  it('builds melotts and aura bodies from each model’s schema', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    const bodies: Record<string, Record<string, unknown>> = {}
    stubCloudflare(async (url, init) => {
      if (url.pathname.endsWith('/ai/models/schema')) {
        const model = url.searchParams.get('model')
        if (model === MELOTTS) {
          return cfJson({
            input: {
              properties: {
                prompt: { type: 'string' },
                lang: { type: 'string', enum: ['en', 'zh'] },
              },
            },
          })
        }
        return cfJson({
          input: {
            properties: {
              text: { type: 'string' },
              speaker: { type: 'string', enum: ['luna', 'mars'] },
              encoding: { type: 'string', enum: ['mp3', 'wav'] },
            },
          },
        })
      }
      const model = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
      bodies[model] = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
    })

    const melotts = await bed.app.request('/api/cloudflare/v1/audio/speech', jsonRequest({
      model: MELOTTS,
      input: 'hello',
      lang: 'zh',
    }), bed.env)
    expect(melotts.status).toBe(200)
    expect(bodies.melotts).toEqual({ prompt: 'hello', lang: 'zh' })

    const aura = await bed.app.request('/api/cloudflare/v1/audio/speech', jsonRequest({
      model: AURA,
      input: 'hi',
      voice: 'alloy',
    }), bed.env)
    expect(aura.status).toBe(200)
    expect(bodies['aura-2-en']).toEqual({ text: 'hi', speaker: 'luna', encoding: 'mp3' })
    const body = await readJson<{ data: Array<{ audio: string; content_type: string; neurons: number }> }>(aura)
    expect(body.data[0]).toMatchObject({ audio: 'AQID', content_type: 'audio/mpeg' })
    expect(body.data[0]?.neurons).toBeGreaterThan(0)
  })

  it('answers 502 when the model returns no audio', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    stubCloudflare((url) => {
      if (url.pathname.endsWith('/ai/models/schema')) return new Response('missing', { status: 404 })
      return new Response(new Uint8Array(0), { headers: { 'content-type': 'audio/mpeg' } })
    })

    const response = await bed.app.request('/api/cloudflare/v1/audio/speech', jsonRequest({
      model: MELOTTS,
      input: 'hello',
    }), bed.env)
    expect(response.status).toBe(502)
    const body = await readJson<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('cloudflare_upstream')
  })
})

describe('the translation route', () => {
  it('builds the M2M100 body and returns the translated text', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER)
    let upstreamBody: Record<string, unknown> | null = null
    stubCloudflare(async (url, init) => {
      expect(url.pathname).toBe(`/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/facebook/m2m100-1.2b`)
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return cfJson({ translated_text: 'bonjour' })
    })

    const response = await bed.app.request('/api/cloudflare/v1/translations', jsonRequest({
      model: '@cf/facebook/m2m100-1.2b',
      text: 'hello',
      target_lang: 'zh',
    }), bed.env)
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ text: 'hello', source_lang: 'en', target_lang: 'zh' })
    const body = await readJson<{ data: Array<{ translated_text: string; neurons: number }> }>(response)
    expect(body.data[0]?.translated_text).toBe('bonjour')
    expect(body.data[0]?.neurons).toBeGreaterThan(0)
  })
})
