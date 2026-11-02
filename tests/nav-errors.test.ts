// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '../src/client/lib/api'
import { navErrorMessage, navErrorLine, navErrorToast } from '../src/client/features/nav/errors'
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

  it('puts the reason on one line for a status strip that has no second line', () => {
    const coded = new ApiError(400, 'bad_request', t('nav.error.bad_request'), undefined, 'WebDAV URL must use HTTPS')
    expect(navErrorLine(coded)).toBe(`${t('nav.error.bad_request')} · WebDAV URL must use HTTPS`)
    // Without a distinct sentence there is nothing to append, and the strip must not grow a dangling
    // separator that looks like a truncated message.
    const plain = new ApiError(400, 'bad_request', t('nav.error.bad_request'))
    expect(navErrorLine(plain)).toBe(t('nav.error.bad_request'))
  })

  it('answers a request that never reached the server in the reader language', () => {
    expect(navErrorMessage(new TypeError('Failed to fetch'))).toBe(t('nav.error.offline'))
    expect(navErrorMessage(new ApiError(500, 'internal', 'Icon fetch failed: HTTP 502'))).toBeTruthy()
    expect(navErrorMessage(null)).toBe(t('nav.error.generic'))
  })
})

describe('navigation copy rules', () => {
  it('pluralises a count-bearing message instead of writing "1 visits"', async () => {
    const { tCount } = await import('../src/client/lib/i18n')
    expect(tCount('nav.visit_count', 1)).not.toBe(tCount('nav.visit_count', 2))
    expect(tCount('nav.visit_count', 1)).toMatch(/\b1 visit$/)
    expect(tCount('nav.visit_count', 2)).toMatch(/\b2 visits$/)
    // Every base the app pluralises must carry both arms, or one count renders a bare key.
    for (const base of ['nav.import.locked_hint', 'nav.backup.retention_n', 'nav.json.warn_passwords',
      'nav.json.warn_invalid', 'nav.json.warn_repaired', 'nav.json.warn_duplicates', 'nav.json.warn_orphans',
      'nav.json.warn_flattened', 'nav.json.warn_icons', 'nav.json.warn_locked']) {
      expect(tCount(base, 1)).not.toBe(`${base}_one`)
      expect(tCount(base, 3)).not.toBe(`${base}_other`)
    }
  })

  it('renders the automatic folder from the marker rather than a frozen word', async () => {
    const { NAV_UNCATEGORIZED } = await import('../src/shared/nav/model')
    const { categoryDisplayName } = await import('../src/client/features/nav/api')
    const { t } = await import('../src/client/lib/i18n')
    expect(categoryDisplayName(NAV_UNCATEGORIZED)).toBe(t('nav.uncategorized'))
    expect(categoryDisplayName('Reading list')).toBe('Reading list')
  })
})
