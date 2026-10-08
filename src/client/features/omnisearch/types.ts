import type { ParsedOmnisearchQuery } from '@shared/omnisearch-query'

export const OMNISEARCH_DOC_ID_PREFIX = {
  note: 'n:',
  file: 'f:',
} as const

export type OmnisearchDocKind = 'note' | 'file'

/** What the inverted index keeps per document. The body is tokenized, never stored. */
export interface OmnisearchDocument {
  id: string
  kind: OmnisearchDocKind
  title: string
  /** The label the result row shows: a front matter title when one is configured. */
  displayTitle: string
  path: string
  folder: string
  ext: string
  basename: string
  aliases: string
  headings1: string
  headings2: string
  headings3: string
  updatedAt: number
  archived: boolean
  starred: boolean
  noteId: string
}

/** The subset of the document that MiniSearch stores for display and post-filtering. */
export interface OmnisearchStoredFields {
  kind: OmnisearchDocKind
  title: string
  displayTitle: string
  path: string
  folder: string
  ext: string
  updatedAt: number
  archived: boolean
  starred: boolean
  noteId: string
  tags: string[]
  /** The values of the front matter properties the reader gave a weight to. */
  customValues: string[]
  excerpt: string
  truncated: boolean
  size: number
}

export interface OmnisearchMatch {
  term: string
  offset: number
}

export interface ExcerptLine {
  text: string
  /** Ranges into `text` that the query hit. */
  hits: [number, number][]
}

export interface Excerpt {
  lines: ExcerptLine[]
  /** Marks the excerpt as cut from the middle of the note. */
  leading: boolean
  trailing: boolean
}

export interface OmnisearchResult {
  id: string
  doc: OmnisearchStoredFields
  score: number
  terms: string[]
  matches: OmnisearchMatch[]
  /** True when this row was pulled in because the note above it embeds it. */
  isEmbed: boolean
  excerpt: Excerpt
  matchCount: number
}

export interface OmnisearchIndexState {
  phase: 'idle' | 'loading' | 'reading' | 'indexing' | 'writing' | 'done' | 'failed'
  total: number
  done: number
  indexed: number
  skipped: number
  bytes: number
  message: string | null
}

export interface OmnisearchSearchRequest {
  query: ParsedOmnisearchQuery
  /** When set, only that document is searched, and match offsets drive the in-file list. */
  singleDocId?: string
}
