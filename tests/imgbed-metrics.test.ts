import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { makeD1 } from './doubles/d1-sqlite'
import { IMGBED_SCHEMA_STATEMENTS } from '../src/worker/imgbed/schema'
import { imgbedMetric } from '../src/worker/imgbed/metrics'
import { checkRateLimit, clearRateLimit } from '../src/worker/imgbed/rate-limit'
import { moderateContent } from '../src/worker/imgbed/upload-service'
import { abortMultipart } from '../src/worker/imgbed/storage'
import { runImgbedMaintenanceSafely } from '../src/worker/imgbed/cleanup'
import { imgbedPublicRoutes } from '../src/worker/imgbed/public-routes'
import { saveSettingsGroup } from '../src/worker/imgbed/store'
import { parseSecuritySettings } from '@shared/imgbed/settings'
import type { ResolvedChannel } from '../src/worker/imgbed/channels'
import type { Env } from '../src/worker/env'

function logged(spy: ReturnType<typeof vi.spyOn>, call = 0): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls[call]?.[0])) as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
  clearRateLimit()
})

describe('imgbed metrics', () => {
  it('writes one structured line at the requested level and drops empty fields', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    imgbedMetric('info', 'maintenance.sweep', { sessions: 2, tokens: 0 })
    imgbedMetric('warn', 'rate_limit.blocked', { route: 'public-list', retryAfterSec: 7, absent: undefined })
    imgbedMetric('error', 'maintenance.failure', { stage: 'sweep' })
    expect(logged(info)).toEqual({ source: 'imgbed', event: 'maintenance.sweep', sessions: 2, tokens: 0 })
    expect(logged(warn)).toEqual({ source: 'imgbed', event: 'rate_limit.blocked', route: 'public-list', retryAfterSec: 7 })
    expect(logged(error)).toEqual({ source: 'imgbed', event: 'maintenance.failure', stage: 'sweep' })
    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('redacts bot tokens, query credentials and bearer headers before logging', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    imgbedMetric('error', 'moderation.failure', {
      reason: `GET https://api.telegram.org/bot123456:AAH-secret/sendMessage?token=sekret&keep=1 Authorization: Bearer abc.def ${'x'.repeat(600)}`,
    })
    const text = String(error.mock.calls[0]?.[0])
    expect(text).toContain('/bot***')
    expect(text).toContain('token=***')
    expect(text).toContain('Bearer ***')
    expect(text).not.toContain('AAH-secret')
    expect(text).not.toContain('sekret')
    expect(text).not.toContain('abc.def')
    expect(text.length).toBeLessThan(700)
  })

  it('marks only the first denial of a window', () => {
    expect(checkRateLimit('k', 1, 60_000, 1).firstBlock).toBe(false)
    expect(checkRateLimit('k', 1, 60_000, 2).firstBlock).toBe(true)
    expect(checkRateLimit('k', 1, 60_000, 3).firstBlock).toBe(false)
    expect(checkRateLimit('k', 1, 60_000, 60_001).firstBlock).toBe(false)
  })
})

describe('imgbed metric wiring', () => {
  it('records a public rate-limit hit once per window', async () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of IMGBED_SCHEMA_STATEMENTS) sqlite.exec(statement)
    const db = makeD1(sqlite)
    await saveSettingsGroup(db, 'others', {
      randomImageAPI: { enabled: false, allowedDir: '' },
      publicBrowse: { enabled: true, allowedDir: '*' },
      webDAV: { enabled: false, username: '', passwordHash: '', uploadChannel: '', channelName: '' },
    })
    const env = { DB: db } as unknown as Env
    for (let request = 0; request < 240; request += 1) {
      expect((await imgbedPublicRoutes.request('/public/list?dir=', {}, env)).status).toBe(200)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await imgbedPublicRoutes.request('/public/list?dir=', {}, env)).status).toBe(429)
    expect((await imgbedPublicRoutes.request('/public/list?dir=', {}, env)).status).toBe(429)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(logged(warn)).toMatchObject({ source: 'imgbed', event: 'rate_limit.blocked', route: 'public-list' })
  })

  it('records moderation outages with a reason and keeps failing closed', async () => {
    const security = parseSecuritySettings({})
    security.moderate.enabled = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(moderateContent(security, 'https://example.test/a.png')).rejects.toMatchObject({ status: 503 })
    expect(logged(error)).toMatchObject({
      source: 'imgbed', event: 'moderation.failure', provider: 'moderatecontent.com', reason: 'missing-key',
    })
  })

  it('records a failed maintenance sweep instead of swallowing it', async () => {
    const env = { DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runImgbedMaintenanceSafely(env)).toBeNull()
    expect(logged(error)).toEqual({ source: 'imgbed', event: 'maintenance.failure', stage: 'sweep', error: 'd1 down' })
  })

  it('records a multipart abort failure with the channel', async () => {
    const env = {
      FILES: { resumeMultipartUpload: () => ({ abort: async () => { throw new Error('r2 down') } }) },
    } as unknown as Env
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await abortMultipart(env, { type: 'cfr2' } as ResolvedChannel, { uploadId: 'u', objectKey: 'k' })
    expect(logged(warn)).toEqual({
      source: 'imgbed', event: 'maintenance.failure', stage: 'multipart-abort', channel: 'cfr2', error: 'r2 down',
    })
  })
})
