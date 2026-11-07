import { describe, expect, it } from 'vitest'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { analyzeVault, STALE_AFTER_DAYS } from './health'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function account(overrides: Partial<DecryptedAccount> = {}): DecryptedAccount {
  return {
    id: overrides.id ?? 'a1',
    groupId: 'g1',
    title: 'GitHub',
    username: 'octocat',
    password: 'CorrectHorse-BatteryStaple-2026-XyZ#@!',
    link: 'https://github.com',
    remark: '',
    isFavorite: false,
    sort: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('analyzeVault', () => {
  it('flags weak passwords with the same evaluator the form shows', () => {
    const health = analyzeVault(
      [account({ id: 'weak', password: '123456' }), account({ id: 'strong' })],
      NOW,
    )
    expect(health.weak.map((row) => row.id)).toEqual(['weak'])
  })

  it('lists every member of a repeated password, not just the second copy', () => {
    const health = analyzeVault(
      [
        account({ id: 'one', password: 'same-password-1' }),
        account({ id: 'two', password: 'same-password-1' }),
        account({ id: 'three', password: 'different-2' }),
      ],
      NOW,
    )
    expect(health.reused.map((row) => row.id).sort()).toEqual(['one', 'two'])
  })

  it('ignores empty passwords when looking for reuse', () => {
    const health = analyzeVault(
      [account({ id: 'one', password: '' }), account({ id: 'two', password: '' })],
      NOW,
    )
    expect(health.reused).toEqual([])
  })

  it('counts a row as stale only past the threshold', () => {
    const justInside = account({ id: 'fresh', updatedAt: NOW - (STALE_AFTER_DAYS - 1) * DAY })
    const justPast = account({ id: 'old', updatedAt: NOW - (STALE_AFTER_DAYS + 1) * DAY })

    expect(analyzeVault([justInside, justPast], NOW).stale.map((row) => row.id)).toEqual(['old'])
  })

  it('counts a credential with neither URL nor username as incomplete', () => {
    const health = analyzeVault(
      [account({ id: 'bare', link: '', username: '' }), account({ id: 'fine' })],
      NOW,
    )
    expect(health.incomplete.map((row) => row.id)).toEqual(['bare'])
  })

  it('counts the accounts that carry a second factor', () => {
    const health = analyzeVault(
      [account({ id: 'with', totpSecret: 'JBSWY3DPEHPK3PXP' }), account({ id: 'without' })],
      NOW,
    )
    expect(health.total).toBe(2)
    expect(health.withTotp).toBe(1)
  })

  it('lists a TOTP secret that the current key could not open', () => {
    const health = analyzeVault(
      [
        account({ id: 'broken', totpSecret: '', totpUnreadable: true }),
        account({ id: 'healthy', totpSecret: 'JBSWY3DPEHPK3PXP' }),
      ],
      NOW,
    )
    expect(health.totpUnreadable.map((row) => row.id)).toEqual(['broken'])
  })

  it('lists rows with other unreadable fields separately', () => {
    const health = analyzeVault(
      [account({ id: 'broken', decryptUnreadable: true }), account({ id: 'healthy' })],
      NOW,
    )
    expect(health.decryptUnreadable.map((row) => row.id)).toEqual(['broken'])
  })
})
