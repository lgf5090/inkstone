import { MAX_MIRRORS } from '@shared/development/github/limits'
import { DEFAULT_GITHUB_MIRRORS } from '@shared/development/github/types'
import type { GithubMirrorProbeResult, GithubMirrorSource } from '@shared/development/github/types'
import { ApiError } from '../../lib/errors'
import { checkTarget } from '../../lib/outbound'

export const MIRROR_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

interface MirrorRow {
  id: string
  name: string
  url: string
  enabled: number
  created_at: number
}

function toMirror(row: MirrorRow): GithubMirrorSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  }
}

export function assertMirrorUrl(value: string): string {
  const url = value.trim()
  if (!url || /[\s\u0000-\u001f\u007f]/.test(url)) {
    throw ApiError.badRequest('A mirror URL cannot contain spaces or control characters')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw ApiError.badRequest('A mirror URL must be a valid absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ApiError.badRequest('A mirror URL must use http or https')
  }
  if (parsed.username || parsed.password) {
    throw ApiError.badRequest('A mirror URL cannot contain credentials')
  }
  return url
}

export interface MirrorInput {
  id: string
  name: string
  url: string
  enabled: boolean
  createdAt?: number
}

const PROBE_TIMEOUT_MS = 5000
const PROBE_CONCURRENCY = 4

export async function probeMirrors(
  inputs: readonly { id: string; url: string }[],
): Promise<GithubMirrorProbeResult[]> {
  const results: GithubMirrorProbeResult[] = []
  for (let start = 0; start < inputs.length; start += PROBE_CONCURRENCY) {
    results.push(...await Promise.all(inputs.slice(start, start + PROBE_CONCURRENCY).map(probeMirror)))
  }
  return results
}

async function probeMirror(input: { id: string; url: string }): Promise<GithubMirrorProbeResult> {
  const target = checkTarget(input.url)
  if (!target.url) return { id: input.id, ok: false, status: 0, latencyMs: null, error: 'blocked' }
  const startedAt = Date.now()
  try {
    const response = await fetch(target.url.toString(), {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - startedAt
    discardBody(response)
    if (response.status === 405 || response.status === 501) {
      return await probeWithRange(target.url, startedAt, input.id)
    }
    const ok = response.status < 500
    return { id: input.id, ok, status: response.status, latencyMs, error: ok ? '' : 'http' }
  } catch (error) {
    return probeFailure(input.id, error)
  }
}

async function probeWithRange(
  url: URL,
  startedAt: number,
  id: string,
): Promise<GithubMirrorProbeResult> {
  try {
    const response = await fetch(url.toString(), {
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - startedAt
    discardBody(response)
    const ok = response.status < 500
    return { id, ok, status: response.status, latencyMs, error: ok ? '' : 'http' }
  } catch (error) {
    return probeFailure(id, error)
  }
}

function probeFailure(id: string, error: unknown): GithubMirrorProbeResult {
  const name = error instanceof Error ? error.name : ''
  const timedOut = name === 'TimeoutError' || name === 'AbortError'
  return { id, ok: false, status: 0, latencyMs: null, error: timedOut ? 'timeout' : 'network' }
}

function discardBody(response: Response): void {
  if (!response.body) return
  void response.body.cancel().catch((error) => {
    console.warn('[inkstone] GitHub mirror probe body cancel failed:', error)
  })
}

export async function listMirrors(db: D1Database, userId: string): Promise<GithubMirrorSource[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, url, enabled, created_at FROM development_github_mirrors
        WHERE user_id = ?1
        ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all<MirrorRow>()
  if (results.length === 0) return DEFAULT_GITHUB_MIRRORS.map((mirror) => ({ ...mirror }))
  return results.map(toMirror)
}

export async function replaceMirrors(
  db: D1Database,
  userId: string,
  mirrors: readonly MirrorInput[],
): Promise<GithubMirrorSource[]> {
  if (mirrors.length > MAX_MIRRORS) {
    throw ApiError.badRequest(`Mirrors are limited to ${MAX_MIRRORS} per account`)
  }
  const seen = new Set<string>()
  const now = Date.now()
  const values: GithubMirrorSource[] = []
  for (const mirror of mirrors) {
    if (!MIRROR_ID_PATTERN.test(mirror.id)) {
      throw ApiError.badRequest('A mirror id may only contain letters, numbers, underscores and hyphens')
    }
    if (seen.has(mirror.id)) throw ApiError.badRequest('Mirror ids must be unique')
    seen.add(mirror.id)
    const name = mirror.name.trim()
    if (!name) throw ApiError.badRequest('A mirror name cannot be blank')
    values.push({
      id: mirror.id,
      name,
      url: assertMirrorUrl(mirror.url),
      enabled: mirror.enabled,
      createdAt: mirror.createdAt ?? now,
    })
  }
  const statements = [db.prepare('DELETE FROM development_github_mirrors WHERE user_id = ?1').bind(userId)]
  for (const mirror of values) {
    statements.push(
      db
        .prepare(
          `INSERT INTO development_github_mirrors (user_id, id, name, url, enabled, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(userId, mirror.id, mirror.name, mirror.url, mirror.enabled ? 1 : 0, mirror.createdAt, now),
    )
  }
  await db.batch(statements)
  return values
}
