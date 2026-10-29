import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireImgbedActor } from './auth'
import { getFile, getSettingsGroup } from './store'
import { normalizeTags, fileIdentity } from '@shared/imgbed/model'
import { IMGBED_DEFAULT_TAG_PROMPT, IMGBED_TAG_OUTPUT_INSTRUCTION, parseAiSettings } from '@shared/imgbed/settings'
import { AssistantStore } from '../assistant/store'
import { streamUpstream } from '../assistant/upstream'

export const imgbedAiRoutes = new Hono<AppBindings>()

const MAX_IMAGE_BYTES = 256 * 1024

function promptFor(settings: ReturnType<typeof parseAiSettings>, preferred: string[]): string {
  const template = settings.prompt || IMGBED_DEFAULT_TAG_PROMPT
  return `${template
    .replace(/\{language\}/g, settings.language === 'en' ? 'English' : 'Simplified Chinese')
    .replace(/\{maxTags\}/g, String(settings.maxTags))
    .replace(/\{preferredTags\}/g, JSON.stringify(preferred))}\n${IMGBED_TAG_OUTPUT_INSTRUCTION}`
}

function parseTags(text: string, maxTags: number): string[] {
  let value: unknown
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'))
  } catch {
    throw new ApiError(502, 'internal', 'The model returned invalid JSON')
  }
  const tags = (value as { tags?: unknown })?.tags
  if (!Array.isArray(tags) || tags.length > maxTags || tags.some((tag) => typeof tag !== 'string')) {
    throw new ApiError(502, 'internal', 'The model returned an invalid tag structure')
  }
  const normalized = normalizeTags(tags as string[])
  if (normalized.length !== tags.length) throw new ApiError(502, 'internal', 'The model returned unsupported tag characters')
  return normalized
}

async function callModel(
  env: AppBindings['Bindings'],
  userId: string,
  modelId: string,
  prompt: string,
  image: { mime: string; dataUrl: string } | null,
  signal: AbortSignal,
): Promise<{ text: string; elapsedMs: number }> {
  const store = new AssistantStore(env.DB, userId, env)
  const model = await store.getModel(modelId)
  if (!model || !model.vision) throw new ApiError(503, 'internal', 'The selected vision model is unavailable')
  const provider = await store.vendorAccess(model.providerId)
  if (!provider) throw new ApiError(503, 'internal', 'The model provider has no usable key')
  const started = Date.now()
  let text = ''
  try {
    for await (const event of streamUpstream(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: model.model,
      system: '',
      turns: [{ role: 'user', content: prompt, ...(image ? { images: [image] } : {}) }],
      tools: [],
      maxOutputTokens: model.maxOutputTokens ?? 256,
      temperature: null,
      reasoning: 'auto',
      structured: !image,
      signal,
    })) {
      if (event.type === 'text') text += event.delta
      if (event.type === 'truncated') throw new ApiError(502, 'internal', 'The model answer was truncated')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal.aborted) throw new ApiError(502, 'internal', 'The AI request timed out')
    throw new ApiError(502, 'internal', 'The AI provider failed')
  }
  if (!text.trim()) throw new ApiError(502, 'internal', 'The model returned an empty answer')
  return { text, elapsedMs: Date.now() - started }
}

async function availableModels(env: AppBindings['Bindings'], userId: string) {
  const store = new AssistantStore(env.DB, userId, env)
  const [models, providers] = await Promise.all([store.listModels(), store.listProviders()])
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]))
  return models
    .filter((model) => model.vision)
    .map((model) => {
      const provider = providerMap.get(model.providerId)
      return {
        id: model.id,
        label: model.label || model.model,
        model: model.model,
        providerLabel: provider?.label ?? '',
        available: Boolean(provider?.hasKey && providers.length),
      }
    })
}

