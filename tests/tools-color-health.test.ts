// @vitest-environment node
/**
 * Judging a scheme instead of only drawing it.
 *
 * The colour-blindness simulation, the CIE ΔE and the WCAG ratio all existed and were never applied to a
 * palette as a whole, so the tool could show a scheme and stay silent about the pair a green-blind reader
 * sees as one colour, or the mid grey that carries no text at all.
 */
import { describe, expect, it } from 'vitest'
import { getContrastRatio, simulateColorBlindness } from '@shared/tools/color/a11y'
import { analysePalette, CVD_CONFUSION_THRESHOLD } from '@shared/tools/color/health'
import { deltaE76, hexToRgb } from '@shared/tools/color/spaces'

function simulatedDistance(a: string, b: string, type: 'normal' | 'deuteranopia'): number {
  return deltaE76(hexToRgb(simulateColorBlindness(a, type)), hexToRgb(simulateColorBlindness(b, type)))
}

describe('confusion under a simulated eye', () => {
  it('flags two identical swatches as one', () => {
    expect(analysePalette(['#c12a2a', '#c12a2a']).confused).toEqual([{ a: 0, b: 1, distance: 0 }])
  })

  it('never confuses black with white', () => {
    expect(analysePalette(['#000000', '#ffffff']).confused).toEqual([])
  })

  it('reports exactly the pairs under the threshold, with their distance', () => {
    const olive = '#a8a832'
    const terracotta = '#b45a3c'
    const normal = simulatedDistance(olive, terracotta, 'normal')
    const underDeuteranopia = simulatedDistance(olive, terracotta, 'deuteranopia')

    // Measured, not remembered: the pair is far apart to a trichromat and lands under the threshold once
    // the green channel is gone. (The textbook "red versus green" does not — ΔE carries the lightness gap.)
    expect(normal).toBeGreaterThan(50)
    expect(underDeuteranopia).toBeLessThan(CVD_CONFUSION_THRESHOLD)

    expect(analysePalette([olive, terracotta], 'deuteranopia').confused).toEqual([
      { a: 0, b: 1, distance: Math.round(underDeuteranopia * 10) / 10 },
    ])
    expect(analysePalette([olive, terracotta], 'normal').confused).toEqual([])
  })

  it('checks every pair, not only neighbours in the list', () => {
    // Same colour at the ends of the array, a different one in the middle.
    const health = analysePalette(['#2ca02c', '#000000', '#2ca02c'], 'normal')
    expect(health.confused).toEqual([{ a: 0, b: 2, distance: 0 }])
  })
})

describe('text on the scheme', () => {
  it('names the background and the foreground of a readable pairing', () => {
    const health = analysePalette(['#000000', '#ffffff'])

    expect(health.readable).toEqual([{ background: 0, foreground: 1, ratio: 21 }])
    // Text sits on the darker half: white on black, and not the unreadable way round.
    expect(health.readable[0]!.background).toBe(0)
  })

  it('leaves out a pairing that only clears the large-text bar', () => {
    const health = analysePalette(['#8c8c8c', '#ffffff'])
    expect(getContrastRatio('#8c8c8c', '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(getContrastRatio('#8c8c8c', '#ffffff')).toBeLessThan(4.5)
    expect(health.readable).toEqual([])
  })

  it('calls out a mid grey and leaves the extremes alone', () => {
    expect(analysePalette(['#808080', '#000000', '#ffffff']).textlessSwatches).toEqual([0])
  })

  /**
   * Why AAA is the only honest bar for that last check: measured across a coarse sample of the cube, every
   * colour leaves black or white at AA, so an AA test could never report anything.
   */
  it('finds no colour that fails both black and white at AA', () => {
    for (let r = 0; r < 256; r += 16) {
      for (let g = 0; g < 256; g += 16) {
        for (let b = 0; b < 256; b += 16) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          const best = Math.max(getContrastRatio(hex, '#000000'), getContrastRatio(hex, '#ffffff'))
          expect(best, hex).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

describe('small palettes', () => {
  it('says nothing about a single colour', () => {
    const health = analysePalette(['#123456'])
    expect(health.confused).toEqual([])
    expect(health.readable).toEqual([])
  })
})
