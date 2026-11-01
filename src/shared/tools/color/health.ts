import { getContrastRatio, getRelativeLuminance, simulateColorBlindness } from './a11y'
import { deltaE76, hexToRgb } from './spaces'
import type { ColorBlindnessType } from './types'

/**
 * Whether a colour scheme survives contact with real readers.
 *
 * The module already computed the pieces — a colour-blindness simulation, a CIE ΔE, a WCAG ratio — and never
 * compared one palette against another with them, so it could show a scheme and stay silent about the two
 * swatches in it that a green-blind reader sees as one, or the mid-grey that holds no readable text at all.
 */

/** Below this ΔE76, two swatches are one colour to the eye being simulated. */
export const CVD_CONFUSION_THRESHOLD = 10

/** The pairing the copy can promise without a picker: the most common deficiency. */
export const DEFAULT_CHECK_DEFICIENCY: ColorBlindnessType = 'deuteranopia'

/** A pairing earns a recommendation only if body text clears AA. */
const TEXT_RATIO = 4.5

/**
 * The bar a swatch has to clear with *both* black and white to be usable anywhere in a scheme.
 *
 * Not AA: black/white always leaves one of them at AA on any colour (measured over 32,768 samples, none
 * failed both), so an AA test here could never report anything. AAA is the band that mid greys fall in.
 */
const SWATCH_AAA_RATIO = 7

export interface ConfusedPair {
  a: number
  b: number
  distance: number
}

export interface TextPairing {
  /** Index into the palette of the colour the text sits on. */
  background: number
  foreground: number
  ratio: number
}

export interface PaletteHealth {
  /** Pairs the simulated eye cannot separate, by their index in the palette. */
  confused: ConfusedPair[]
  /** Pairs that carry body-size text, whichever way round they are used. */
  readable: TextPairing[]
  /** Swatches where neither black nor white body text reaches AAA. */
  textlessSwatches: number[]
}

export function analysePalette(hexes: string[], deficiency: ColorBlindnessType = DEFAULT_CHECK_DEFICIENCY): PaletteHealth {
  // The comparison happens in the simulated space: what the reader sees, not what the file stores.
  const simulated = hexes.map((hex) => hexToRgb(simulateColorBlindness(hex, deficiency)))

  const confused: ConfusedPair[] = []
  for (let a = 0; a < simulated.length; a++) {
    for (let b = a + 1; b < simulated.length; b++) {
      const distance = deltaE76(simulated[a]!, simulated[b]!)
      if (distance < CVD_CONFUSION_THRESHOLD) confused.push({ a, b, distance: Math.round(distance * 10) / 10 })
    }
  }

  const readable: TextPairing[] = []
  for (let a = 0; a < hexes.length; a++) {
    for (let b = a + 1; b < hexes.length; b++) {
      const ratio = getContrastRatio(hexes[a]!, hexes[b]!)
      if (ratio < TEXT_RATIO) continue
      // Text belongs on the darker half, so the recommendation says which is which.
      const lighterFirst = getRelativeLuminance(hexToRgb(hexes[a]!)) >= getRelativeLuminance(hexToRgb(hexes[b]!))
      readable.push({
        background: lighterFirst ? b : a,
        foreground: lighterFirst ? a : b,
        ratio: Math.round(ratio * 100) / 100,
      })
    }
  }

  const textlessSwatches = hexes
    .map((hex, index) => ({ hex, index }))
    .filter(({ hex }) => Math.max(getContrastRatio(hex, '#000000'), getContrastRatio(hex, '#ffffff')) < SWATCH_AAA_RATIO)
    .map(({ index }) => index)

  return { confused, readable, textlessSwatches }
}
