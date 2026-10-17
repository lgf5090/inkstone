/**
 * What an answer would change in a note, read before it is written.
 *
 * The write-back is the one place the assistant edits something the reader owns, and a paragraph the
 * model rewrites badly is a paragraph lost until someone notices. So the change is shown first, as the
 * words leaving and the words arriving rather than as "everything changed": the unchanged text around a
 * change is kept for a few words either side and folded away beyond that, which is what keeps a diff of
 * a forty-thousand-character note readable instead of a wall of spans.
 *
 * `diff-match-patch` does the comparing. Its semantic cleanup is what makes the result read as words —
 * it moves an edit boundary out to the edge of the words it splits rather than leaving a letter here and
 * a letter there — and every changed run is then drawn as one `<del>` and one `<ins>`, so the count of
 * elements on screen follows the number of changes rather than the length of the note.
 *
 * The diff is a preview and nothing more: the text that lands in the note comes from the write-back, not
 * from these rows. A rough diff past the library's own timeout costs a blurrier preview, never a wrong
 * write.
 */
import DiffMatchPatch from 'diff-match-patch'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'

const differ = new DiffMatchPatch()
// A preview the reader is waiting on must not hold the dialog open while the bisect finishes a huge
// note: past this the library answers with a coarser diff and the dialog opens anyway.
differ.Diff_Timeout = 0.5

/** The library's two operation codes that mean something here; its `0` is the third, and that one is
 *  simply the text the change leaves alone. Named rather than read as -1 and 1 in the loop below. */
const OP_DELETE = -1
const OP_INSERT = 1

/** How many pieces of unchanged text — words and the spaces between them — are kept either side of a
 *  change before the middle of the run is folded away. */
const CONTEXT_EDGE = 16

/** How many rows one preview shows; past that the rest is named as a count instead of drawn. */
const MAX_ROWS = 48

/** A word, and one Chinese character for the same unit — a note without spaces would otherwise count a
 *  whole paragraph as a single word, and the number the reader acts on would say nothing. */
