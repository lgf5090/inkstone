/**
 * OpenAI Images support on top of Workers AI and the existing image bed.
 *
 * Text-to-image is `flux-1-schnell`; image editing is Stable Diffusion img2img/inpainting. The
 * gateway never writes R2 itself: a `url` response calls the image bed's `uploadSingle`, so the bytes,
 * the channel, the URL format and the delete path are the ones a manual upload already uses. A
 * content-hash filename lets a repeated generation reuse the file already in the bed.
 */
import type { ImgbedChannelType } from '@shared/imgbed/model'
import type { ImgbedActor } from '../imgbed/auth'
import { getResolvedChannel } from '../imgbed/channels'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import { deleteFileRow, getFile, getSettingsGroup } from '../imgbed/store'
import { getWholeFile, publicFileUrl, StorageError } from '../imgbed/storage'
import { uploadSingle } from '../imgbed/upload-service'
import type { ImgbedFile } from '@shared/imgbed/model'
import { sha256Hex } from '../lib/encoding'
import type { Env } from '../env'

export const FLUX_ALIAS = 'flux'
export const IMG2IMG_ALIAS = 'sd15-img2img'
export const INPAINT_ALIAS = 'sd15-inpaint'
const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell'
const IMG2IMG_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img'
const INPAINT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting'
const TILE_NEURONS = 4.8
const STEP_NEURONS = 9.6
const DEFAULT_STEPS = 4
const MAX_STEPS = 8
const EDITED_IMAGE_SAFETY_NEURONS = 50

export const GATEWAY_IMAGE_ALIASES = {
  [FLUX_ALIAS]: { model: FLUX_MODEL, kind: 'generate' as const },
  [IMG2IMG_ALIAS]: { model: IMG2IMG_MODEL, kind: 'edit' as const },
  [INPAINT_ALIAS]: { model: INPAINT_MODEL, kind: 'edit' as const },
}

export type GatewayImageAlias = keyof typeof GATEWAY_IMAGE_ALIASES

export function listImageModels(): Array<{
  id: string
  object: 'model'
  created: number
  owned_by: 'workers-ai'
  worker_model: string
  kind: 'image'
}> {
  return Object.entries(GATEWAY_IMAGE_ALIASES).map(([alias, entry]) => ({
    id: alias,
    object: 'model' as const,
    created: 1_700_000_000,
    owned_by: 'workers-ai' as const,
    worker_model: entry.model,
    kind: 'image' as const,
  }))
}

export function resolveGatewayImage(value: string): { alias: GatewayImageAlias; model: string; kind: 'generate' | 'edit' } | null {
  const entry = (GATEWAY_IMAGE_ALIASES as Record<string, { model: string; kind: 'generate' | 'edit' }>)[value]
  return entry ? { alias: value as GatewayImageAlias, model: entry.model, kind: entry.kind } : null
}

/** flux-1-schnell takes no width/height; 1024x1024 is the shape its catalog page documents. */
export const FLUX_SIZE = '1024x1024'

export function fluxUnitNeurons(steps = DEFAULT_STEPS): number {
  return 4 * TILE_NEURONS + Math.min(MAX_STEPS, Math.max(1, steps)) * STEP_NEURONS
}

export function imageReservation(alias: GatewayImageAlias, steps: number, count: number): number {
  if (alias !== FLUX_ALIAS) return EDITED_IMAGE_SAFETY_NEURONS * count
  const unit = Math.ceil(fluxUnitNeurons(steps) * 1.10)
  return Math.max(50, unit) * count
}

export function imageSettlement(alias: GatewayImageAlias, steps: number, count: number): number {
  if (alias !== FLUX_ALIAS) return EDITED_IMAGE_SAFETY_NEURONS * count
  return Math.ceil(fluxUnitNeurons(steps)) * count
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function bytesToImageInput(bytes: Uint8Array): { b64: string; contentType: string } {
  const detected = detectImage(bytes, '')
  return { b64: bytesToBase64(bytes), contentType: detected.contentType }
}

function detectImage(bytes: Uint8Array, fallback: string): { contentType: string; extension: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { contentType: 'image/jpeg', extension: 'jpg' }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { contentType: 'image/png', extension: 'png' }
  }
  if (fallback.includes('png')) return { contentType: 'image/png', extension: 'png' }
  return { contentType: 'image/jpeg', extension: 'jpg' }
}

