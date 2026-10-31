import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { decryptNavSecret } from '../lib/crypto'
import { acquireLease } from '../lib/lease'
import { parseBackupEndpoint } from '../backup/validation'
import { authHeader, baseUrl, childUrl, ensureDirs, webdavFetch } from '../backup/webdav'
import { readResponseBytesWithinLimit } from '../backup/common'
import { NAV_LIMITS } from '@shared/nav/model'
import { NavBackupSchema, type NavBackupSettings } from '@shared/nav/validation'
import type { NavBackup, NavBackupState } from '@shared/nav/model'
import type { WebdavConfig } from '@shared/types'
import { NavStore } from './store'

export interface NavBackupResult {
  ok: true
  filename: string
  verified: boolean
}

interface Connection {
  nav: NavStore
  config: WebdavConfig & { url: string }
  password: string
}

const NAV_BACKUP_PREFIX = 'inkstone-nav-backup'
const NAV_TIMESTAMPED_RE = /^inkstone-nav-backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/

export async function buildBackup(nav: NavStore): Promise<NavBackup> {
  const [categories, links, visits, settings] = await Promise.all([
    nav.categories(),
    nav.links(),
    nav.visits(),
    nav.settings(),
  ])
  return {
    format: 'inkstone-nav-backup',
    version: 1,
    createdAt: Date.now(),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      createdAt: category.createdAt,
      hasPassword: category.hasPassword,
      passwordMode: category.passwordMode,
      ...(category.kind ? { kind: category.kind } : {}),
    })),
    links: links.map((link) => ({
      id: link.id,
      title: link.title,
      url: link.url,
      icon: link.icon,
      description: link.description,
      categoryId: link.categoryId,
      pinned: link.pinned,
      pinnedOrder: link.pinnedOrder,
      sortOrder: link.sortOrder,
      createdAt: link.createdAt,
    })),
    visits,
    settings,
  }
}

async function loadConnection(env: Env, userId: string, nav: NavStore): Promise<Connection> {
  const config = await nav.webdavConfig()
  if (!config.url || !config.username) throw ApiError.badRequest('WebDAV url and username are required')
  let parsed: URL
  try {
    parsed = parseBackupEndpoint(config.url, 'WebDAV URL')
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'Invalid WebDAV URL')
  }
  const secret = await nav.webdavSecret()
  if (!secret) throw new ApiError(401, 'wrong_password', 'A WebDAV password is required')
  const password = await decryptNavSecret(env, userId, secret)
  if (!password) throw new ApiError(401, 'wrong_password', 'A WebDAV password is required')
  return {
    nav,
    config: { url: parsed.toString(), username: config.username, prefix: '', mode: 'archive' },
    password,
  }
}

function backupFilename(timestamped: boolean, now = new Date()): string {
  if (!timestamped) return `${NAV_BACKUP_PREFIX}.json`
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return `${NAV_BACKUP_PREFIX}_${stamp}.json`
}

async function saveState(nav: NavStore, state: NavBackupState): Promise<void> {
  await nav.saveBackupState({ ...state, history: state.history.slice(0, 400) })
}

async function recordSuccess(nav: NavStore, filename: string, timestamped: boolean): Promise<NavBackupState> {
  const state = await nav.backupState()
  const next: NavBackupState = {
    ...state,
    lastRunAt: Date.now(),
    lastStatus: 'success',
    lastError: null,
    lastFilename: filename,
    history: timestamped
      ? [filename, ...state.history.filter((entry) => entry !== filename)]
      : state.history,
  }
  await saveState(nav, next)
  return next
}

async function recordFailure(nav: NavStore, error: unknown): Promise<void> {
  const state = await nav.backupState()
  await saveState(nav, {
    ...state,
    lastRunAt: Date.now(),
    lastStatus: 'failed',
    lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  })
}

async function deleteRemote(config: WebdavConfig, password: string, filename: string): Promise<void> {
  const base = baseUrl(config)
  const auth = authHeader(config, { password })
  const response = await webdavFetch(childUrl(base, filename), {
    method: 'DELETE',
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(15000),
  }, base.origin)
  await response.body?.cancel().catch(() => null)
  if (!response.ok && response.status !== 404) throw new Error(`Delete ${filename} failed: HTTP ${response.status}`)
}

