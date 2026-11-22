/**
 * Turns the `data:image/...` payloads a snapshot carries into stored assets.
 *
 * Univer embeds images as data URLs. A snapshot that keeps them is a snapshot whose size grows with
 * every picture and whose bytes cannot be cached, so every save first uploads each distinct image once
 * and rewrites the copy it is about to store. The live model is never touched: a failed upload keeps
 * the data URL, which costs size, not content.
 */
import { OFFICE_LIMITS } from '@shared/office/constants'
import type { OfficeSnapshot } from '@shared/office/model'
import { findInlineOfficeImages, replaceInlineOfficeImages, type InlineOfficeImage } from '@shared/office/snapshot'
import { t } from '../../../lib/i18n'
import { uploadOfficeAsset } from './office-api'

/** Three at a time: enough to hide latency on a picture-heavy sheet without flooding one origin. */
const UPLOAD_CONCURRENCY = 3

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i

export interface InlineUploadFailure {
  mime: string
  message: string
}

export interface UploadInlineImagesResult {
  /** The snapshot to store: images that uploaded in time are now asset URLs. */
  snapshot: OfficeSnapshot
  /** Every data URL this call knows the URL of, including ones an earlier save uploaded. */
  mapping: ReadonlyMap<string, string>
  uploaded: number
  failed: number
}

export interface UploadInlineImagesOptions {
  signal?: AbortSignal
  /**
   * Data URLs an earlier save already stored. The live Univer model keeps its data URLs — only the
   * copy written to the server is rewritten — so without this every save of one picture would upload it
   * again. Callers keep the map for the lifetime of the editor.
   */
  known?: ReadonlyMap<string, string>
  /** Called once per image that could not be stored; the snapshot keeps its data URL. */
  onFailure?: (failure: InlineUploadFailure) => void
}

function base64Buffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return buffer
}

function inlineImageBlob(image: InlineOfficeImage): Blob {
  const match = IMAGE_DATA_URL.exec(image.dataUrl)
  if (!match) throw new Error(t('office.asset.upload_failed'))
  const buffer = base64Buffer(match[2]!)
  if (buffer.byteLength > OFFICE_LIMITS.assetBytes) throw new Error(t('office.import.too_large'))
  return new Blob([buffer], { type: match[1]!.toLowerCase() })
}

async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await run(items[index]!)
    }
  })
  await Promise.all(workers)
}

export async function uploadInlineOfficeImages(
  snapshot: OfficeSnapshot,
  options: UploadInlineImagesOptions = {},
): Promise<UploadInlineImagesResult> {
  const mapping = new Map(options.known ?? [])
  const pending = findInlineOfficeImages(snapshot).filter((image) => !mapping.has(image.dataUrl))
  if (!pending.length) {
    return mapping.size
      ? { snapshot: replaceInlineOfficeImages(snapshot, mapping) as OfficeSnapshot, mapping, uploaded: 0, failed: 0 }
      : { snapshot, mapping, uploaded: 0, failed: 0 }
  }

  let uploaded = 0
  let failed = 0
  await forEachLimited(pending, UPLOAD_CONCURRENCY, async (image) => {
    try {
      const asset = await uploadOfficeAsset(inlineImageBlob(image), options.signal ? { signal: options.signal } : {})
      mapping.set(image.dataUrl, asset.url)
      uploaded += 1
    } catch (error) {
      failed += 1
      options.onFailure?.({
        mime: image.mime,
        message: error instanceof Error ? error.message : t('office.asset.upload_failed'),
      })
    }
  })

  // `replaceInlineOfficeImages` only rewrites leaves, so the record that went in is the record that
  // comes out; the cast says that rather than widening the shared helper's return type.
  const replaced = replaceInlineOfficeImages(snapshot, mapping) as OfficeSnapshot
  return { snapshot: replaced, mapping, uploaded, failed }
}