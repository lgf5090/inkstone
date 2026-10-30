import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { IMGBED_SCHEMA_STATEMENTS } from '../src/worker/imgbed/schema'
import { imgbedPublicRoutes } from '../src/worker/imgbed/public-routes'
import { saveSettingsGroup } from '../src/worker/imgbed/store'
import type { Env } from '../src/worker/env'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of IMGBED_SCHEMA_STATEMENTS) sqlite.exec(statement)
  return makeD1(sqlite)
}

describe('imgbed public routes', () => {
  it('does not expose allowed directories while the gallery is disabled', async () => {
    const db = database()
    const response = await imgbedPublicRoutes.request('/public/config', {}, { DB: db } as unknown as Env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, allowedDirs: [] })
    const list = await imgbedPublicRoutes.request('/public/list?dir=', {}, { DB: db } as unknown as Env)
    expect(list.status).toBe(403)
  })

  it('serves an enabled empty gallery with allowed directories', async () => {
    const db = database()
    await saveSettingsGroup(db, 'others', {
      randomImageAPI: { enabled: false, allowedDir: '' },
      publicBrowse: { enabled: true, allowedDir: '/photos' },
      webDAV: { enabled: false, username: '', passwordHash: '', uploadChannel: '', channelName: '' },
    })
    const config = await imgbedPublicRoutes.request('/public/config', {}, { DB: db } as unknown as Env)
    expect(await config.json()).toEqual({ enabled: true, allowedDirs: ['/photos'] })
    const list = await imgbedPublicRoutes.request('/public/list?dir=', {}, { DB: db } as unknown as Env)
    expect(list.status).toBe(200)
    const body = await list.json() as { files: unknown[]; directories: string[] }
    expect(body.files).toEqual([])
    expect(body.directories).toEqual([])
  })
})
