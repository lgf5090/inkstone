import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import type { CloudDriveFileRow } from './lib'

export const ACL_ROLES = ['viewer', 'commenter', 'editor'] as const
export type AclRole = typeof ACL_ROLES[number]

const ROLE_RANK: Record<AclRole, number> = { viewer: 1, commenter: 2, editor: 3 }

export interface AclGrant {
  role: AclRole
  expiresAt: number | null
}

export function parseAclRole(value: unknown): AclRole {
  if (typeof value !== 'string' || !(ACL_ROLES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('role must be viewer, commenter or editor')
  }
  return value as AclRole
}

export function parseAclExpiry(value: unknown, now = Date.now()): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now) {
    throw ApiError.badRequest('expiresAt must be a future timestamp or null')
  }
  return value
}

export function aclRoleAllows(actual: AclRole, required: AclRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

/** Resolve a live file and its active, mount-bound ancestor grant. Expired grants are indistinguishable from absent ones. */
export async function aclFileForRole(
  c: Context<AppBindings>,
  ownerId: string,
  fileId: string,
  viewerId: string,
  required: AclRole,
): Promise<{ file: CloudDriveFileRow; grant: AclGrant }> {
  if (!isValidId(fileId)) throw ApiError.notFound('File not found')
  const file = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(ownerId, fileId).first<CloudDriveFileRow>()
  if (!file) throw ApiError.notFound('File not found')
  const now = Date.now()
  const grant = await c.env.DB.prepare(
    `SELECT a.role, a.expires_at AS expiresAt
       FROM CloudDrive_acl a
       JOIN CloudDrive_files f ON f.user_id = a.owner_id AND f.id = a.file_id
      WHERE a.owner_id = ?1 AND a.grantee_id = ?2 AND a.revoked_at IS NULL
        AND (a.expires_at IS NULL OR a.expires_at > ?6)
        AND f.deleted_at IS NULL AND f.mount_id = ?5
        AND (f.id = ?3 OR (f.kind = 'folder'
          AND (f.path = ?4 OR (f.path <> '/' AND substr(?4, 1, length(f.path) + 1) = f.path || '/'))))
      ORDER BY CASE a.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
  ).bind(ownerId, viewerId, file.id, file.path, file.mount_id, now).first<{ role: AclRole; expiresAt: number | null }>()
  if (!grant) throw ApiError.notFound('File not found')
  const role = parseAclRole(grant.role)
  if (!aclRoleAllows(role, required)) throw ApiError.forbidden(`This operation requires ${required} access`)
  return { file, grant: { role, expiresAt: grant.expiresAt } }
}
