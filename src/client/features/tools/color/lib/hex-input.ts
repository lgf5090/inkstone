import { normalizeHex } from '@shared/tools/color/spaces'

/**
 * Parses what a reader actually types into a hex field.
 *
 * `normalizeHex` is the module's internal normalizer and it never fails: anything it cannot read becomes
 * `#000000`. That is the right answer for a color already stored and the wrong one for a text box, where a
 * typo used to be evaluated as pure black — the contrast checker reported a mistyped value as a 21:1 pass.
 * This returns null so the caller can say "that is not a color" instead.
 */
const HEX_INPUT = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function parseHexInput(raw: string): string | null {
  const value = raw.trim()
  if (!HEX_INPUT.test(value)) return null
  return normalizeHex(value, true)
}

export function isHexInput(raw: string): boolean {
  return parseHexInput(raw) !== null
}
