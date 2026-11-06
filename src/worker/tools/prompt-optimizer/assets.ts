/**
 * R2-backed pictures for the Prompt Optimizer.
 *
 * Uploads arrive as data URLs from the browser and are re-typed from their own bytes, not from the
 * claimed MIME. Reads go through an authenticated route keyed by `user_id`, never a raw object key.
 */

import type { AssistantModel, AssistantSettings } from '@shared/assistant'
import { PROMPT_OPTIMIZER_LIMITS, PROMPT_OPTIMIZER_R2_PREFIX, type AssetRecord } from '@shared/tools/prompt-optimizer/types'
import { fromBase64, toBase64 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { extensionFor, hasExpectedImageSignature, readImageSize, safeAttachmentMime } from '../../lib/image'
import { newId } from '../../lib/id'
import { loadModelAndProvider, modelEndpoint } from '../../assistant/model-config'
import { generateImage, IMAGE_SIZES } from '../../assistant/image-generation'
import { AssistantStore } from '../../assistant/store'
import type { Env } from '../../env'
import type { PromptOptimizerStore } from './store'

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'] as const

export function assetKey(userId: string, id: string, mime: string): string {
  return `${PROMPT_OPTIMIZER_R2_PREFIX}/images/${userId}/${id}.${extensionFor(mime, '')}`
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) throw ApiError.badRequest('Upload must be a base64 data URL')
  const mime = match[1]!.toLowerCase()
  if (!IMAGE_MIMES.includes(mime as (typeof IMAGE_MIMES)[number])) throw ApiError.badRequest('Only PNG, JPEG, WebP, AVIF and GIF images are accepted')
  let bytes: Uint8Array
  try {
    bytes = fromBase64(match[2]!)
  } catch {
    throw ApiError.badRequest('The uploaded image is not valid base64')
  }
  if (bytes.length > PROMPT_OPTIMIZER_LIMITS.assetMaxBytes) throw ApiError.badRequest('The image is larger than 8 MB')
  if (!bytes.length) throw ApiError.badRequest('The uploaded image is empty')
  const sniffed = safeAttachmentMime(bytes, mime)
  if (!hasExpectedImageSignature(bytes, sniffed)) throw ApiError.badRequest('The uploaded bytes are not a picture')
  return { mime: sniffed, bytes }
}

export async function uploadAsset(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  dataUrl: string
  kind: 'image'
  prompt: string
}): Promise<AssetRecord> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const { mime, bytes } = decodeDataUrl(input.dataUrl)
  const id = newId()
  const key = assetKey(input.userId, id, mime)
  await input.env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } })
  const size = readImageSize(bytes, mime)
  return input.store.insertAsset({
    id,
    kind: input.kind,
    source: 'upload',
    r2Key: key,
    mime,
    bytes: bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
    prompt: input.prompt,
  })
}

export async function readAsset(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  id: string
}): Promise<Response> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const asset = await input.store.getAsset(input.id)
  if (!asset) throw new ApiError(404, 'not_found', 'Image not found')
  const object = await input.env.FILES.get(asset.r2Key)
  if (!object) throw new ApiError(404, 'not_found', 'Image is missing from storage')
  return new Response(object.body, {
    headers: {
      'content-type': asset.mime,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function assetDataUrl(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  id: string
}): Promise<{ mime: string; dataUrl: string } | null> {
  if (!input.env.FILES) return null
  const asset = await input.store.getAsset(input.id)
  if (!asset) return null
  const object = await input.env.FILES.get(asset.r2Key)
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  return { mime: asset.mime, dataUrl: `data:${asset.mime};base64,${toBase64(bytes)}` }
}

export async function deleteAsset(input: {
  env: Env
  store: PromptOptimizerStore
  id: string
}): Promise<boolean> {
  const asset = await input.store.deleteAsset(input.id)
  if (!asset) return false
  if (input.env.FILES) await input.env.FILES.delete(asset.r2Key)
  return true
}

async function resolveImageModel(env: Env, userId: string, modelId: string): Promise<{
  store: AssistantStore
  settings: AssistantSettings
  model: AssistantModel
  provider: NonNullable<Awaited<ReturnType<typeof loadModelAndProvider>>['provider']>
}> {
  const store = new AssistantStore(env.DB, userId, env)
  const settings = await store.getSettings()
  let model: AssistantModel
  let provider: Awaited<ReturnType<typeof loadModelAndProvider>>['provider'] = null
  if (modelId) {
    const resolved = await loadModelAndProvider(store, settings, modelId)
    if (!resolved.model || resolved.model.purpose !== 'image_generate') {
      throw new ApiError(409, 'conflict', 'The selected model cannot generate images. Choose an image-generation model in settings.')
    }
    model = resolved.model
    provider = resolved.provider
  } else {
    const found = (await store.listModels()).find((entry) => entry.enabled && entry.purpose === 'image_generate')
    if (!found) throw new ApiError(409, 'conflict', 'No image-generation model is configured')
    model = found
  }
  if (!provider) provider = await store.providerRecord(model.providerId)
  if (!provider) throw new ApiError(409, 'conflict', 'The image model\'s provider no longer exists')
  return { store, settings, model, provider }
}

export async function generateImageAsset(input: {
  env: Env
  store: PromptOptimizerStore
  userId: string
  prompt: string
  modelId?: string
  size?: string
  kind: 'image'
}): Promise<AssetRecord> {
  if (!input.env.FILES) throw new ApiError(503, 'internal', 'This deployment has no file bucket')
  const call = await resolveImageModel(input.env, input.userId, input.modelId ?? '')
  const endpoint = modelEndpoint(call.model, call.provider)
  const picked = await call.store.pickProviderKey(call.provider)
  if (!picked) throw new ApiError(409, 'conflict', 'The image model\'s provider has no API key')
  await call.store.markProviderKeyUsed(call.provider.id, picked.keyId)
  const size = input.size && IMAGE_SIZES.includes(input.size as (typeof IMAGE_SIZES)[number]) ? input.size : undefined
  let drawn: { bytes: Uint8Array; mime: string }
  try {
    drawn = await generateImage({
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      apiKey: picked.key,
      model: call.model.model,
      prompt: input.prompt,
      ...(size ? { size } : {}),
    })
  } catch (error) {
    throw new ApiError(502, 'internal', error instanceof Error ? error.message : 'The image model failed')
  }
  const id = newId()
  const key = assetKey(input.userId, id, drawn.mime)
  await input.env.FILES.put(key, drawn.bytes, { httpMetadata: { contentType: drawn.mime } })
  const imageSize = readImageSize(drawn.bytes, drawn.mime)
  return input.store.insertAsset({
    id,
    kind: input.kind,
    source: 'generated',
    r2Key: key,
    mime: drawn.mime,
    bytes: drawn.bytes.length,
    width: imageSize?.width ?? null,
    height: imageSize?.height ?? null,
    prompt: input.prompt,
  })
}