async function pruneBackups(connection: Connection, state: NavBackupState): Promise<void> {
  const retention = state.retention
  if (!Number.isInteger(retention) || retention <= 0) return
  const doomed = state.history.slice(retention).filter((filename) => NAV_TIMESTAMPED_RE.test(filename))
  if (!doomed.length) return
  for (const filename of doomed) {
    try {
      await deleteRemote(connection.config, connection.password, filename)
    } catch (error) {
      console.warn('[inkstone] Navigation backup retention failed:', error instanceof Error ? error.message : error)
    }
  }
  const removed = new Set(doomed)
  await saveState(connection.nav, { ...state, history: state.history.filter((filename) => !removed.has(filename)) })
}

async function verifyFile(base: URL, auth: string, filename: string, signal?: AbortSignal): Promise<boolean> {
  const response = await webdavFetch(childUrl(base, filename), {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '0' },
    signal,
  }, base.origin)
  await response.body?.cancel().catch(() => null)
  return response.status === 207 || response.ok
}

export async function applyBackupSettings(nav: NavStore, settings: NavBackupSettings | undefined): Promise<void> {
  if (settings?.display) await nav.saveSettingsGroup('display', settings.display)
  if (settings?.search) await nav.saveSettingsGroup('search', settings.search)
  if (settings?.ai) await nav.saveSettingsGroup('ai', settings.ai)
}

export async function navBackupStatus(nav: NavStore): Promise<ReturnType<typeof nav.webdavSettings> extends Promise<infer T> ? T & NavBackupState : never> {
  const [webdav, state] = await Promise.all([nav.webdavSettings(), nav.backupState()])
  return { ...webdav, ...state }
}

export async function performNavBackup(env: Env, userId: string, options: { timestamped: boolean }): Promise<NavBackupResult> {
  const nav = new NavStore(env.DB, userId)
  const release = await acquireLease(
    env.DB,
    `nav-backup:${userId}`,
    30 * 60_000,
    'A navigation backup is already running',
  )
  try {
    const connection = await loadConnection(env, userId, nav)
    const backup = await buildBackup(nav)
    const filename = backupFilename(options.timestamped)
    const base = baseUrl(connection.config)
    const auth = authHeader(connection.config, { password: connection.password })
    const signal = AbortSignal.timeout(20000)
    await ensureDirs(base, auth, [], new Set(), signal)
    const payload = new TextEncoder().encode(JSON.stringify(backup))
    const response = await webdavFetch(childUrl(base, filename), {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Overwrite: 'T' },
      body: payload as unknown as BodyInit,
      signal,
    }, base.origin)
    await response.body?.cancel().catch(() => null)
    if (!response.ok) throw new Error(`WebDAV upload failed: HTTP ${response.status}`)
    const verified = await verifyFile(base, auth, filename, signal)
    const state = await recordSuccess(nav, filename, options.timestamped)
    try {
      await pruneBackups(connection, state)
    } catch (error) {
      console.warn('[inkstone] Navigation backup retention failed:', error instanceof Error ? error.message : error)
    }
    return { ok: true, filename, verified }
  } catch (error) {
    await recordFailure(nav, error).catch(() => null)
    throw error
  } finally {
    await release()
  }
}

export async function restoreNavBackup(env: Env, userId: string): Promise<{
  restoredLinks: number
  restoredCategories: number
  restoredVisits: number
  unlockedCategoryNames: string[]
  filename: string
}> {
  const nav = new NavStore(env.DB, userId)
  const connection = await loadConnection(env, userId, nav)
  const state = await nav.backupState()
  const filename = state.history.find((entry) => NAV_TIMESTAMPED_RE.test(entry)) ?? `${NAV_BACKUP_PREFIX}.json`
  const base = baseUrl(connection.config)
  const auth = authHeader(connection.config, { password: connection.password })
  const response = await webdavFetch(childUrl(base, filename), {
    method: 'GET',
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(20000),
  }, base.origin)
  if (response.status === 404) throw new ApiError(404, 'not_found', 'Backup file not found')
  if (!response.ok) {
    await response.body?.cancel().catch(() => null)
    throw new ApiError(502, 'nav_webdav_failed', `WebDAV download failed: HTTP ${response.status}`)
  }
  const bytes = await readResponseBytesWithinLimit(response, NAV_LIMITS.restoreBytes)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw ApiError.badRequest('Backup file is not valid JSON')
  }
  const parsed = NavBackupSchema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest('Backup file has an unsupported format')
  const result = await nav.restore(parsed.data as NavBackup)
  await applyBackupSettings(nav, parsed.data.settings)
  return { ...result, filename }
}
