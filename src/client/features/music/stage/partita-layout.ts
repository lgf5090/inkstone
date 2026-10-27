// The cloud-step layout: one lyric line becomes two to six staggered rows.
//
// The split is pure and seeded by the text alone, so the same line always steps the same way across
// a replay. Alignment alternates and each row gets a small inset, which is what keeps the block from
// reading as an ordinary wrapped paragraph.
import { balancedTextParts } from './stage-math'

export const PARTITA_MIN_ROWS = 2
export const PARTITA_MAX_ROWS = 6
const PARTITA_CHARS_PER_ROW = 14

export interface PartitaRow {
  index: number
  text: string
  align: 'start' | 'end'
  /** A small horizontal inset in percent, which keeps the rows from sharing one edge. */
  shift: number
  delayMs: number
}

/** The row insets, cycled so a six-row line still has a readable rhythm. */
const ROW_SHIFTS = [0, 6, -4, 8, -7, 3] as const

/**
 * Break a lyric line into staggered rows.
 *
 * A two-character line asks for two rows but has only one word; the splitter falls back to
 * characters so the style still shows its steps. An empty line returns no rows at all rather than an
 * empty row with a corner line.
 */
export function partitaRows(line: string | { fullText: string }): PartitaRow[] {
  const text = typeof line === 'string' ? line : line.fullText
  const parts = balancedTextParts(text, PARTITA_MIN_ROWS, PARTITA_MAX_ROWS, PARTITA_CHARS_PER_ROW)
  return parts.map((part, index) => ({
    index,
    text: part,
    align: index % 2 === 0 ? 'start' : 'end',
    shift: ROW_SHIFTS[index] ?? 0,
    delayMs: index * 70,
  }))
}
