/**
 * Resolve the WebDAV target the music cloud browses.
 *
 * WebDAV credentials already belong to a backup target, so the music side stores only the target id
 * and a folder. Nothing here creates a second credential: a missing target, a non-WebDAV target or a
 * target without a stored secret is a named refusal the screen can explain.
 */
import type { WebdavConfig } from '@shared/types'
import type { Env } from '../../env'
import { BackupStore } from '../../backup/store'
import { decryptSecret } from '../../lib/crypto'
import { ApiError } from '../../lib/errors'
import type { MusicStore } from '../store'
import { createMusicWebdavContext, type MusicWebdavContext } from './webdav'

const DEFAULT_DIR = 'music'

function parseConfig(raw: string): WebdavConfig | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const config = value as Partial<WebdavConfig>
    if (typeof config.url !== 'string' || !config.url.trim()) return null
    return {
      url: config.url,
      username: typeof config.username === 'string' ? config.username : '',
      prefix: typeof config.prefix === 'string' ? config.prefix : '',
      mode: config.mode === 'mirror' ? 'mirror' : 'archive',
    }
  } catch {
    return null
  }
}

export async function resolveMusicWebdav(
  env: Env,
  store: MusicStore,
  userId: string,
): Promise<MusicWebdavContext> {
  const settings = await store.getSettings()
  const targetId = settings?.cloudWebdavTargetId?.trim() ?? ''
  const dir = settings?.cloudWebdavDir?.trim() || DEFAULT_DIR
  const backups = new BackupStore(env.DB, userId)
  const target = targetId
    ? await backups.target(targetId)
    : (await backups.listTargets()).find((row) => row.type === 'webdav' && row.enabled === 1) ?? null
  if (!target) {
    throw new ApiError(503, 'music_storage_unavailable', 'No WebDAV target is selected. Choose one in Music settings and try again.')
  }
  if (target.type !== 'webdav') {
    throw ApiError.badRequest('The selected music cloud target is not a WebDAV target.')
  }
  if (!target.secret) {
    throw new ApiError(503, 'music_storage_unavailable', 'The selected WebDAV target has no saved password. Update it in Backup settings.')
  }
  const config = parseConfig(target.config)
  if (!config) {
    throw new ApiError(503, 'music_storage_unavailable', 'The selected WebDAV target has an unreadable address. Edit it in Backup settings.')
  }
  const secret = await decryptSecret<{ password?: string }>(env, target.id, target.secret)
  if (!secret?.password) {
    throw new ApiError(503, 'music_storage_unavailable', 'The selected WebDAV target has no readable password. Update it in Backup settings.')
  }
  return createMusicWebdavContext({ config, secret: { password: secret.password }, dir })
}
