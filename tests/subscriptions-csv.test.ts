// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvFilename, parseCsv, rowToInput, toCsv } from '../src/client/features/subscriptions/csv'
import type { SubscriptionItem } from '../src/shared/subscriptions/model'

/**
 * The reader's own spreadsheet, treated as an untrusted input.
 *
 * `parseCsv` is a character loop rather than a `split(',')`, which means every interesting case is a
 * case where a naive split would have produced a wrong answer quietly: a comma inside a note, a quote
 * doubled up, a newline inside a quoted cell. Those are what this pins, because the failure mode is
 * not an error message — it is a category landing in the amount column.
 */

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'Streaming',
    category: 'family',
    amount: 60,
    currency: 'CNY',
    startDate: null,
    expiryDate: '2026-06-01T00:00:00.000Z',
    periodValue: 1,
    periodUnit: 'month',
    subscriptionMode: 'cycle',
    useLunar: false,
    isActive: true,
    autoRenew: true,
    notes: '',
    lastPaymentDate: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    daysRemaining: 8,
    hoursRemaining: 192,
    nextReminderAt: null,
    paymentCount: 0,
    paidByCurrency: [],
    ...overrides,
  }
}

describe('export', () => {
  it('writes a header and one row per subscription', () => {
    const csv = toCsv([item(), item({ id: 'sub-2', name: 'Adobe' })])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].split(',').length).toBeGreaterThan(10)
    expect(lines[1]).toContain('Netflix')
    expect(lines[2]).toContain('Adobe')
  })

  it('quotes what would otherwise break the row', () => {
    const csv = toCsv([item({ name: 'Disney, Plus', notes: 'she said "yes"' })])
    expect(csv).toContain('"Disney, Plus"')
    expect(csv).toContain('"she said ""yes"""')
  })

  it('writes an amount of nothing as an empty cell, not as zero', () => {
    const row = toCsv([item({ amount: null })]).split('\r\n')[1].split(',')
    expect(row).toContain('')
    expect(toCsv([item({ amount: 0 })])).toContain(',0,')
  })

  it('names the file by the day it was taken', () => {
    expect(csvFilename(new Date(Date.UTC(2026, 4, 24)))).toBe('subscriptions-2026-05-24.csv')
  })
})

describe('import', () => {
  it('maps by header name rather than by position', () => {
    const rows = parseCsv('name,amount\nNetflix,60')
    expect(rows[0]).toEqual({ name: 'Netflix', amount: '60' })
    const reordered = parseCsv('amount,name\n60,Netflix')
    expect(rowToInput(reordered[0])).toMatchObject({ name: 'Netflix', amount: 60 })
  })

  it('drops a column the reader renamed instead of shifting the rest', () => {
    const [row] = parseCsv('title,amount\nNetflix,60')
    expect(row).toEqual({ amount: '60' })
  })

  it('reads the first column through the mark Excel puts at the front of the file', () => {
    // The mark is the character U+FEFF, one unit long: a shorter or wider stand-in would silently stop
    // writing the signal Excel reads, and the importer would strip the wrong character from the header.
    expect(CSV_BOM).toHaveLength(1)
    expect(CSV_BOM.codePointAt(0)).toBe(0xFEFF)
    const [row] = parseCsv(`${CSV_BOM}name,amount\nNetflix,60`)
    expect(row.name).toBe('Netflix')
  })

  it('keeps a comma, a quote and a newline inside one field', () => {
    const [row] = parseCsv('name,notes\n"Disney, Plus","line one\nline two, quoted ""x"""')
    expect(row.name).toBe('Disney, Plus')
    expect(row.notes).toBe('line one\nline two, quoted "x"')
  })

  it('skips blank lines and a trailing newline', () => {
    expect(parseCsv('name,amount\nNetflix,60\r\n\r\n')).toHaveLength(1)
    expect(parseCsv('name,amount\n')).toHaveLength(0)
    expect(parseCsv('')).toHaveLength(0)
  })

  it('reads the booleans a spreadsheet actually produces', () => {
    expect(rowToInput({ useLunar: 'TRUE' }).useLunar).toBe(true)
    expect(rowToInput({ useLunar: '是' }).useLunar).toBe(true)
    expect(rowToInput({ useLunar: '1' }).useLunar).toBe(true)
    // Anything else is a no: a column of blanks must not switch a hundred plans onto lunar cycles.
    expect(rowToInput({ autoRenew: '' }).autoRenew).toBe(false)
    expect(rowToInput({ autoRenew: 'maybe' }).autoRenew).toBe(false)
    expect(rowToInput({}).autoRenew).toBe(false)
  })

  it('leaves an absent amount as no price and a written zero as a free plan', () => {
    expect(rowToInput({ amount: '' }).amount).toBeNull()
    expect(rowToInput({ amount: '0' }).amount).toBe(0)
  })

  it('round-trips what the exporter wrote', () => {
    const original = item({ name: 'A, B', notes: 'he said "hi"\nand left', category: 'a/b' })
    const [row] = parseCsv(toCsv([original]))
    const input = rowToInput(row)
    expect(input).toMatchObject({
      name: 'A, B',
      notes: 'he said "hi"\nand left',
      category: 'a/b',
      amount: 60,
      currency: 'CNY',
      expiryDate: '2026-06-01',
      periodUnit: 'month',
    })
  })
})
