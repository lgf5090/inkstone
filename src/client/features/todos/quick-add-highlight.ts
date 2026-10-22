/**
 * Placing the parser's spans on the line the field actually holds.
 *
 * The parser measures the line it reads: `input` with runs of whitespace collapsed to one space and the
 * ends trimmed. A text field holds what the reader typed, which is the same line except when it is not —
 * a second space tapped between two words, a space left at the start — and painting the parser's offsets
 * straight onto the reader's line then puts every later span one character away from the word it names.
 * The coloured band would still read as the right word in the wrong place, which is the failure mode no
 * one notices until a screenshot. So the offsets are carried across by the same walk that produced them.
 */
import { normalizeWithPositions, type QuickAddToken, type QuickAddTokenKind } from '@shared/todos/quick-parse'

export interface QuickAddHighlight {
  /** Which field the reader's words were understood as, so the layer can choose its tint. */
  kind: QuickAddTokenKind
  /** Offsets into the text the field holds, ready to slice. */
  start: number
  /** One past the last character, in the same coordinates as `start`. */
  end: number
}

/**
 * The recognised spans of `input`, in the order they are written.
 *
 * `tokens` is grouped by field for the preview row, and `input` is the raw line: this is the only place
 * the two coordinate systems meet. An offset the line does not have is dropped rather than guessed at,
 * because the parser's own property test is what promises it cannot happen — a highlight drawn at a
 * shifted position would be the exact defect the test exists to prevent.
 */
export function quickAddHighlights(input: string, tokens: readonly QuickAddToken[]): QuickAddHighlight[] {
  const { positions } = normalizeWithPositions(input, input.split('').map((_, index) => index))
  const ranges: QuickAddHighlight[] = []
  for (const token of tokens) {
    const start = positions[token.start]
    const tail = positions[token.end - 1]
    if (start === undefined || tail === undefined || tail < start) continue
    ranges.push({ kind: token.kind, start, end: tail + 1 })
  }
  return ranges.sort((a, b) => a.start - b.start)
}
