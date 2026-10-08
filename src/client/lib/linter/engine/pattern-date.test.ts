import { describe, expect, it } from 'vitest'
import { parseDateWithPattern } from './pattern-date'

describe('reading a date back through the reader’s own pattern', () => {
  it('reads an ISO instant with its offset', () => {
    const date = parseDateWithPattern('2020-01-01T21:00:05-05:00', 'YYYY-MM-DDTHH:mm:ssZ')

    expect(date?.toISOString()).toBe('2020-01-02T02:00:05.000Z')
  })

  it('reads a named weekday and an ordinal day', () => {
    const date = parseDateWithPattern('Thursday, January 2nd 2020, 12:00:05 am', 'dddd, MMMM Do YYYY, h:mm:ss a')

    expect(date?.getFullYear()).toBe(2020)
    expect(date?.getMonth()).toBe(0)
    expect(date?.getDate()).toBe(2)
    expect(date?.getHours()).toBe(0)
    expect(date?.getMinutes()).toBe(0)
    expect(date?.getSeconds()).toBe(5)
  })

  it('reads a pm hour and a short month name', () => {
    const date = parseDateWithPattern('Wed, Jan 1st 2020, 4:00:00 pm', 'ddd, MMM Do YYYY, h:mm:ss a')

    expect(date?.getHours()).toBe(16)
    expect(date?.getMonth()).toBe(0)
  })

  it('keeps a two-digit year in the right century', () => {
    expect(parseDateWithPattern('01/02/20', 'DD/MM/YY')?.getFullYear()).toBe(2020)
    expect(parseDateWithPattern('01/02/75', 'DD/MM/YY')?.getFullYear()).toBe(1975)
  })

  it('refuses text that does not fit the pattern', () => {
    expect(parseDateWithPattern('not a date', 'YYYY-MM-DD')).toBe(null)
    expect(parseDateWithPattern('2020-13-01', 'YYYY-MM-DD')).toBe(null)
    expect(parseDateWithPattern('2020-01-01', '')).toBe(null)
  })

  it('leaves an unstated month and day at January 1st, as Moment did', () => {
    // the rule round-trips a value through the reader's own pattern, which may spell only the year
    const date = parseDateWithPattern('2020, 12:00:00 am', 'YYYY, h:mm:ss a')

    expect(date?.getMonth()).toBe(0)
    expect(date?.getDate()).toBe(1)
    expect(date?.getHours()).toBe(0)
  })

  it('reads a month name in the locale the pattern was written with', () => {
    const date = parseDateWithPattern('5 février 2020', 'D MMMM YYYY', 'fr')

    expect(date?.getMonth()).toBe(1)
    expect(date?.getDate()).toBe(5)
  })

  it('refuses a year the text never names', () => {
    expect(parseDateWithPattern('January 2nd, 12:00 am', 'MMMM Do, h:mm a')).toBe(null)
  })

  it('reads the local wall clock when the text carries no offset', () => {
    const date = parseDateWithPattern('2020-02-05', 'YYYY-MM-DD')

    expect(date?.getHours()).toBe(0)
    expect(date?.getMonth()).toBe(1)
    expect(date?.getDate()).toBe(5)
  })
})
