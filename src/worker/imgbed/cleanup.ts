import type { Env } from '../env'
import { purgeTokens } from './tokens'

export async function runImgbedMaintenance(env: Env, now = Date.now()): Promise<{ sessions: number; tokens: number }> {
  const sessions = await env.DB.prepare(
    "SELECT id, object_key, remote_upload_id, channel FROM imgbed_upload_sessions WHERE expires_at < ?1 AND status <> 'completed'",
  ).bind(now).all<{ id: string; object_key: string; remote_upload_id: string; channel: string }>()
  let removed = 0
  for (const session of sessions.results ?? []) {
    try {
      if (session.channel === 'cfr2' && env.FILES && session.remote_upload_id) {
        await env.FILES.resumeMultipartUpload(session.object_key, session.remote_upload_id).abort()
      }
    } catch (error) {
      console.warn('[inkstone] image-bed multipart abort failed:', (error as Error).message)
    }
    await env.DB.prepare('DELETE FROM imgbed_upload_sessions WHERE id = ?1').bind(session.id).run()
    removed++
  }
  await env.DB.prepare("DELETE FROM imgbed_upload_sessions WHERE expires_at < ?1 AND status = 'completed'").bind(now).run()
  const tokens = await purgeTokens(env.DB, now)
  return { sessions: removed, tokens }
}
