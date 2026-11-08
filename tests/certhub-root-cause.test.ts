// @vitest-environment node
/**
 * The two production 500s, reproduced at the layer that caused them.
 *
 * Account registration failed for a login that is not an email: the old code built `mailto:lgf5090`,
 * which the CA rejects with "unable to parse email address". Domain validation threw a plain `Error`
 * that no route mapped, so the same bad input answered 500 instead of a 400 with a reason.
 */
import { describe, expect, it } from 'vitest'
import { acmeContactEmail, accountRegistrationApiError } from '../src/worker/development/certhub/accounts'
import { certhubValidationApiError } from '../src/worker/development/certhub/validation-error'
import { validateDomainRows } from '../src/shared/development/certhub/validation'
import { decodeCursor, encodeCursor } from '../src/worker/development/certhub/store'
import { orderSortFromSearch, parseOrderSort } from '../src/shared/development/certhub/sorting'
import { ApiError } from '../src/worker/lib/errors'

describe('acme contact for account registration', () => {
  it('drops a login that is not an email instead of sending mailto:login', () => {
    expect(acmeContactEmail('lgf5090')).toBe('')
    expect(acmeContactEmail('lgf5090@localhost')).toBe('')
    expect(acmeContactEmail(' local@inkstone.dev ')).toBe('local@inkstone.dev')
  })

  it('turns a CA rejection into a readable 502, not an opaque 500', () => {
    const error = accountRegistrationApiError(new Error('Error validating contact(s) :: unable to parse email address'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.message).toContain('unable to parse email address')
  })
})

describe('domain validation mapped to 400', () => {
  const bad = (rows: Parameters<typeof validateDomainRows>[0]) => {
    try {
      validateDomainRows(rows)
    } catch (error) {
      return certhubValidationApiError(error)
    }
    return null
  }

  it('answers a structured 400 for an unparseable domain', () => {
    const mapped = bad([{ name: 'not a domain' }])
    expect(mapped?.status).toBe(400)
    expect(mapped?.code).toBe('bad_request')
    expect(mapped?.details).toEqual({ reason: 'domain_invalid' })
    expect(mapped?.message).toBe('The domain name is not valid')
  })

  it('answers a structured 400 for a wildcard over HTTP', () => {
    const mapped = bad([{ name: 'example.com', wildcard: true, challengeMode: 'http-01' }])
    expect(mapped?.status).toBe(400)
    expect(mapped?.details).toEqual({ reason: 'wildcard_requires_dns01' })
  })

  it('leaves an unrelated error alone', () => {
    expect(certhubValidationApiError(new Error('database is locked'))).toBeNull()
    expect(certhubValidationApiError('nope')).toBeNull()
  })
})

describe('order sorting contract', () => {
  it('defaults to updated and rejects an unknown key', () => {
    expect(parseOrderSort(null)).toBe('updated')
    expect(parseOrderSort('expires')).toBe('expires')
    expect(parseOrderSort('bogus')).toBeNull()
    expect(orderSortFromSearch('?sort=name')).toBe('name')
    expect(orderSortFromSearch('?sort=bogus')).toBe('updated')
  })

  it('round-trips a keyset cursor, including numeric keys', () => {
    expect(decodeCursor(encodeCursor('expires', 1_700_000_000_000, 'order-1'))).toEqual({
      sort: 'expires',
      key: 1_700_000_000_000,
      id: 'order-1',
    })
    expect(decodeCursor(encodeCursor('name', 'example.com', 'order-2'))).toEqual({
      sort: 'name',
      key: 'example.com',
      id: 'order-2',
    })
    expect(decodeCursor(undefined)).toBeNull()
  })
})
