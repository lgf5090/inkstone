// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countApps,
  deleteApp,
  findApp,
  listApps,
  recordAppCheck,
  upsertApp,
} from '../src/worker/development/github/apps'
import { checkAppUpdates } from '../src/worker/development/github/app-updates'
import { DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS } from '../src/worker/development/github/schema'
import { makeD1 } from './doubles/d1-sqlite'
import type { GithubTrackedApp } from '../src/shared/development/github/types'

const USER_A = 'user-a'
const USER_B = 'user-b'
const APP_ID = '123-android'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

function input(patch: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    repoId: '123',
    fullName: 'owner/app',
    repoUrl: 'https://github.com/owner/app',
    ownerAvatarUrl: 'https://avatar/owner',
    platform: 'android' as const,
    assetPattern: '',
    installedTag: 'v1.0.0',
    ...patch,
  }
}

function app(now: number): GithubTrackedApp {
  return {
    id: APP_ID,
    repoId: '123',
    fullName: 'owner/app',
    repoUrl: 'https://github.com/owner/app',
    ownerAvatarUrl: 'https://avatar/owner',
    platform: 'android',
    assetPattern: '',
    installedTag: 'v1.0.0',
    installedAt: now,
    latestTag: '',
    latestAssetName: '',
    latestAssetUrl: '',
    latestPublishedAt: '',
    checkedAt: 0,
    createdAt: now,
    updatedAt: now,
  }
}

describe('github tracked apps store', () => {
  it('creates, updates and scopes apps to their owner', async () => {
    const created = await upsertApp(db, USER_A, input())
    expect(created.fullName).toBe('owner/app')
    expect(created.installedTag).toBe('v1.0.0')
    expect(await countApps(db, USER_A)).toBe(1)
    expect(await findApp(db, USER_A, APP_ID)).not.toBeNull()
    expect(await findApp(db, USER_B, APP_ID)).toBeNull()

    const updated = await upsertApp(db, USER_A, input({ installedTag: 'v1.1.0', assetPattern: 'arm64' }))
    expect(updated.installedTag).toBe('v1.1.0')
    expect(updated.assetPattern).toBe('arm64')
    expect(await countApps(db, USER_A)).toBe(1)
  })

  it('keeps the latest release across an edit and records a check', async () => {
    await upsertApp(db, USER_A, input())
    const checked = await recordAppCheck(db, USER_A, APP_ID, {
      latestTag: 'v1.2.0',
      latestAssetName: 'app-arm64.apk',
      latestAssetUrl: 'https://github.com/owner/app/releases/download/v1.2.0/app-arm64.apk',
      latestPublishedAt: '2026-11-01T00:00:00Z',
      checkedAt: 1000,
    })
    expect(checked?.latestTag).toBe('v1.2.0')

    const edited = await upsertApp(db, USER_A, input({ installedTag: 'v1.2.0' }))
    expect(edited.latestTag).toBe('v1.2.0')
    expect(edited.latestAssetUrl).toContain('app-arm64.apk')
    expect(edited.checkedAt).toBe(1000)
  })

  it('lists newest first and deletes only its own row', async () => {
    const first = await upsertApp(db, USER_A, input({ id: '1-android', repoId: '1' }))
    const second = await upsertApp(db, USER_A, input({ id: '2-linux', repoId: '2', platform: 'linux' }))
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    const listed = await listApps(db, USER_A)
    expect(listed.map((entry) => entry.id)).toEqual(expect.arrayContaining(['1-android', '2-linux']))
    expect(await deleteApp(db, USER_B, APP_ID)).toBe(false)
    expect(await deleteApp(db, USER_A, '1-android')).toBe(true)
    expect(await countApps(db, USER_A)).toBe(1)
  })
})

describe('github update check', () => {
  it('picks the newest stable release and its platform asset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        id: 3,
        tag_name: 'v2.0.0-beta.1',
        prerelease: true,
        published_at: '2026-11-05T00:00:00Z',
        html_url: 'https://github.com/owner/app/releases/tag/v2.0.0-beta.1',
        assets: [],
      },
      {
        id: 2,
        tag_name: 'v1.4.0',
        prerelease: false,
        published_at: '2026-11-01T00:00:00Z',
        html_url: 'https://github.com/owner/app/releases/tag/v1.4.0',
        assets: [
          { id: 10, name: 'app-x64.exe', size: 20, browser_download_url: 'https://example.com/app-x64.exe', download_count: 4 },
          { id: 11, name: 'app-arm64.apk', size: 10, browser_download_url: 'https://example.com/app-arm64.apk', download_count: 8 },
        ],
      },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })))

    const outcomes = await checkAppUpdates([app(Date.now())], 'token')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.error).toBeNull()
    expect(outcomes[0]?.patch?.latestTag).toBe('v1.4.0')
    expect(outcomes[0]?.patch?.latestAssetName).toBe('app-arm64.apk')
  })

  it('reports a failure when the repository has no stable release', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        id: 3,
        tag_name: 'v2.0.0-beta.1',
        prerelease: true,
        published_at: '2026-11-05T00:00:00Z',
        assets: [],
      },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })))

    const outcomes = await checkAppUpdates([app(Date.now())], 'token')
    expect(outcomes[0]?.patch).toBeNull()
    expect(outcomes[0]?.error?.code).toBe('github_not_found')
  })
})
