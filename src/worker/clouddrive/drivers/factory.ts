/**
 * The worker-side driver factory. It joins the shared definition, the decrypted vault and the
 * per-storage persistence callback that a driver uses to write a rotated token back.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import type { Env } from '../../env'
import { decryptCloudDriveCredentials, encryptCloudDriveCredentials } from '../../lib/crypto'
import { create123PanDriver } from './123pan'
import { createAlistV3Driver } from './alist_v3'
import { createAutoIndexDriver } from './autoindex'
import { createAzureBlobDriver } from './azure_blob'
import { createBunnyStorageDriver } from './bunny_storage'
import { createCloudreveV3Driver } from './cloudreve_v3'
import { createCloudreveV4Driver } from './cloudreve_v4'
import { createCnbReleasesDriver } from './cnb_releases'
import { createEmbyDriver } from './emby'
import { createGithubReleasesDriver } from './github_releases'
import { createIpfsApiDriver } from './ipfs_api'
import { createKodboxDriver } from './kodbox'
import { createLenovoNasShareDriver } from './lenovonas_share'
import { createMisskeyDriver } from './misskey'
import { createOneDriveShareLinkDriver } from './onedrive_sharelink'
import { createOpenListDriver } from './openlist'
import { createOpenListShareDriver } from './openlist_share'
import { createR2Driver } from './r2'
import { createSeafileDriver } from './seafile'
import { createTeldriveDriver } from './teldrive'
import { createUrlTreeDriver } from './url_tree'
import { createUssDriver } from './uss'
import { createVirtualDriver } from './virtual'
import type { DriverContext, MountDriver } from './contract'

export interface StorageDriverRow {
  id: string
  user_id: string
  type: string
  config: string
  credentials: string
}

type DriverFactory = (ctx: DriverContext) => MountDriver

const FACTORIES: Readonly<Record<string, DriverFactory>> = {
  '123pan': create123PanDriver,
  'r2': createR2Driver,
  'azure_blob': createAzureBlobDriver,
  'uss': createUssDriver,
  'bunny_storage': createBunnyStorageDriver,
  'seafile': createSeafileDriver,
  'cloudreve_v3': createCloudreveV3Driver,
  'cloudreve_v4': createCloudreveV4Driver,
  'kodbox': createKodboxDriver,
  'alist_v3': createAlistV3Driver,
  'openlist': createOpenListDriver,
  'openlist_share': createOpenListShareDriver,
  'teldrive': createTeldriveDriver,
  'misskey': createMisskeyDriver,
  'emby': createEmbyDriver,
  'ipfs_api': createIpfsApiDriver,
  'cnb_releases': createCnbReleasesDriver,
  'github_releases': createGithubReleasesDriver,
  'virtual': createVirtualDriver,
  'url_tree': createUrlTreeDriver,
  'lenovonas_share': createLenovoNasShareDriver,
  'onedrive_sharelink': createOneDriveShareLinkDriver,
  'autoindex': createAutoIndexDriver,
}

export function driverFactory(type: string): DriverFactory | null {
  return FACTORIES[type] ?? null
}

export function isImplementedDriver(type: string): boolean {
  const definition = findCloudDriveDriver(type)
  return Boolean(definition?.implemented && driverFactory(type))
}

function configOf(row: StorageDriverRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.config) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function credentialsOf(env: Env, row: StorageDriverRow): Promise<Record<string, string>> {
  const stored = await decryptCloudDriveCredentials(env, row.id, row.credentials).catch(() => null)
  if (!stored && row.credentials) throw new Error('The stored storage credentials could not be read')
  return Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => [key, String(value)]))
}

/** Builds the driver for a storage row, or null when its type is not ported yet. */
export async function createStorageDriver(env: Env, row: StorageDriverRow): Promise<MountDriver | null> {
  const factory = driverFactory(row.type)
  if (!factory) return null
  const credentials = await credentialsOf(env, row)
  const context: DriverContext = {
    userId: row.user_id,
    storageId: row.id,
    type: row.type,
    config: configOf(row),
    credentials,
    saveCredentials: async (patch) => {
      Object.assign(credentials, patch)
      const ciphertext = await encryptCloudDriveCredentials(env, row.id, credentials)
      row.credentials = ciphertext
      await env.DB.prepare(
        `UPDATE CloudDrive_storages
            SET credentials = ?, last_used_at = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(ciphertext, Date.now(), Date.now(), row.user_id, row.id).run()
    },
    markNeedsReauth: async (message) => {
      await env.DB.prepare(
        `UPDATE CloudDrive_storages
            SET last_test_at = ?, last_test_status = 'reauth', status = 'enabled', updated_at = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(Date.now(), Date.now(), row.user_id, row.id).run()
      console.warn('[clouddrive] storage needs re-authorization:', row.id, row.type, message)
    },
  }
  return factory(context)
}
