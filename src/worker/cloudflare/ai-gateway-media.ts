/**
 * Retention ledger for images the gateway generates and hands back as a URL.
 *
 * The bytes are not copied here: they already live in the image bed's channel, written by the same
 * `uploadSingle` service a manual upload uses. This table only answers "which image files did the
 * gateway create, when do they expire, and have we deleted them yet". The sweep reuses the image
 * bed's own delete path, so a channel's object and its row are removed together.
 */
import type { ImgbedChannelType } from '@shared/imgbed/model'
import type { Env } from '../env'
import { newId } from '../lib/id'
import { getResolvedChannel } from '../imgbed/channels'
import { deleteFileRow, getFile } from '../imgbed/store'
import { deleteWholeFile } from '../imgbed/storage'

export const DEFAULT_IMAGE_TTL_HOURS = 168

export function imageTtlMs(env: Env): number {
  const hours = Number(env.AI_GATEWAY_IMAGE_TTL_HOURS)
  if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 365) return DEFAULT_IMAGE_TTL_HOURS * 3_600_000
  return hours * 3_600_000
}

export interface GatewayMediaInput {
  userId: string
  keyId: string
  requestId: string
  fileId: string
  format: string
  url: string
  sizeBytes: number
  now?: number
}

export async function recordGatewayMedia(env: Env, input: GatewayMediaInput): Promise<void> {
  const now = input.now ?? Date.now()
  const ttl = imageTtlMs(env)
  await env.DB.prepare(
    `INSERT INTO ai_gateway_media
       (id, user_id, key_id, request_id, file_id, format, url, size_bytes, created_at, expires_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
  ).bind(
    newId(),
    input.userId,
    input.keyId,
    input.requestId,
    input.fileId,
    input.format,
    input.url,
    Math.max(0, input.sizeBytes),
    now,
    ttl > 0 ? now + ttl : 0,
  ).run()
}

/**
 * Deletes expired gateway images through the image bed's channel-aware delete path. A missing file
 * row (already removed by hand) is still marked deleted, so the sweep does not retry it forever.
 */
export async function cleanupGatewayMedia(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, file_id FROM ai_gateway_media
      WHERE deleted_at IS NULL AND expires_at > 0 AND expires_at <= ?1
      LIMIT 200`,
  ).bind(now).all<{ id: string; file_id: string }>()
  let removed = 0
  for (const row of results ?? []) {
    try {
      const file = await getFile(env.DB, row.file_id)
      if (file) {
        const channel = await getResolvedChannel(env, env.DB, file.source as ImgbedChannelType, file.channelName)
        if (channel) await deleteWholeFile(env, channel, file)
        await deleteFileRow(env.DB, file.id)
      }
      await env.DB.prepare('UPDATE ai_gateway_media SET deleted_at = ?1 WHERE id = ?2').bind(now, row.id).run()
      removed += 1
    } catch (error) {
      console.warn('[inkstone] gateway media cleanup failed:', row.file_id, (error as Error)?.message)
    }
  }
  return removed
}
