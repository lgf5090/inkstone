import { describe, expect, it } from 'vitest'
import type { EmailAccountSettings } from '../../src/shared/email/model'
import {
  EMAIL_VACATION_BODY_MAX_CHARS,
  EMAIL_VACATION_SUBJECT_MAX_CHARS,
  normalizeEmailVacation,
} from '../../src/shared/email/model'

const disabled = {
  enabled: false,
  start: null,
  end: null,
  subject: '',
  body: '',
}

function vacation(value: unknown): EmailAccountSettings {
  return { vacation: value } as EmailAccountSettings
}

describe('vacation settings normalization', () => {
  it('defaults to a disabled reply when nothing is stored', () => {
    expect(normalizeEmailVacation(undefined)).toEqual(disabled)
    expect(normalizeEmailVacation(null)).toEqual(disabled)
    expect(normalizeEmailVacation({})).toEqual(disabled)
    expect(normalizeEmailVacation(vacation(null))).toEqual(disabled)
    expect(normalizeEmailVacation(vacation(['on']))).toEqual(disabled)
  })

  it('keeps a complete reply and its window', () => {
    const start = Date.parse('2026-05-01T09:00:00.000Z')
    const end = Date.parse('2026-05-03T18:30:00.000Z')
    expect(normalizeEmailVacation(vacation({
      enabled: true,
      start,
      end,
      subject: 'Out of office',
      body: 'Back on Monday',
    }))).toEqual({
      enabled: true,
      start,
      end,
      subject: 'Out of office',
      body: 'Back on Monday',
    })
  })

  it('reads ISO window bounds as epoch milliseconds', () => {
    const normalized = normalizeEmailVacation(vacation({
      enabled: true,
      start: '2026-05-01T09:00:00.000Z',
      end: '2026-05-03T18:30:00.000Z',
      subject: '',
      body: 'Away',
    }))
    expect(normalized.start).toBe(Date.parse('2026-05-01T09:00:00.000Z'))
    expect(normalized.end).toBe(Date.parse('2026-05-03T18:30:00.000Z'))
  })

  it('keeps an open side when only one bound is stored', () => {
    const start = Date.parse('2026-05-01T09:00:00.000Z')
    expect(normalizeEmailVacation(vacation({
      enabled: true,
      start,
      end: null,
      subject: '',
      body: 'Away',
    }))).toMatchObject({ enabled: true, start, end: null })
    expect(normalizeEmailVacation(vacation({
      enabled: true,
      start: null,
      end: start,
      subject: '',
      body: 'Away',
    }))).toMatchObject({ enabled: true, start: null, end: start })
  })

  it('disables the reply when a stored value has the wrong type', () => {
    expect(normalizeEmailVacation(vacation({
      enabled: 'yes',
      start: 'soon',
      end: {},
      subject: 42,
      body: null,
    }))).toEqual(disabled)
    expect(normalizeEmailVacation(vacation({
      enabled: true,
      start: -1,
      end: Number.NaN,
      subject: '',
      body: 'Away',
    }))).toEqual(disabled)
  })

  it('disables the reply when a required field is missing', () => {
    expect(normalizeEmailVacation(vacation({ enabled: true, body: 'Away' }))).toEqual(disabled)
    expect(normalizeEmailVacation(vacation({ enabled: true, subject: '', body: 'Away' }))).toEqual({
      enabled: true,
      start: null,
      end: null,
      subject: '',
      body: 'Away',
    })
  })

  it('caps the subject and body at their limits', () => {
    const normalized = normalizeEmailVacation(vacation({
      enabled: true,
      start: null,
      end: null,
      subject: 'x'.repeat(EMAIL_VACATION_SUBJECT_MAX_CHARS + 50),
      body: 'y'.repeat(EMAIL_VACATION_BODY_MAX_CHARS + 50),
    }))
    expect(normalized.subject).toHaveLength(EMAIL_VACATION_SUBJECT_MAX_CHARS)
    expect(normalized.body).toHaveLength(EMAIL_VACATION_BODY_MAX_CHARS)
  })

  it('treats a reversed window as invalid and disables the reply', () => {
    expect(normalizeEmailVacation(vacation({
      enabled: true,
      start: Date.parse('2026-05-03T09:00:00.000Z'),
      end: Date.parse('2026-05-01T09:00:00.000Z'),
      subject: 'Out of office',
      body: 'Back on Monday',
    }))).toEqual(disabled)
  })
})
