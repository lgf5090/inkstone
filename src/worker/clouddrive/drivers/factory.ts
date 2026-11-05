/**
 * The worker-side driver factory. It joins the shared definition, the decrypted vault and the
 * per-storage persistence callbacks that a driver uses to write a rotated token or its own config
 * back. It also builds the controlled cross-mount resolver that wrapper drivers (strm, chunk,
 * crypt, alias) use instead of touching D1 themselves.
 */
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import type { Env } from '../../env'
import { decryptCloudDriveCredentials, encryptCloudDriveCredentials } from '../../lib/crypto'
import { create123PanDriver } from './123pan'
import { createAlistV3Driver } from './alist_v3'
import { createAliasDriver } from './alias'
import { createAutoIndexDriver } from './autoindex'
import { createAzureBlobDriver } from './azure_blob'
import { createBunnyStorageDriver } from './bunny_storage'
import { createChunkDriver } from './chunk'
import { createCloudreveV3Driver } from './cloudreve_v3'
import { createCloudreveV4Driver } from './cloudreve_v4'
import { createCnbReleasesDriver } from './cnb_releases'
import { createCryptDriver } from './crypt'
import { createEmbyDriver } from './emby'
import { createGithubReleasesDriver } from './github_releases'
import { createIpfsApiDriver } from './ipfs_api'
import { createKodboxDriver } from './kodbox'
import { createLenovoNasShareDriver } from './lenovonas_share'
import { createMisskeyDriver } from './misskey'
import { createOneDriveShareLinkDriver } from './onedrive_sharelink'
import { createOpenListDriver } from './openlist'
import { createOpenListShareDriver } from './openlist_share'
import { createR2BindingDriver, createR2Driver } from './r2'
import { createS3Driver } from './s3'
import { createSeafileDriver } from './seafile'
import { createStrmDriver } from './strm'
import { createTeldriveDriver } from './teldrive'
import { createUrlTreeDriver } from './url_tree'
import { createUssDriver } from './uss'
import { createVirtualDriver } from './virtual'
import { DriverError, type DriverContext, type MountDriver, type ResolvedMount } from './contract'

export interface StorageDriverRow {
  id: string
  user_id: string
  type: string
  config: string
  credentials: string
}

/** The mount that is calling the driver; its id seeds the cycle guard. */
export interface DriverMountContext {
  id: string
  mountPath: string
  signExpires?: number | null
}

type DriverFactory = (ctx: DriverContext) => MountDriver

const FACTORIES: Readonly<Record<string, DriverFactory>> = {
  '123pan': create123PanDriver,
  's3': createS3Driver,
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
  'strm': createStrmDriver,
  'chunk': createChunkDriver,
  'crypt': createCryptDriver,
  'alias': createAliasDriver,
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

interface ResolvedMountRow {
  mount_id: string
  mount_name: string
  mount_path: string
  read_only: number
  sign_expires: number | null
  storage_id: string
  owner_id: string | null
  type: string | null
  config: string | null
  credentials: string | null
  status: string | null
}

/** The declared config schema is the only key set `saveConfig` may write. */
function validateConfigPatch(row: StorageDriverRow, patch: Record<string, unknown>): void {
  const definition = findCloudDriveDriver(row.type)
  if (!definition) throw DriverError.unsupported(`Storage type ${row.type} has no configuration schema`)
  const fields = new Map(definition.fields.filter((field) => field.location === 'config').map((field) => [field.key, field]))
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.get(key)
    if (!field) throw DriverError.invalid(`The ${key} field is not part of this driver's configuration`)
    if (field.type === 'number') {
      if (typeof value !== 'number' && typeof value !== 'string') throw DriverError.invalid(`The ${key} field must be a number`)
      if (typeof value === 'number' && !Number.isFinite(value)) throw DriverError.invalid(`The ${key} field must be a finite number`)
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw DriverError.invalid(`The ${key} field must be a boolean`)
    } else if (typeof value !== 'string') {
      throw DriverError.invalid(`The ${key} field must be text`)
    }
  }
}

/** Builds the driver for a storage row, or null when its type is not ported yet. */
export async function createStorageDriver(
  env: Env,
  row: StorageDriverRow,
  mount?: DriverMountContext,
  ancestors: readonly string[] = [],
): Promise<MountDriver | null> {
  const factory = driverFactory(row.type)
  if (!factory) return null
  const credentials = await credentialsOf(env, row)
  const config = configOf(row)
  const chain = mount?.id ? [...ancestors, mount.id] : [...ancestors]

  const resolveMount = async (reference: string): Promise<ResolvedMount> => {
    const ref = reference.trim()
    if (!ref) throw DriverError.invalid('A mount reference is required')
    const target = await env.DB.prepare(
      `SELECT m.id AS mount_id, m.name AS mount_name, m.mount_path, m.read_only, m.sign_expires,
              m.storage_id, s.user_id AS owner_id, s.type, s.config, s.credentials, s.status
         FROM CloudDrive_mounts m
         LEFT JOIN CloudDrive_storages s
           ON s.user_id = m.user_id AND s.id = m.storage_id
        WHERE m.user_id = ?1 AND m.enabled = 1 AND (m.mount_path = ?2 OR m.id = ?2)
        LIMIT 1`,
    ).bind(row.user_id, ref).first<ResolvedMountRow>()
    if (!target) throw DriverError.notFound(`No enabled mount named ${ref} belongs to this user`)
    if (chain.includes(target.mount_id)) {
      throw DriverError.invalid(`Circular mount reference detected: ${ref}`)
    }
    if (target.storage_id === 'primary') {
      throw DriverError.unsupported(
        'The primary mount is a logical D1 view; wrapper drivers must reference an external mount so they do not expose raw R2 object keys.',
      )
    }
    if (target.status !== 'enabled') {
      throw DriverError.notFound(`The mount ${ref} points at a disabled storage`)
    }
    const targetRow: StorageDriverRow = {
      id: target.storage_id,
      user_id: target.owner_id ?? row.user_id,
      type: target.type ?? '',
      config: target.config ?? '{}',
      credentials: target.credentials ?? '',
    }
    const driver = await createStorageDriver(
      env,
      targetRow,
      { id: target.mount_id, mountPath: target.mount_path, signExpires: target.sign_expires },
      chain,
    )
    if (!driver) throw DriverError.unsupported(`The mount ${ref} uses a storage type that is not available`)
    return {
      mountId: target.mount_id,
      mountName: target.mount_name,
      mountPath: target.mount_path,
      readOnly: target.read_only !== 0,
      driver,
    }
  }

  const primary: DriverContext = {
    userId: row.user_id,
    storageId: row.id,
    type: row.type,
    config,
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
    directLinkExpires: mount?.signExpires ?? undefined,
    resolveMount,
    saveConfig: async (patch) => {
      validateConfigPatch(row, patch)
      const merged = { ...config, ...patch }
      if (JSON.stringify(merged).length > 16 * 1024) throw DriverError.invalid('The storage configuration is too large')
      Object.assign(config, patch)
      row.config = JSON.stringify(merged)
      await env.DB.prepare(
        `UPDATE CloudDrive_storages SET config = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
      ).bind(row.config, Date.now(), row.user_id, row.id).run()
    },
    r2: env.FILES,
    ...(mount ? { mountId: mount.id, mountPath: mount.mountPath } : {}),
  }

  const context: DriverContext = primary
  return row.type === 'r2' && String(config.mode ?? '').toLowerCase() === 'binding'
    ? createR2BindingDriver(context)
    : factory(context)
}
