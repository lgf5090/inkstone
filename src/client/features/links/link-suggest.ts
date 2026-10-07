import { fuzzyMatch, matchesReading } from '../../lib/fuzzy'

export interface LinkSuggestionNote {
  id: string
  title: string
  updatedAt: number
}

export interface LinkSuggestionHeading {
  level: number
  text: string
}

export interface LinkSuggestionRow {
  key: string
  kind: 'note' | 'heading'
  /** What the row is named in the list. */
  label: string
  /** The secondary line: the note a heading belongs to. */
  detail: string
  /** What the target field holds after the row is picked. */
  target: string
  /** What the display-text field holds after the row is picked, '' to leave it alone. */
  text: string
  level: number
  tier: number
  score: number
  ranges: [number, number][]
  recency: number
}

export type AliasMode = 'heading' | 'note-then-heading' | 'heading-then-note'

export interface SuggestInput {
  notes: readonly LinkSuggestionNote[]
  /** The headings the `#` branch offers. Empty until the caller has resolved the note. */
  headings: readonly LinkSuggestionHeading[]
  /** The title whose headings these are; '' means the note being edited. */
  headingOwnerTitle: string
  currentTitle: string
}

export interface SuggestOptions {
  syncAlias: boolean
  aliasMode: AliasMode
  aliasSeparator: string
  limit?: number
}

const DEFAULT_LIMIT = 12

export const TIER_EXACT = 0
export const TIER_PREFIX = 1
export const TIER_CONTAINS = 2
export const TIER_READING = 3
export const TIER_FUZZY = 4

/** How directly a label answers the query: literal first, then the reading of its Chinese, then a crawl. */
export function matchTier(label: string, needle: string): number | null {
  if (!needle) return TIER_CONTAINS
  const value = label.toLowerCase()
  if (value === needle) return TIER_EXACT
  if (value.startsWith(needle)) return TIER_PREFIX
  if (value.includes(needle)) return TIER_CONTAINS
  if (matchesReading(value, needle)) return TIER_READING
  return fuzzyMatch(value, needle) ? TIER_FUZZY : null
}

function compareRows(a: LinkSuggestionRow, b: LinkSuggestionRow): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.score !== b.score) return b.score - a.score
  if (a.recency !== b.recency) return a.recency - b.recency
  return a.label.localeCompare(b.label)
}

export function suggestTargets(query: string, input: SuggestInput, options: SuggestOptions): LinkSuggestionRow[] {
  const limit = options.limit ?? DEFAULT_LIMIT
  const hash = query.indexOf('#')
  return (hash < 0 ? noteRows(query, input, options) : headingRows(query.slice(hash + 1), input, options))
    .sort(compareRows)
    .slice(0, limit)
}

function noteRows(query: string, input: SuggestInput, options: SuggestOptions): LinkSuggestionRow[] {
  const needle = query.trim().toLowerCase()
  const rows: LinkSuggestionRow[] = []
  for (const note of input.notes) {
    if (!note.title) continue
    const tier = matchTier(note.title, needle)
    if (tier === null) continue
    const match = needle ? fuzzyMatch(note.title, needle) : null
    rows.push({
      key: `note:${note.id}`,
      kind: 'note',
      label: note.title,
      detail: '',
      target: note.title,
      text: options.syncAlias ? note.title : '',
      level: 0,
      tier,
      score: match?.score ?? 0,
      ranges: match?.ranges ?? [],
      recency: -note.updatedAt,
    })
  }
  if (needle) rows.push(...headingRows(query, input, options))
  return rows
}

function headingRows(fragment: string, input: SuggestInput, options: SuggestOptions): LinkSuggestionRow[] {
  const ownerIsCurrent = input.headingOwnerTitle === '' || input.headingOwnerTitle === input.currentTitle
  const needle = fragment.trim().toLowerCase()
  const prefix = ownerIsCurrent ? '' : input.headingOwnerTitle
  const alias = (heading: string): string => {
    if (!options.syncAlias) return ''
    if (ownerIsCurrent) return heading
    if (options.aliasMode === 'heading') return heading
    return options.aliasMode === 'note-then-heading'
      ? `${input.headingOwnerTitle}${options.aliasSeparator}${heading}`
      : `${heading}${options.aliasSeparator}${input.headingOwnerTitle}`
  }
  return input.headings.flatMap((heading, index): LinkSuggestionRow[] => {
    const tier = matchTier(heading.text, needle)
    if (tier === null) return []
    const match = needle ? fuzzyMatch(heading.text, needle) : null
    return [{
      key: `heading:${prefix}:${heading.level}:${heading.text}`,
      kind: 'heading',
      label: heading.text,
      detail: ownerIsCurrent ? '' : input.headingOwnerTitle,
      target: `${prefix}#${heading.text}`,
      text: alias(heading.text),
      level: heading.level,
      tier,
      score: match?.score ?? 0,
      ranges: match?.ranges ?? [],
      recency: index,
    }]
  })
}

/** The note part of a target query, or null while the reader has not typed the separator. */
export function subpathQuery(query: string): { note: string, fragment: string } | null {
  const hash = query.indexOf('#')
  if (hash < 0) return null
  return { note: query.slice(0, hash).trim(), fragment: query.slice(hash + 1) }
}