export interface ExtractedImage {
  bytes: Uint8Array
  contentType: string
  extension: string
  revisedPrompt?: string
}

/** `/ai/run` may answer JSON with a base64 image or the image bytes directly. */
export async function extractImage(response: Response): Promise<ExtractedImage> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    const result = body && typeof body.result === 'object' && body.result !== null
      ? body.result as Record<string, unknown>
      : body
    const image = result?.image ?? result?.b64_json ?? result?.data
    if (typeof image !== 'string' || image.length === 0) throw new StorageError('Cloudflare returned no image', 502)
    const bytes = base64ToBytes(image)
    const detected = detectImage(bytes, contentType)
    return { bytes, ...detected, ...(typeof result?.revised_prompt === 'string' ? { revisedPrompt: result.revised_prompt } : {}) }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new StorageError('Cloudflare returned an empty image', 502)
  return { bytes, ...detectImage(bytes, contentType) }
}

function gatewayActor(userId: string): ImgbedActor {
  return { kind: 'session', userId, role: 'owner', scopes: [], actorKey: 'ai-gateway' }
}

async function imageStillAvailable(
  env: Env,
  channel: NonNullable<Awaited<ReturnType<typeof getResolvedChannel>>>,
  file: ImgbedFile,
): Promise<boolean> {
  if (channel.type === 'cfr2') {
    if (!env.FILES) return false
    return Boolean(await env.FILES.head(file.objectKey || file.id))
  }
  try {
    const response = await getWholeFile(env, channel, file, 'bytes=0-0')
    await response?.body?.cancel().catch(() => undefined)
    return Boolean(response)
  } catch {
    return false
  }
}

/**
 * The channel's own public domain first, then the image bed's configured link prefix, then this
 * deployment's origin. When the bed's whitelist mode would block an origin link, there is no URL.
 */
export async function imageBedUrl(
  env: Env,
  db: D1Database,
  fileId: string,
  publicUrl: string | undefined,
  fallbackOrigin: string,
): Promise<string | null> {
  if (publicUrl) return publicUrl
  const page = await getSettingsGroup(db, 'page')
  if (page.urlPrefix) return `${page.urlPrefix.replace(/\/+$/, '')}/${fileId}`
  const security = parseSecuritySettings(await getSettingsGroup(db, 'security'))
  if (security.access.whiteListMode) return null
  const origin = (env.PUBLIC_URL || fallbackOrigin).replace(/\/+$/, '')
  return `${origin}/imgbed/file/${fileId}`
}

export interface StoredImage {
  fileId: string
  url: string
  reused: boolean
}

/** Content-hash id inside the gateway's own folder; a hit is reused when its bytes still exist. */
export async function storeGeneratedImage(
  env: Env,
  db: D1Database,
  request: Request,
  userId: string,
  bytes: Uint8Array,
  contentType: string,
  extension: string,
  folder: string,
  origin: string,
): Promise<StoredImage> {
  const hash = (await sha256Hex(bytes)).slice(0, 32)
  const fileName = `${hash}.${extension}`
  const candidateId = `${folder}/${fileName}`
  const existing = await getFile(db, candidateId)
  if (existing) {
    const channel = await getResolvedChannel(env, db, existing.source as ImgbedChannelType, existing.channelName)
    if (channel && await imageStillAvailable(env, channel, existing)) {
      const url = await imageBedUrl(env, db, existing.id, publicFileUrl(channel, existing.id) || undefined, origin)
      if (url) return { fileId: existing.id, url, reused: true }
    }
    await deleteFileRow(db, existing.id)
  }
  const form = new FormData()
  form.append('file', new File([bytes], fileName, { type: contentType }))
  const result = await uploadSingle(env, db, gatewayActor(userId), request, form, {
    uploadFolder: folder,
    uploadNameType: 'origin',
    returnFormat: 'full',
  })
  const url = await imageBedUrl(env, db, result.id, result.publicUrl, origin)
  if (!url) throw new StorageError('The image bed has no publicly reachable URL', 503)
  return { fileId: result.id, url, reused: false }
}
