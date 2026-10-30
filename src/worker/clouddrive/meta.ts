import { parentPathOf } from '@shared/clouddrive/model'
import { sha256Hex, toBase64Url } from '../lib/encoding'
import { hashPassword, verifyPassword } from '../lib/password'

export interface CloudDriveMetaRow {
  user_id: string
  mount_id: string
  path: string
  header_md: string
  footer_md: string
  hide_patterns: string
  password_hash: string
  inherit_header: number
  inherit_footer: number
  inherit_hide: number
  inherit_password: number
  created_at: number
  updated_at: number
}

export interface EffectiveCloudDriveMeta {
  header: string
  footer: string
  hidePatterns: string[]
  passwordHash: string
  passwordPath: string | null
}

const META_TEXT_MAX = 20_000
const META_PATTERN_MAX = 100
const META_PATTERNS_MAX = 20

export function normalizeMetaText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, META_TEXT_MAX)
}

export function normalizeMetaPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const patterns: string[] = []
  for (const item of value.slice(0, META_PATTERNS_MAX)) {
    if (typeof item !== 'string') continue
    const pattern = item.trim().slice(0, META_PATTERN_MAX)
    if (!pattern) continue
    try {
      new RegExp(pattern)
    } catch {
      throw new Error('invalid_pattern')
    }
    patterns.push(pattern)
  }
  return [...new Set(patterns)]
}

export function hiddenByPatterns(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try { return new RegExp(pattern).test(name) } catch { return false }
  })
}