imgbedAiRoutes.get('/ai/tags', async (c) => {
  const actor = await requireImgbedActor(c, 'manage')
  const settings = parseAiSettings(await getSettingsGroup(c.env.DB, 'ai'))
  const models = await availableModels(c.env, actor!.userId)
  const selected = models.find((model) => model.id === settings.modelId)
  return c.json({
    enabled: Boolean(settings.enabled && selected?.available),
    reason: settings.enabled && !selected?.available ? 'model_unavailable' : null,
    modelId: settings.modelId,
    models: models.filter((model) => model.available),
    maxBatchSize: settings.execution.maxBatchSize,
    maxImageBytes: MAX_IMAGE_BYTES,
    language: settings.language,
    maxTags: settings.maxTags,
    preferredTags: settings.preferredTags,
    promptDefault: IMGBED_DEFAULT_TAG_PROMPT,
  })
})

imgbedAiRoutes.post('/ai/test', async (c) => {
  const actor = await requireImgbedActor(c, 'manage')
  const body = await c.req.json().catch(() => null) as { modelId?: string } | null
  const settings = parseAiSettings(await getSettingsGroup(c.env.DB, 'ai'))
  const modelId = body?.modelId || settings.modelId
  if (!modelId) throw ApiError.badRequest('Choose a model first')
  const result = await callModel(c.env, actor!.userId, modelId, 'Reply with the word OK.', null, c.req.raw.signal)
  return c.json({ connected: true, elapsedMs: result.elapsedMs })
})

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

imgbedAiRoutes.post('/ai/tags', async (c) => {
  const actor = await requireImgbedActor(c, 'manage')
  const settings = parseAiSettings(await getSettingsGroup(c.env.DB, 'ai'))
  if (!settings.enabled || !settings.modelId) throw new ApiError(503, 'internal', 'AI tagging is disabled')
  const length = Number(c.req.header('content-length') ?? 0)
  if (length > settings.execution.maxBatchSize * MAX_IMAGE_BYTES + 16 * 1024) throw ApiError.tooLarge('The AI request is too large')
  let form: FormData
  try { form = await c.req.formData() } catch { throw ApiError.badRequest('Invalid image form') }
  const serialized = form.get('items')
  let items: { fileId: string }[]
  try {
    items = JSON.parse(String(serialized ?? '[]')) as { fileId: string }[]
  } catch { throw ApiError.badRequest('Invalid items') }
  if (!Array.isArray(items) || !items.length || items.length > settings.execution.maxBatchSize) {
    throw ApiError.badRequest(`Provide 1-${settings.execution.maxBatchSize} images`)
  }
  const deadline = Date.now() + settings.execution.requestDeadlineMs
  const results: unknown[] = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]!
      try {
        if (deadline - Date.now() < 1500) throw new ApiError(502, 'internal', 'Request time budget exhausted')
        const image = form.get(`image${index}`)
        if (!(image instanceof File) || !image.size || image.size > MAX_IMAGE_BYTES) throw ApiError.badRequest('Invalid preview image')
        const bytes = new Uint8Array(await image.arrayBuffer())
        const mime = imageType(bytes)
        if (!mime || mime !== image.type) throw ApiError.badRequest('Preview format does not match its content')
        const file = await getFile(c.env.DB, item.fileId)
        if (!file) throw ApiError.notFound('File not found')
        const identity = await fileIdentity(file)
        let binary = ''
        for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        const dataUrl = `data:${mime};base64,${btoa(binary)}`
        const answer = await callModel(
          c.env, actor!.userId, settings.modelId, promptFor(settings, settings.preferredTags),
          { mime, dataUrl }, c.req.raw.signal,
        )
        results[index] = { fileId: item.fileId, sourceIdentity: identity, tags: parseTags(answer.text, settings.maxTags), elapsedMs: answer.elapsedMs }
      } catch (error) {
        results[index] = { fileId: item.fileId, error: error instanceof ApiError ? error.message : 'AI_TAGGING_FAILED' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, settings.execution.concurrency) }, worker))
  return c.json({ results }, results.every((result) => !(result as { error?: string }).error) ? 200 : 207)
})
