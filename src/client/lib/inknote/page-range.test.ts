import { describe, expect, it } from 'vitest'
import { parsePageRange } from './page-range'

describe('parsePageRange', () => {
  it('takes singles, spans and Chinese commas one-based', () => {
    expect(parsePageRange('1,3-4，6', 8)).toEqual([0, 2, 3, 5])
    expect(parsePageRange('3-1', 5)).toEqual([0, 1, 2])
  })

  it('clamps to the pages that exist and ignores junk', () => {
    expect(parsePageRange('0,2,99,abc', 4)).toEqual([1])
    expect(parsePageRange('abc', 3)).toEqual([0, 1, 2])
  })

  it('answers every page for an empty range or an empty note', () => {
    expect(parsePageRange('  ', 3)).toEqual([0, 1, 2])
    expect(parsePageRange('1', 0)).toEqual([])
  })
})
