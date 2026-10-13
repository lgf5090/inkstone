/**
 * The note a book writes.
 *
 * Every book gets one Markdown note that holds its highlights. That is what makes the marks more than a
 * database row: the reader can link to them, edit them, search them, and keep them after the file that
 * produced them is gone.
 *
 * The generated passage lives between two markers, and everything outside them belongs to the reader.
 * Rewriting the whole body on every new highlight would erase whatever they had typed under it — which
 * is the failure this design exists to prevent.
 */
import { setFrontMatterValue } from '@shared/markdown-utils'
import { createContextualNote, useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { folderPathLabel } from '../../lib/folders'
import { formatPercent, type BookPosition } from './position'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/reader-settings'
import type { BookRecord, Highlight } from './types'

export const NOTE_BEGIN = '<!-- inkstone:reading:begin -->'
export const NOTE_END = '<!-- inkstone:reading:end -->'

/** The address that opens this book, optionally at one position. */
export function bookLink(bookId: string, position?: BookPosition | null): string {
  const path = `/reading/${encodeURIComponent(bookId)}`
  if (!position) return path
  return `${path}?p=${encodeURIComponent(position.kind === 'epub' ? `e:${position.chapter}:${position.offset}` : `f:${position.page}`)}`
}

function frontmatter(book: BookRecord, highlights: Highlight[], fraction: number): string {
  const lines = [
    '---',
    `book: ${JSON.stringify(book.title)}`,
    book.author ? `author: ${JSON.stringify(book.author)}` : null,
    book.language ? `book-language: ${JSON.stringify(book.language)}` : null,
    `format: ${JSON.stringify(book.format)}`,
    `reading-progress: ${formatPercent(fraction)}`,
    `highlights: ${highlights.length}`,
    'type: reading-note',
    '---',
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function escapeQuote(value: string): string {
  // A blockquote that contains a blank line becomes a blockquote and a paragraph, and the paragraph
  // loses the mark's meaning when the note is read back.
  return value.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').split('\n').join('\n> ')
}

export interface NoteOptions {
  backlinks: boolean
  /** Keep each mark's colour in the note. A data attribute, not a `style`: the note
   * renderer strips inline styles and keeps `data-*`, and the prose sheet paints the six colours. */
  colors: boolean
  chapterTitles?: Map<number, string>
}

/** The generated half of the note: the marks, in reading order, grouped by chapter. */
export function renderReadingSection(
  book: BookRecord,
  highlights: Highlight[],
  fraction: number,
  options: NoteOptions,
): string {
  const out: string[] = []
  out.push(`# ${book.title}`)
  out.push('')
  out.push(`> ${t('reading.note_summary_value0', { value0: highlights.length })} · ${formatPercent(fraction)}`)
  out.push('>')
  out.push(`> [${t('reading.note_open_book')}](${bookLink(book.id)})`)
  out.push('')
  if (!highlights.length) {
    out.push(t('reading.note_no_highlights'))
    out.push('')
    return out.join('\n')
  }
  const byChapter = new Map<number, Highlight[]>()
  for (const highlight of [...highlights].sort((a, b) => a.chapter - b.chapter || a.start - b.start)) {
    const list = byChapter.get(highlight.chapter) ?? []
    list.push(highlight)
    byChapter.set(highlight.chapter, list)
  }
  for (const [chapter, list] of byChapter) {
    const title = options.chapterTitles?.get(chapter)
    out.push(`## ${title || t('reading.chapter_value0', { value0: chapter + 1 })}`)
    out.push('')
    for (const highlight of list) {
      const link = options.backlinks ? ` [↩](${bookLink(book.id, { kind: 'epub', chapter: highlight.chapter, offset: highlight.start })})` : ''
      const quote = options.colors ? `<mark data-hl="${highlight.color}">${escapeQuote(highlight.quote)}</mark>` : escapeQuote(highlight.quote)
      out.push(`> ${quote}${link}`)
      const comment = highlight.comment.trim()
      if (comment) out.push(`>\n> ${escapeQuote(comment)}`)
      out.push('')
    }
  }
  return out.join('\n')
}

/**
 * Whether the note still declares a property of its own.
 *
 * A reader who deleted `highlights` from the front matter deleted it on purpose; refreshing the numbers
 * must not put it back. Only the leading block counts, so a word in the prose is never a property.
 */
function declaresProperty(content: string, key: string): boolean {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  return Boolean(block && new RegExp(`^\s*${key}\\s*:`, 'm').test(block[1]))
}

/**
 * Bring the note's own summary of the book up to date.
 *
 * The front matter is written once, when the note is made, and the body between the markers is rewritten
 * on every change — which left the two halves telling different stories: a bar reading 0% beside a note
 * that said the reader was 74% through. Only the properties the note already has are touched, and
 * `highlights` keeps its number type so the properties panel still sorts and colours it.
 */
export function refreshReadingProperties(content: string, highlights: number, fraction: number): string {
  let next = content
  if (declaresProperty(next, 'reading-progress')) next = setFrontMatterValue(next, 'reading-progress', formatPercent(fraction))
  if (declaresProperty(next, 'highlights')) next = setFrontMatterValue(next, 'highlights', highlights)
  return next
}

/** Splice the generated section into a body, keeping anything the reader wrote outside the markers. */
export function spliceNote(existing: string, section: string): string {
  const begin = existing.indexOf(NOTE_BEGIN)
  const end = existing.indexOf(NOTE_END)
  if (begin >= 0 && end > begin) {
    return `${existing.slice(0, begin)}${NOTE_BEGIN}\n\n${section}\n${existing.slice(end)}`
  }
  // A note the reader already had may carry a heading and their own passages; the marks go underneath.
  const head = existing.trim()
  if (!head) return `${NOTE_BEGIN}\n\n${section}\n${NOTE_END}`
  return `${head}\n\n${NOTE_BEGIN}\n\n${section}\n${NOTE_END}\n`
}

function noteTitle(book: BookRecord): string {
  return t('reading.note_title_value0', { value0: book.title }).slice(0, 200)
}

/**
 * Create the book's note or write its generated section into the one it already has.
 *
 * The write goes through the note store's remote transform rather than the in-memory copy, because a
 * reading note is often open on another device and a blind overwrite there would drop their own
 * paragraphs.
 */
export async function ensureReadingNote(
  book: BookRecord,
  highlights: Highlight[],
  existingNoteId: string | undefined,
): Promise<string | null> {
  const settings = useReaderSettings.getState()
  const notes = useNotes.getState()
  const fraction = useLibrary.getState().progress[book.id]?.fraction ?? 0
  const chapterTitles = new Map<number, string>()
  for (const entry of book.toc) {
    if (entry.position?.kind === 'epub' && !chapterTitles.has(entry.position.chapter)) {
      chapterTitles.set(entry.position.chapter, entry.label)
    }
  }
  const section = renderReadingSection(book, highlights, fraction, {
    backlinks: settings.quoteBacklinks,
    colors: settings.exportColors,
    chapterTitles,
  })

  const plan = planReadingNote({
    book,
    existingNoteId,
    notes: notes.notes as Record<string, { id: string; title: string; deletedAt?: number | null }>,
    byBook: useLibrary.getState().notes.byBook,
    baseTitle: noteTitle(book),
  })
  const title = plan.title
  if (plan.noteId) {
    const targetId = plan.noteId
    const result = await notes.editRemoteContent(targetId, (content) =>
      refreshReadingProperties(spliceNote(content, section), highlights.length, fraction))
    if (result === 'conflict') useUi.getState().toast({ title: t('reading.note_conflict'), tone: 'warning' })
    return targetId
  }
  const folderId = settings.notesFolder
    ? findFolderByPath(notes.folders ?? [], settings.notesFolder) || undefined
    : undefined
  const body = `${frontmatter(book, highlights, fraction)}\n\n${NOTE_BEGIN}\n\n${section}\n${NOTE_END}\n`
  return createContextualNote({ title, content: body, open: false, ...(folderId ? { folderId } : {}) })
}

export interface NotePlan {
  title: string
  /** The note to write into, or null when this book needs one of its own made. */
  noteId: string | null
}

/**
 * Which note this book owns, and what to call it if it has none.
 *
 * Two editions of the same novel carry the same title, and the note is named after the title, so the
 * title alone cannot decide ownership — measured on a real shelf: two books ended up linked to one note,
 * and opening the second rewrote the first one's marks away. So a note is only usable when no *other*
 * book claims it, the stored link included, and a book that finds nothing of its own gets a title that
 * says which book it belongs to.
 */
export function planReadingNote(input: {
  book: BookRecord
  existingNoteId: string | undefined
  notes: Record<string, { id: string; title: string; deletedAt?: number | null }>
  byBook: Record<string, string>
  baseTitle: string
}): NotePlan {
  const { book, existingNoteId, notes, byBook, baseTitle } = input
  const claimedByOther = (noteId: string | undefined | null): boolean => Boolean(noteId)
    && Object.entries(byBook).some(([otherBook, note]) => otherBook !== book.id && note === noteId)
  const live = (noteId: string | undefined | null) => (noteId ? notes[noteId] && !notes[noteId].deletedAt : false)

  if (live(existingNoteId) && !claimedByOther(existingNoteId)) return { title: notes[existingNoteId!].title, noteId: existingNoteId! }

  // A note the reader deleted out from under the book must not be resurrected by id: the title is the
  // only handle that survives, and a missing one means a fresh note.
  const free = Object.values(notes).find((one) => one.title === baseTitle && !one.deletedAt && !claimedByOther(one.id))
  if (free) return { title: free.title, noteId: free.id }

  const tail = book.id.slice(-4)
  const candidate = [baseTitle, `${baseTitle} (${book.format})`, `${baseTitle} (${tail})`]
    .find((one) => !Object.values(notes).some((existing) => !existing.deletedAt && existing.title === one))
  return { title: candidate ?? `${baseTitle} (${book.id})`, noteId: null }
}

/** The folder a reader named in settings, matched by its whole path so same-named folders can be told apart. */
function findFolderByPath(folders: Parameters<typeof folderPathLabel>[0], wanted: string): string | null {
  const needle = wanted.trim().replace(/^\/+|\/+$/g, '')
  if (!needle) return null
  const exact = folders.find((folder) => folderPathLabel(folders, folder.id, ' / ') === needle || folder.name === needle)
  return exact?.id ?? null
}
