import type { Env } from '../env'
import { purgeTokens } from './tokens'
import { listResolvedChannels } from './channels'
import { abortMultipart, deleteDiscordMessage, deleteTelegramMessage } from './storage'
import { deleteUploadParts, listUploadParts } from './store'

export async function runImgbedMaintenance(env: Env, now = Date.now()): Promise<{ sessions: number; tokens: number }> {
  const sessions = await env.DB.prepare(
    "SELECT id, object_key, remote_upload_id, channel, channel_name FROM imgbed_upload_sessions WHERE expires_at < ?1 AND status <> 'completed'",
  ).bind(now).all<{ id: string; object_key: string; remote_upload_id: string; channel: string; channel_name: string }>()
  const channels = (sessions.results ?? []).length ? await listResolvedChannels(env, env.DB, true) : []
  let removed = 0
  for (const session of sessions.results ?? []) {
    const channel = channels.find((item) => item.type === session.channel && item.name === session.channel_name)
    try {
      if ((session.channel === 'cfr2' || session.channel === 's3') && channel && session.remote_upload_id) {
        await abortMultipart(env, channel, { uploadId: session.remote_upload_id, objectKey: session.object_key })
      }
      if ((session.channel === 'telegram' || session.channel === 'discord') && channel) {
        const parts = await listUploadParts(env.DB, session.id)
        for (const part of parts) {
          if (!part.messageId) continue
          const result = session.channel === 'discord'
            ? deleteDiscordMessage(channel, part.messageId)
            : deleteTelegramMessage(channel, part.messageId)
          await result.catch((error) => console.warn('[inkstone] image-bed chunk cleanup failed:', (error as Error).message))
        }
      }
    } catch (error) {
      console.warn('[inkstone] image-bed multipart abort failed:', (error as Error).message)
    }
    await deleteUploadParts(env.DB, session.id)
    await env.DB.prepare('DELETE FROM imgbed_upload_sessions WHERE id = ?1').bind(session.id).run()
    removed++
  }
  await env.DB.prepare('DELETE FROM imgbed_upload_parts WHERE session_id IN (SELECT id FROM imgbed_upload_sessions WHERE expires_at < ?1 AND status = ?2)').bind(now, 'completed').run()
  await env.DB.prepare("DELETE FROM imgbed_upload_sessions WHERE expires_at < ?1 AND status = 'completed'").bind(now).run()
  const tokens = await purgeTokens(env.DB, now)
  return { sessions: removed, tokens }
}