function parsePatterns(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export async function listMetaRows(db: D1Database, userId: string): Promise<(CloudDriveMetaRow & { mount_name: string; mount_path: string })[]> {
  const { results } = await db.prepare(
    `SELECT m.*, COALESCE(mt.name, m.mount_id) AS mount_name, COALESCE(mt.mount_path, '/') AS mount_path
       FROM CloudDrive_meta m
       LEFT JOIN CloudDrive_mounts mt ON mt.user_id = m.user_id AND mt.id = m.mount_id
      WHERE m.user_id = ?1
      ORDER BY m.updated_at DESC, m.path`,
  ).bind(userId).all<CloudDriveMetaRow & { mount_name: string; mount_path: string }>()
  return results ?? []
}

export async function getMetaRow(db: D1Database, userId: string, mountId: string, path: string): Promise<CloudDriveMetaRow | null> {
  return await db.prepare(
    `SELECT * FROM CloudDrive_meta WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3`,
  ).bind(userId, mountId, path).first<CloudDriveMetaRow>()
}

export async function upsertMetaRow(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
  input: {
    header: string
    footer: string
    hidePatterns: string[]
    inheritHeader: boolean
    inheritFooter: boolean
    inheritHide: boolean
    inheritPassword: boolean
  },
  password: { hash: string | null } | null,
): Promise<CloudDriveMetaRow> {
  const now = Date.now()
  const existing = await getMetaRow(db, userId, mountId, path)
  const passwordHash = password ? password.hash ?? '' : existing?.password_hash ?? ''
  await db.prepare(
    `INSERT INTO CloudDrive_meta
       (user_id, mount_id, path, header_md, footer_md, hide_patterns, password_hash,
        inherit_header, inherit_footer, inherit_hide, inherit_password, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
     ON CONFLICT(user_id, mount_id, path) DO UPDATE SET
       header_md = excluded.header_md,
       footer_md = excluded.footer_md,
       hide_patterns = excluded.hide_patterns,
       password_hash = excluded.password_hash,
       inherit_header = excluded.inherit_header,
       inherit_footer = excluded.inherit_footer,
       inherit_hide = excluded.inherit_hide,
       inherit_password = excluded.inherit_password,
       updated_at = excluded.updated_at`,
  ).bind(
    userId, mountId, path, input.header, input.footer, JSON.stringify(input.hidePatterns), passwordHash,
    input.inheritHeader ? 1 : 0, input.inheritFooter ? 1 : 0, input.inheritHide ? 1 : 0, input.inheritPassword ? 1 : 0,
    now,
  ).run()
  return (await getMetaRow(db, userId, mountId, path))!
}

export async function deleteMetaRow(db: D1Database, userId: string, mountId: string, path: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM CloudDrive_meta WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3`,
  ).bind(userId, mountId, path).run()
  return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0
}

export async function effectiveMeta(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
): Promise<EffectiveCloudDriveMeta> {
  const { results } = await db.prepare(
    `SELECT * FROM CloudDrive_meta WHERE user_id = ?1 AND mount_id = ?2`,
  ).bind(userId, mountId).all<CloudDriveMetaRow>()
  const byPath = new Map((results ?? []).map((row) => [row.path, row]))
  const chain: string[] = []
  let current = path
  for (;;) {
    chain.push(current)
    if (current === '/') break
    current = parentPathOf(current)
  }
  const resolveText = (key: 'header_md' | 'footer_md', inherit: 'inherit_header' | 'inherit_footer'): string => {
    for (const candidate of chain) {
      const row = byPath.get(candidate)
      if (!row) continue
      const inherited = candidate !== path && row[inherit] === 1
      if (row[key] && (candidate === path || inherited)) return row[key]
      if (candidate !== path && !inherited) break
      if (candidate === path && !row[key] && row[inherit] !== 1) break
    }
    return ''
  }
  let hidePatterns: string[] = []
  for (const candidate of chain) {
    const row = byPath.get(candidate)
    if (!row) continue
    const inherited = candidate !== path && row.inherit_hide === 1
    const patterns = parsePatterns(row.hide_patterns)
    if (patterns.length > 0 && (candidate === path || inherited)) {
      hidePatterns = patterns
      break
    }
    if (candidate !== path && !inherited) break
    if (candidate === path && patterns.length === 0 && row.inherit_hide !== 1) break
  }
  let passwordHash = ''
  let passwordPath: string | null = null
  for (const candidate of chain) {
    const row = byPath.get(candidate)
    if (!row) continue
    const inherited = candidate !== path && row.inherit_password === 1
    if (row.password_hash && (candidate === path || inherited)) {
      passwordHash = row.password_hash
      passwordPath = candidate
      break
    }
    if (candidate !== path && !inherited) break
    if (candidate === path && !row.password_hash && row.inherit_password !== 1) break
  }
  return {
    header: resolveText('header_md', 'inherit_header'),
    footer: resolveText('footer_md', 'inherit_footer'),
    hidePatterns,
    passwordHash,
    passwordPath,
  }
}

export function metaCookieName(mountId: string, path: string): Promise<string> {
  return sha256Hex(`clouddrive-meta:${mountId}:${path}`).then((hash) => `cd_meta_${hash.slice(0, 16)}`)
}

export async function isMetaUnlocked(
  db: D1Database,
  userId: string,
  mountId: string,
  passwordPath: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false
  const tokenHash = await sha256Hex(`clouddrive-meta-token:${token}`)
  const row = await db.prepare(
    `SELECT 1 AS found FROM CloudDrive_meta_unlocks
      WHERE token_hash = ?1 AND user_id = ?2 AND mount_id = ?3 AND path = ?4 AND expires_at > ?5`,
  ).bind(tokenHash, userId, mountId, passwordPath, Date.now()).first<{ found: number }>()
  return Boolean(row?.found)
}

export async function unlockMeta(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
  password: string,
): Promise<{ ok: boolean; cookieName: string; token: string; passwordPath: string; expired: boolean }> {
  const meta = await effectiveMeta(db, userId, mountId, path)
  if (!meta.passwordHash || !meta.passwordPath) {
    return { ok: true, cookieName: await metaCookieName(mountId, path), token: '', passwordPath: path, expired: false }
  }
  if (!(await verifyPassword(password, meta.passwordHash))) {
    return { ok: false, cookieName: '', token: '', passwordPath: meta.passwordPath, expired: false }
  }
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(24)))
  const now = Date.now()
  const expiresAt = now + 60 * 60 * 1000
  await db.batch([
    db.prepare(`DELETE FROM CloudDrive_meta_unlocks WHERE expires_at <= ?1`).bind(now),
    db.prepare(
      `INSERT INTO CloudDrive_meta_unlocks (token_hash, user_id, mount_id, path, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(await sha256Hex(`clouddrive-meta-token:${token}`), userId, mountId, meta.passwordPath, expiresAt, now),
  ])
  return { ok: true, cookieName: await metaCookieName(mountId, meta.passwordPath), token, passwordPath: meta.passwordPath, expired: false }
}

export async function hashMetaPassword(password: string): Promise<string> {
  return await hashPassword(password)
}
