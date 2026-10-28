// The confessional layout: one line becomes one to four centred parts, one of them leaning.
//
// The parts and the lean are both seeded by the line, so a replay looks the same. The leant part
// carries the accent colour and wider tracking; the animation that reveals its characters lives in
// `stage.css`.
import { balancedTextParts, lineRandom } from './stage-math'

export const TILT_MAX_PARTS = 4
const TILT_CHARS_PER_PART = 12

export interface TiltPart {
  index: number
  text: string
  accent: boolean
  /** Lean in degrees; zero for every part but the accented one. */
  tilt: number
  letterSpacingEm: number
  offsetEm: number
  characters: string[]
}

/** Split a line into at most `maxParts` segments, preferring the author's word breaks. */
export function splitParts(text: string, maxParts = TILT_MAX_PARTS): string[] {
  return balancedTextParts(text, 1, maxParts, TILT_CHARS_PER_PART)
}

/**
 * The parts of a tilt line.
 *
 * Exactly one part carries the accent and the tilt when there is more than one. A single-part line
 * still tilts: it is the only part, and the style would otherwise be indistinguishable from plain
 * centred text.
 */
export function tiltParts(
  line: string | { fullText: string, startTime: number },
  maxParts = TILT_MAX_PARTS,
): TiltPart[] {
  const text = typeof line === 'string' ? line : line.fullText
  const seed = typeof line === 'string' ? text : line.startTime
  const parts = splitParts(text, maxParts)
  if (!parts.length) return []
  const random = lineRandom(`tilt:${seed}`)
  const accentIndex = Math.min(parts.length - 1, Math.floor(random() * parts.length))
  return parts.map((part, index) => {
    const accent = index === accentIndex
    return {
      index,
      text: part,
      accent,
      tilt: accent ? -3 + random() * 6 : 0,
      letterSpacingEm: accent ? 0.06 : 0,
      offsetEm: accent ? -0.35 + random() * 0.7 : 0,
      characters: [...part],
    }
  })
}
