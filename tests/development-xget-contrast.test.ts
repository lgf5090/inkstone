// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  foregroundForHex,
} from '../src/client/features/development/xget/lib/icon-contrast'

describe('the Xget brand icon contrast', () => {
  it('picks the foreground with the higher contrast for every mapped light brand', () => {
    const lightBrands = [
      'FFD21E',
      'FBB040',
      '76B900',
      '10B981',
      'F28D1A',
      '00ADD8',
      '51A2DA',
      'FC6D26',
      'FF6600',
      '44A833',
      '1793D1',
      '609926',
      'E9573F',
    ]
    for (const background of lightBrands) {
      const foreground = foregroundForHex(background)
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3)
    }
    expect(foregroundForHex('FFD21E')).toBe('#111827')
    expect(foregroundForHex('181717')).toBe('#ffffff')
  })
})
