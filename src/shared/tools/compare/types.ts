/**
 * Shared types for the compare tool under Tools (`tools/compare`).
 *
 * The same vocabulary is read by the client (which draws the comparison), the worker (which stores
 * projects and counts runs) and the assistant tools, so a `kind` written here is the one a saved
 * project row carries and the one a statistics bucket is named after.
 */

export const COMPARE_KINDS = ['text', 'file', 'dir', 'image', 'binary'] as const
export type CompareKind = (typeof COMPARE_KINDS)[number]

export const TEXT_VIEW_MODES = ['side_by_side', 'inline'] as const
export type TextViewMode = (typeof TEXT_VIEW_MODES)[number]

export const IMAGE_VIEW_MODES = ['side_by_side', 'overlay', 'difference', 'slider'] as const
export type ImageViewMode = (typeof IMAGE_VIEW_MODES)[number]

/** How many lines either side of a change stay visible when the unchanged part is folded. */
export const FOLD_MARGIN = 3
/** Below this many unchanged lines a run is not worth folding. */
export const FOLD_MIN_SIZE = 4

/** One side's slice, 1-based and inclusive, as the line numbers an editor shows. */
export interface LineRange {
  from: number
  to: number
}

export interface TextCompareOptions {
  /** Runs of spaces, tabs and other whitespace count as one space, and the edges are trimmed. */
  ignoreWhitespace: boolean
  ignoreCase: boolean
  /** CRLF and LF are the same line ending. Off, a `\r` is part of the line and shows as a change. */
  ignoreLineEndings: boolean
  /** A regular expression whose matches are removed before lines are compared. Empty means none. */
  ignoreRegex: string
  /** Compare only these lines; everything outside is left alone and reported as unchanged. */
  leftRange: LineRange | null
  rightRange: LineRange | null
}

export const DEFAULT_TEXT_OPTIONS: TextCompareOptions = {
  ignoreWhitespace: false,
  ignoreCase: false,
  ignoreLineEndings: true,
  ignoreRegex: '',
  leftRange: null,
  rightRange: null,
}

/** The options a saved project or a statistics run carries; unknown fields are dropped on read. */
export function normalizeTextOptions(value: Partial<TextCompareOptions> | null | undefined): TextCompareOptions {
  const raw = value ?? {}
  return {
    ignoreWhitespace: Boolean(raw.ignoreWhitespace),
    ignoreCase: Boolean(raw.ignoreCase),
    ignoreLineEndings: raw.ignoreLineEndings === undefined ? true : Boolean(raw.ignoreLineEndings),
    ignoreRegex: typeof raw.ignoreRegex === 'string' ? raw.ignoreRegex.slice(0, 256) : '',
    leftRange: sanitizeRange(raw.leftRange),
    rightRange: sanitizeRange(raw.rightRange),
  }
}

function sanitizeRange(value: unknown): LineRange | null {
  if (!value || typeof value !== 'object') return null
  const { from, to } = value as { from?: unknown; to?: unknown }
  if (typeof from !== 'number' || typeof to !== 'number') return null
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const start = Math.max(1, Math.floor(from))
  const end = Math.max(start, Math.floor(to))
  return { from: start, to: end }
}

/** Whether any option changes how two lines are judged equal. */
export function hasTextOptions(options: TextCompareOptions): boolean {
  return options.ignoreWhitespace
    || options.ignoreCase
    || options.ignoreRegex.trim() !== ''
    || options.leftRange !== null
    || options.rightRange !== null
}

export type DiffRowKind = 'same' | 'changed' | 'added' | 'removed'

/** One row of an aligned comparison: both sides' line numbers and their original text. */
export interface DiffRow {
  kind: DiffRowKind
  leftNo: number | null
  rightNo: number | null
  leftText: string
  rightText: string
}

export interface DiffHunk {
  index: number
  /** 1-based line numbers of the changed region, inclusive; the context around it extends outside. */
  leftStart: number
  leftEnd: number
  rightStart: number
  rightEnd: number
  /** The rows to draw, context included. */
  rows: DiffRow[]
  added: number
  removed: number
}

export interface DiffStats {
  added: number
  removed: number
  changed: number
  changedBlocks: number
  same: number
}