const WORD_PATTERN = /[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu

export type DiffMark = 'context' | 'removed' | 'added'

/** One whitespace-delimited piece of the note, and what the change does to it. */
export interface DiffWord {
  text: string
  mark: DiffMark
}

export type DiffRow =
  | { kind: 'context'; text: string }
  | { kind: 'change'; removed: string; added: string }
  | { kind: 'collapsed'; words: number }
  | { kind: 'truncated'; words: number }

export interface WriteDiff {
  /** What to draw, in document order. Long unchanged runs are already folded into a `collapsed` row. */
  rows: DiffRow[]
  /** Words the change takes out of the note, and puts in, counted over the whole diff. */
  removed: number
  added: number
  changed: boolean
}

/** How many words a piece of text carries, in the unit the summary counts: see {@link WORD_PATTERN}. */
export function countWords(text: string): number {
  return text.match(WORD_PATTERN)?.length ?? 0
}

/** What the library's operation code says about the text it carries. */
function markOf(op: number): DiffMark {
  if (op === OP_DELETE) return 'removed'
  if (op === OP_INSERT) return 'added'
  return 'context'
}

/**
 * The two texts compared word by word.
 *
 * Equal text stays one run; a deletion and the insertion next to it come back as one change, because
 * they are one thing to the reader — the words that were there and the words that would replace them.
 */
export function wordDiff(before: string, after: string): DiffWord[] {
  const diffs = differ.diff_main(before, after)
  differ.diff_cleanupSemantic(diffs)
  const words: DiffWord[] = []
  for (const [op, text] of diffs) {
    const mark = markOf(op)
    for (const piece of text.split(/(\s+)/)) {
      if (piece) words.push({ text: piece, mark })
    }
  }
  return words
}

/** The diff folded into the rows the preview draws. */
export function buildWriteDiff(before: string, after: string): WriteDiff {
  const rows: DiffRow[] = []
  let removed = 0
  let added = 0
  let context: string[] = []
  let taken: string[] = []
  let put: string[] = []
  const flushContext = () => {
    if (!context.length) return
    pushContext(rows, context)
    context = []
  }
  const flushChange = () => {
    if (!taken.length && !put.length) return
    const outText = taken.join('')
    const inText = put.join('')
    removed += countWords(outText)
    added += countWords(inText)
    rows.push({ kind: 'change', removed: outText, added: inText })
    taken = []
    put = []
  }
  for (const word of wordDiff(before, after)) {
    if (word.mark === 'context') {
      flushChange()
      context.push(word.text)
      continue
    }
    flushContext()
    if (word.mark === 'removed') taken.push(word.text)
    else put.push(word.text)
  }
  flushChange()
  flushContext()
  if (rows.length <= MAX_ROWS) return { rows, removed, added, changed: removed > 0 || added > 0 }
  // Past the ceiling the rest is counted, not drawn: a reader who cannot see the whole of a change
  // should be told how much they cannot see rather than handed a thousand rows to scroll.
  const shown = rows.slice(0, MAX_ROWS - 1)
  shown.push({ kind: 'truncated', words: rows.slice(MAX_ROWS - 1).reduce((total, row) => total + rowWords(row), 0) })
  return { rows: shown, removed, added, changed: removed > 0 || added > 0 }
}

/** Unchanged text, folded to its last few words either side of the change it stands between. */
function pushContext(rows: DiffRow[], words: string[]): void {
  if (words.length <= CONTEXT_EDGE * 2) {
    rows.push({ kind: 'context', text: words.join('') })
    return
  }
  const head = words.slice(0, CONTEXT_EDGE)
  const tail = words.slice(words.length - CONTEXT_EDGE)
  rows.push({ kind: 'context', text: head.join('') })
  rows.push({ kind: 'collapsed', words: countWords(words.slice(CONTEXT_EDGE, words.length - CONTEXT_EDGE).join('')) })
  rows.push({ kind: 'context', text: tail.join('') })
}

/** How many words one row carries, counting both sides of a change. */
function rowWords(row: DiffRow): number {
  if (row.kind === 'context') return countWords(row.text)
  if (row.kind === 'change') return countWords(row.removed) + countWords(row.added)
  return row.words
}

/** "3 words out, 7 words in" — the size of the change, said without opening anything. */
export function WriteDiffSummary({ diff, className }: { diff: WriteDiff; className?: string }) {
  return (
    <span className={cn('text-[length:var(--text-11)] text-[var(--text-quaternary)]', className)}>
      {diff.changed
        ? t('assistant.edit.diff_summary', { removed: diff.removed, added: diff.added })
        : t('assistant.edit.diff_none')}
    </span>
  )
}

/**
 * The change itself.
 *
 * Removed words are struck through in a `<del>` and added words underlined in an `<ins>`, each led by a
 * `-` or `+` glyph: the meaning is in the mark and the word, not only in the colour, and the elements are
 * the ones that say "this text was taken out" to anything reading the page. The box is focusable because
 * it scrolls, and a keyboard reader needs it to be reachable to get to the end of it.
 */
export function WriteDiffView({ diff }: { diff: WriteDiff }) {
  return (
    <div
      role="region"
      aria-label={t('assistant.edit.diff')}
      tabIndex={0}
      className="max-h-[40vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-11-5)] leading-relaxed"
    >
      {diff.rows.map((row, index) => <DiffRowView key={index} row={row} />)}
    </div>
  )
}

const BASE_ROW = 'whitespace-pre-wrap break-words rounded-[2px] px-1'

function DiffRowView({ row }: { row: DiffRow }) {
  if (row.kind === 'context') {
    return <p className={cn(BASE_ROW, 'text-[var(--text-tertiary)]')}>{row.text}</p>
  }
  if (row.kind === 'change') {
    return (
      <>
        {row.removed && (
          <p className={cn(BASE_ROW, 'bg-[var(--danger)]/10 text-[var(--danger)]')}>
            <span aria-hidden="true" className="select-none">- </span>
            <del>{row.removed}</del>
          </p>
        )}
        {row.added && (
          <p className={cn(BASE_ROW, 'bg-[var(--success)]/10 text-[var(--success)]')}>
            <span aria-hidden="true" className="select-none">+ </span>
            <ins>{row.added}</ins>
          </p>
        )}
      </>
    )
  }
  return (
    <p className={cn(BASE_ROW, 'text-[var(--text-quaternary)]')}>
      {row.kind === 'collapsed'
        ? t('assistant.edit.diff_collapsed', { count: row.words })
        : t('assistant.edit.diff_truncated', { count: row.words })}
    </p>
  )
}
