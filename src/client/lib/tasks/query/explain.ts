import type { ParsedQuery } from './query'

/** One line of the explanation tree. */
export interface ExplanationLine {
  /** Nesting depth, so the renderer can indent rather than guess. */
  depth: number
  /** Stable identifier for what this line is, chosen by the code rather than by translation. */
  kind: 'filter' | 'combinator' | 'sort' | 'group' | 'limit' | 'layout' | 'mode'
  /** The instruction exactly as the reader wrote it, which is the thing being explained. */
  text: string
}

/**
 * What a parsed query will actually do, as data.
 *
 * Deliberately not prose. The reader's own instruction text is echoed, but every word that describes
 * it — "Sorting", "Grouping" — belongs to the renderer, where it can be translated and where the
 * i18n gate can see it. A string built here would be English forever.
 */
export function explainQuery(parsed: ParsedQuery): ExplanationLine[] {
  const out: ExplanationLine[] = parsed.filterInstructions.map((line) => ({ depth: 0, kind: 'filter' as const, text: line }))

  if (parsed.sorters.length > 0) {
    out.push({ depth: 0, kind: 'sort', text: parsed.sorters.map((sorter) => sorter.instruction).join(', ') })
  }
  for (const grouper of parsed.groupers) {
    out.push({ depth: 0, kind: 'group', text: grouper.instruction })
  }
  if (parsed.limit !== null) out.push({ depth: 0, kind: 'limit', text: `limit ${parsed.limit}` })
  if (parsed.groupLimit !== null) out.push({ depth: 0, kind: 'limit', text: `limit groups ${parsed.groupLimit}` })
  if (parsed.layout.shortMode) out.push({ depth: 0, kind: 'mode', text: 'short mode' })
  for (const part of parsed.layout.hiddenQueryParts) {
    out.push({ depth: 0, kind: 'layout', text: `hide ${part}` })
  }
  return out
}
