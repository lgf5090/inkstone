// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '../src/client/lib/api'
import { navErrorMessage, navErrorToast } from '../src/client/features/nav/errors'
import { initI18n, t } from '../src/client/lib/i18n'

beforeAll(async () => {
  await initI18n()
})

describe('navigation error wording', () => {
  it('localises a coded failure and keeps the route sentence as a detail', () => {
    const coded = new ApiError(502, 'nav_webdav_failed', t('nav.error.webdav'), undefined, 'PROPFIND failed: 409 Conflict on /nav/')
    const toast = navErrorToast(coded)
    expect(toast.title).toBe(t('nav.error.webdav'))
    // The mapping used to swallow the reason, which left the backup panel saying one sentence for every
    // possible mistake.
    expect(toast.description).toBe('PROPFIND failed: 409 Conflict on /nav/')
  })

  it('answers a request that never reached the server in the reader language', () => {
    expect(navErrorMessage(new TypeError('Failed to fetch'))).toBe(t('nav.error.offline'))
    expect(navErrorMessage(new ApiError(500, 'internal', 'Icon fetch failed: HTTP 502'))).toBeTruthy()
    expect(navErrorMessage(null)).toBe(t('nav.error.generic'))
  })
})