/** A changed character range, in the shape `@codemirror/merge` asks a custom diff for. */
export interface CharChange {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

export interface TextDiffResult {
  rows: DiffRow[]
  hunks: DiffHunk[]
  stats: DiffStats
  leftLines: string[]
  rightLines: string[]
  changes: CharChange[]
  /** True when the line diff hit its time budget and fell back to a coarse one-block answer. */
  coarse: boolean
}

export const TEXT_LIMITS = {
  /** A text comparison this large is refused rather than allowed to stall the page. */
  maxBytes: 24 * 1024 * 1024,
  /** Above this the line diff runs in a worker, so the page stays responsive. */
  workerBytes: 400 * 1024,
  /** Lines kept in one editor; the renderer virtualizes but the diff itself is line-based. */
  maxLines: 200_000,
  /** The diff's own budget before it answers with one coarse block. */
  diffTimeoutMs: 1_500,
} as const

export const ASSET_LIMITS = {
  text: 24 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  binary: 20 * 1024 * 1024,
  dir: 8 * 1024 * 1024,
  /** How many files one directory manifest may carry. */
  dirEntries: 4_000,
} as const

export const PROJECT_LIMITS = {
  name: 80,
  label: 80,
  optionsJson: 4_096,
  summaryJson: 8_192,
  listPage: 50,
} as const

/** A stored side of a comparison: the bytes live in R2, the metadata in D1. */
export interface CompareAsset {
  id: string
  kind: CompareKind
  filename: string
  mime: string
  size: number
  encoding: string | null
  sha256: string | null
  created_at: number
}

export interface CompareProject {
  id: number
  name: string
  kind: CompareKind
  left_label: string | null
  right_label: string | null
  options: TextCompareOptions
  summary: CompareSummary
  left_asset: CompareAsset | null
  right_asset: CompareAsset | null
  share_slug: string | null
  created_at: number
  updated_at: number
  last_opened_at: number | null
}

/** What the project list draws: enough to name the two sides without reading their bytes. */
export interface CompareProjectListItem {
  id: number
  name: string
  kind: CompareKind
  left_label: string | null
  right_label: string | null
  summary: CompareSummary
  left_filename: string | null
  right_filename: string | null
  share_slug: string | null
  created_at: number
  updated_at: number
  last_opened_at: number | null
}

/** What a reopen needs to draw without re-reading both files' bytes first. */
export interface CompareSummary {
  added?: number
  removed?: number
  changed?: number
  changedBlocks?: number
  same?: number
  leftLines?: number
  rightLines?: number
  /** Directory comparisons: how many paths fell into each bucket. */
  dirCounts?: { same: number; different: number; leftOnly: number; rightOnly: number }
  /** Image comparisons: dimensions and the share of differing pixels. */
  image?: { width: number; height: number; differing: number; total: number }
  /** Binary comparisons: sizes and whether the hashes matched. */
  binary?: { same: boolean; leftSize: number; rightSize: number }
  /** Anything the user typed to describe the comparison; never generated copy. */
  note?: string
}

export interface CompareProjectInput {
  name: string
  kind: CompareKind
  left_label?: string | null
  right_label?: string | null
  options?: TextCompareOptions
  summary?: CompareSummary
  left_asset_id?: string | null
  right_asset_id?: string | null
}

export interface CompareRunInput {
  kind: CompareKind
  mode: string
  left_name?: string | null
  right_name?: string | null
  left_ext?: string | null
  right_ext?: string | null
  added_lines?: number
  removed_lines?: number
  changed_blocks?: number
  identical?: boolean
  left_bytes?: number
  right_bytes?: number
  duration_ms?: number
}

export const STATS_RANGES = ['7d', '30d'] as const
export type StatsRange = (typeof STATS_RANGES)[number]

export interface CompareTrendBucket {
  /** `YYYY-MM-DD`, in UTC, so a bucket means the same day to every reader. */
  day: string
  count: number
}

export interface CompareStats {
  range: StatsRange
  total: number
  identical: number
  byKind: Record<CompareKind, number>
  averageChangedLines: number
  topExtensions: Array<{ ext: string; count: number }>
  trend: CompareTrendBucket[]
}

/** What `GET /api/tools/compare/stats` answers before it is shaped into `CompareStats`. */
export interface CompareStatsRows {
  total: number
  identical: number
  byKind: Record<string, number>
  changedLinesTotal: number
  changedRuns: number
  extensions: Array<{ ext: string; count: number }>
  trend: Array<{ day: string; count: number }>
}

/** A directory comparison's manifest, hashed on the client and stored as one small JSON file. */
export interface DirEntry {
  path: string
  size: number
  sha256: string
}

export interface DirManifest {
  root: string
  entries: DirEntry[]
}

export type DirStatus = 'same' | 'different' | 'left_only' | 'right_only'

export interface DirCompareRow {
  path: string
  status: DirStatus
  left: DirEntry | null
  right: DirEntry | null
}

export interface DirTreeNode {
  name: string
  path: string
  depth: number
  status: DirStatus
  isFile: boolean
  children: DirTreeNode[]
  /** Files beneath this node in each bucket, for the count drawn beside a folder. */
  counts: { same: number; different: number; leftOnly: number; rightOnly: number }
}

export interface DirCompareResult {
  rows: DirCompareRow[]
  tree: DirTreeNode[]
  counts: { same: number; different: number; leftOnly: number; rightOnly: number }
}
